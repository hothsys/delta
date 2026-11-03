import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, type WebContents } from 'electron';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command, ComparisonKind, ConfirmOptions, CopyRequest, FolderCompareMode, SaveRequest } from '../shared/api';
import { readTextFile, writeTextFile } from '../node/files';
import { compareFolders, copyEntry } from '../node/folders';
import { listDirectory, locations } from '../node/browse';
import { installMenu } from './menu';
import { RecentStore } from '../node/recents';
import { launchRequest } from '../node/launch';
import { log, logLevel, takeLogLevel, writeFromInterface } from '../node/log';
import { diagnostics, logInfo, logsFolder, setDebugLogging, startLogging } from '../node/logging';
import { noteOwnWrite, setWatched, type ChangeSubscriber } from '../node/watch';

// In development Electron is started as `electron <app dir> …args`, so skip one more.
const args = takeLogLevel(process.argv.slice(app.isPackaged ? 1 : 2));

// Logged without changing what happens next (Electron's own error dialog, for one).
process.on('uncaughtExceptionMonitor', (err, origin) => log.error('app', `Uncaught ${origin === 'unhandledRejection' ? 'rejection' : 'exception'}`, err));
process.on('unhandledRejection', (reason) => log.error('app', 'Unhandled rejection', reason instanceof Error ? reason : { reason: String(reason) }));

/** Checkbox menu items the interface has turned on (View > Prettify). */
const menuChecks = new Map<Command, boolean>();

/** Windows with edits that have not been saved, so closing them asks first. */
const unsaved = new Set<number>();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 400,
    title: 'Delta',
    // Shown on ready-to-show, so the window never flashes blank while the UI loads.
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f2f1ec',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  log.info('app', 'Window opened', { id: win.webContents.id });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('render-process-gone', (_e, d) => log.error('app', 'The window\'s page stopped', { reason: d.reason, exitCode: d.exitCode }));
  win.on('unresponsive', () => log.warn('app', 'The window stopped responding'));
  win.on('responsive', () => log.info('app', 'The window is responding again'));
  // The window only ever shows Delta. Never navigate it elsewhere (a link, or a file dropped
  // past the page's guard), which would replace the app and lose unsaved edits.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Nor open other windows or embedded pages: they would inherit the bridge to the file system.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  const id = win.webContents.id;
  win.on('close', (e) => {
    if (!unsaved.has(id)) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard Changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close the window and discard them?',
    });
    log.info('app', choice === 0 ? 'Closing the window, discarding unsaved changes' : 'Kept the window open (unsaved changes)');
    if (choice !== 0) e.preventDefault();
  });
  win.on('closed', () => {
    unsaved.delete(id);
    log.info('app', 'Window closed', { id });
  });

  // electron-vite sets this while running `npm run dev` so the renderer is served with hot reload.
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

/** One stable change subscriber per window, so file watching can be shared with the web server. */
const subscribers = new WeakMap<WebContents, ChangeSubscriber>();
function subscriberFor(wc: WebContents): ChangeSubscriber {
  let s = subscribers.get(wc);
  if (!s) {
    s = {
      send: (path) => wc.send('file:changed', path),
      closed: () => wc.isDestroyed(),
      onClose: (listener) => wc.once('destroyed', listener),
    };
    subscribers.set(wc, s);
  }
  return s;
}

/**
 * `ipcMain.handle`, timing each call in the debug log and logging failures (which the
 * renderer sees as a rejected promise).
 */
function handle<A extends unknown[]>(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: A) => unknown): void {
  ipcMain.handle(channel, async (e, ...a: unknown[]) => {
    const t0 = performance.now();
    try {
      const result = await fn(e, ...(a as A));
      if (!channel.startsWith('log:')) log.debug('ipc', channel, { ms: Math.round(performance.now() - t0) });
      return result;
    } catch (err) {
      log.error('ipc', `${channel} failed`, err as Error);
      throw err;
    }
  });
}

