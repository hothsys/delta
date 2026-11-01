import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, type WebContents } from 'electron';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ComparisonKind, ConfirmOptions, CopyRequest, FolderCompareMode, SaveRequest } from '../shared/api';
import { readTextFile, writeTextFile } from '../node/files';
import { compareFolders, copyEntry } from '../node/folders';
import { listDirectory, locations } from '../node/browse';
import { buildMenu } from './menu';
import { RecentStore } from '../node/recents';
import { launchRequest } from '../node/launch';
import { noteOwnWrite, setWatched, type ChangeSubscriber } from '../node/watch';

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

  win.once('ready-to-show', () => win.show());
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
    if (choice !== 0) e.preventDefault();
  });
  win.on('closed', () => unsaved.delete(id));

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

function registerIpc(): void {
  const recents = new RecentStore(join(app.getPath('userData'), 'recent-comparisons.json'));
  ipcMain.handle('recents:list', async () => ({ items: await recents.list(), homeDir: homedir() }));
  ipcMain.handle('recents:remember', (_e, kind: ComparisonKind, left: string, right: string) => recents.remember(kind, left, right));
  ipcMain.handle('recents:forget', (_e, kind: ComparisonKind, left: string, right: string) => recents.forget(kind, left, right));

  const windowOf = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)!;

  ipcMain.handle('file:open-dialog', async (e, title: string) => {
    const r = await dialog.showOpenDialog(windowOf(e), { title, properties: ['openFile'] });
    return r.canceled || r.filePaths.length === 0 ? null : readTextFile(r.filePaths[0]);
  });
  ipcMain.handle('file:read', (_e, path: string) => readTextFile(path));
  ipcMain.handle('file:save-dialog', async (e, defaultName: string) => {
    const r = await dialog.showSaveDialog(windowOf(e), { defaultPath: defaultName });
    return r.canceled || !r.filePath ? null : r.filePath;
  });
  ipcMain.handle('file:save', async (_e, req: SaveRequest) => {
    const result = await writeTextFile(req);
    if (result.ok) noteOwnWrite(result.path, result.mtimeMs);
    return result;
  });
  ipcMain.handle('file:watch', (e, paths: string[]) => setWatched(subscriberFor(e.sender), paths));
  ipcMain.handle('dialog:confirm', async (e, o: ConfirmOptions) => {
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
  // In development Electron is started as `electron <app dir> …args`, so skip one more.
  ipcMain.handle('app:launch-request', () => launchRequest(process.argv.slice(app.isPackaged ? 1 : 2)));
  ipcMain.handle('app:path-kind', async (_e, path: string) => {
    try {
      return (await stat(path)).isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  });
  ipcMain.handle('folder:open-dialog', async (e, title: string) => {
    const r = await dialog.showOpenDialog(windowOf(e), { title, properties: ['openDirectory'] });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  // One folder comparison per window: starting another (or Cancel) aborts the one running.
  const running = new Map<number, AbortController>();
  ipcMain.handle('folder:compare', async (e, left: string, right: string, mode: FolderCompareMode) => {
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
  ipcMain.handle('folder:cancel', (e) => running.get(e.sender.id)?.abort());
  ipcMain.handle('folder:copy', (_e, req: CopyRequest) => copyEntry(req));
  ipcMain.handle('browse:list', (_e, path: string, showHidden: boolean) => listDirectory(path, showHidden));
  ipcMain.handle('browse:locations', () => locations());
  ipcMain.on('app:unsaved-changes', (e, value: boolean) => {
    if (value) unsaved.add(e.sender.id);
    else unsaved.delete(e.sender.id);
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