function registerIpc(dataDir: string): void {
  const recents = new RecentStore(join(dataDir, 'recent-comparisons.json'));
  handle('recents:list', async () => ({ items: await recents.list(), homeDir: homedir() }));
  handle('recents:remember', (_e, kind: ComparisonKind, left: string, right: string) => recents.remember(kind, left, right));
  handle('recents:forget', (_e, kind: ComparisonKind, left: string, right: string) => recents.forget(kind, left, right));

  const windowOf = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)!;

  handle('file:open-dialog', async (e, title: string) => {
    const r = await dialog.showOpenDialog(windowOf(e), { title, properties: ['openFile'] });
    return r.canceled || r.filePaths.length === 0 ? null : readTextFile(r.filePaths[0]);
  });
  handle('file:read', (_e, path: string) => readTextFile(path));
  handle('file:save-dialog', async (e, defaultName: string) => {
    const r = await dialog.showSaveDialog(windowOf(e), { defaultPath: defaultName });
    return r.canceled || !r.filePath ? null : r.filePath;
  });
  handle('file:save', async (_e, req: SaveRequest) => {
    const result = await writeTextFile(req);
    if (result.ok) noteOwnWrite(result.path, result.mtimeMs);
    return result;
  });
  handle('file:watch', (e, paths: string[]) => setWatched(subscriberFor(e.sender), paths));
  handle('dialog:confirm', async (e, o: ConfirmOptions) => {
    const r = await dialog.showMessageBox(windowOf(e), {
      type: 'question',
      buttons: [o.confirmLabel, 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: o.message,
      detail: o.detail,
    });
    return r.response === 0;
  });
  handle('app:launch-request', () => launchRequest(args.rest));
  handle('app:path-kind', async (_e, path: string) => {
    try {
      return (await stat(path)).isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  });
  handle('folder:open-dialog', async (e, title: string) => {
    const r = await dialog.showOpenDialog(windowOf(e), { title, properties: ['openDirectory'] });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  // One folder comparison per window: starting another (or Cancel) aborts the one running.
  const running = new Map<number, AbortController>();
  handle('folder:compare', async (e, left: string, right: string, mode: FolderCompareMode) => {
    running.get(e.sender.id)?.abort();
    const controller = new AbortController();
    running.set(e.sender.id, controller);
    try {
      return await compareFolders(left, right, mode, {
        signal: controller.signal,
        onProgress: (p) => !e.sender.isDestroyed() && e.sender.send('folder:progress', p),
      });
    } finally {
      if (running.get(e.sender.id) === controller) running.delete(e.sender.id);
    }
  });
  handle('folder:cancel', (e) => running.get(e.sender.id)?.abort());
  handle('folder:copy', (_e, req: CopyRequest) => copyEntry(req));
  handle('browse:list', (_e, path: string, showHidden: boolean) => listDirectory(path, showHidden));
  handle('browse:locations', () => locations());
  ipcMain.on('app:unsaved-changes', (e, value: boolean) => {
    if (value) unsaved.add(e.sender.id);
    else unsaved.delete(e.sender.id);
  });

  ipcMain.on('menu:set-checked', (_e, command: Command, checked: boolean) => {
    menuChecks.set(command, checked === true);
    installMenu();
  });
  ipcMain.on('log:write', (_e, entry: unknown) => writeFromInterface(entry));
  handle('log:info', () => logInfo());
  handle('log:set-debug', async (_e, on: boolean) => {
    const info = await setDebugLogging(dataDir, on === true);
    installMenu();
    return info;
  });
  handle('log:open-folder', async () => {
    const folder = logsFolder();
    const failed = folder ? await shell.openPath(folder) : 'There is no log.';
    if (failed) throw new Error(failed);
  });
  handle('log:diagnostics', () => diagnostics(`desktop${app.isPackaged ? '' : ', development'}`, app.getVersion(), dataDir));
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  const { level, from, file } = startLogging({ dir: app.getPath('logs'), name: 'desktop.log', dataDir, cli: args.level });
  log.info('app', 'Delta started', {
    version: app.getVersion(),
    electron: process.versions.electron,
    system: `${process.platform} ${process.arch}`,
    packaged: app.isPackaged,
    level,
    levelFrom: from,
    log: file,
  });
  if (args.level !== undefined && level !== args.level) log.warn('app', 'Unknown log level; use error, warn, info or debug', { given: args.level });
  installMenu((command) => (command === 'toggle-debug-logging' ? logLevel() === 'debug' : menuChecks.get(command) === true));
  registerIpc(dataDir);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => log.info('app', 'Delta quit'));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
