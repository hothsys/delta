import type { DeltaApi, FolderProgress, LogEntry, ReadResult } from '../../../shared/api';
import { confirmInPage, pick } from './dialogs';

/** Matches the server's TOKEN_HEADER. */
const TOKEN_HEADER = 'X-Delta-Token';
/** Log entries are sent in batches, at most this often. */
const LOG_FLUSH_MS = 1000;

/**
 * `DeltaApi` for the browser version: every call goes to Delta's local server, carrying the
 * token the server embedded in the page. Dialogs are the in-app ones; file-change
 * notifications arrive over Server-Sent Events.
 */
export function createHttpApi(): DeltaApi {
  const token = document.querySelector<HTMLMetaElement>('meta[name="delta-token"]')?.content ?? '';
  const client = crypto.randomUUID();

  async function post<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as T;
    if (!res.ok) throw new Error((data as { message?: string })?.message ?? `Request failed (${res.status})`);
    return data;
  }

  // One event stream per tab, opened on first use; watch requests wait until it is connected.
  const changeListeners = new Set<(path: string) => void>();
  const progressListeners = new Set<(progress: FolderProgress) => void>();
  let stream: Promise<void> | null = null;
  /** The paths last asked to be watched, re-sent when the stream reconnects. */
  let watched: string[] = [];
  let connected = false;
  const openStream = () =>
    (stream ??= new Promise<void>((resolve) => {
      const source = new EventSource(`/api/events?client=${client}&token=${token}`);
      source.addEventListener('open', () => {
        // The browser reconnects by itself (after sleep, say), and the server starts the new
        // stream with nothing watched; ask again.
        if (connected && watched.length) void post('/api/watch', { client, paths: watched }).catch(() => {});
        connected = true;
        resolve();
      });
      source.addEventListener('file-changed', (e) => {
        const path = JSON.parse((e as MessageEvent<string>).data) as string;
        for (const l of changeListeners) l(path);
      });
      source.addEventListener('folder-progress', (e) => {
        const progress = JSON.parse((e as MessageEvent<string>).data) as FolderProgress;
        for (const l of progressListeners) l(progress);
      });
    }));

  let unsaved = false;
  window.addEventListener('beforeunload', (e) => {
    // The browser shows its own "leave page?" prompt; the text can't be customised.
    if (unsaved) e.preventDefault();
  });

  const readFile = (path: string) => post<ReadResult>('/api/read', { path });

  // Log entries wait a moment and go together; whatever is left goes when the tab closes
  // (`keepalive` lets that request outlive the page).
  let logQueue: LogEntry[] = [];
  let logTimer: number | undefined;
  const flushLog = (closing = false) => {
    window.clearTimeout(logTimer);
    logTimer = undefined;
    if (!logQueue.length) return;
    const entries = logQueue;
    logQueue = [];
    void fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify({ entries }),
      keepalive: closing,
    }).catch(() => {}); // the server has stopped: nowhere to log to
  };
  window.addEventListener('pagehide', () => flushLog(true));

  const api: DeltaApi = {
    capabilities: { nativeDialogs: false, nativeMenu: false },
    openFileDialog: async (title) => {
      const path = await pick({ mode: 'file', title });
      return path ? readFile(path) : null;
    },
    readFile,
    saveFileDialog: (defaultName) => pick({ mode: 'save', title: 'Save as', defaultName }),
    saveFile: (request) => post('/api/save', request),
    watchFiles: async (paths) => {
      watched = paths;
      await openStream();
      await post('/api/watch', { client, paths });
    },
    onFileChanged: (listener) => {
      void openStream();
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    confirm: (options) => confirmInPage(options),
    setUnsavedChanges: (value) => {
      unsaved = value;
    },
    pathKind: (path) => post('/api/path-kind', { path }),
    // A page opened at /?launch=<id> shows that comparison (and reloading keeps it).
    launchRequest: () => post('/api/launch-request', { id: new URLSearchParams(location.search).get('launch') }),
    // No native menu here: the in-page menu bar and shortcuts (MenuBar, App) run commands directly.
    onCommand: () => () => {},
    openFolderDialog: (title) => pick({ mode: 'folder', title }),
    compareFolders: async (left, right, mode) => {
      // Progress arrives over the event stream, so make sure it is connected first.
      await openStream();
      return post('/api/compare-folders', { left, right, mode, client });
    },
    onFolderProgress: (listener) => {
      void openStream();
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    cancelFolderCompare: async () => {
      await post('/api/compare-folders/cancel', { client });
    },
    copyEntry: (request) => post('/api/copy', request),
    recentComparisons: () => post('/api/recents/list'),
    rememberComparison: async (kind, left, right) => {
      await post('/api/recents/remember', { kind, left, right });
    },
    forgetComparison: async (kind, left, right) => {
      await post('/api/recents/forget', { kind, left, right });
    },
    listDirectory: (path, showHidden) => post('/api/list-directory', { path, showHidden }),
    locations: () => post('/api/locations'),
    joinPath: (root, relPath) => joinPath(root, relPath),
    // The in-page menu reads its check marks from the interface directly.
    setMenuChecked: () => {},
    log: (entry) => {
      logQueue.push(entry);
      logTimer ??= window.setTimeout(flushLog, LOG_FLUSH_MS);
    },
    logInfo: () => post('/api/log/info'),
    setDebugLogging: (on) => post('/api/log/set-debug', { on }),
    openLogsFolder: async () => {
      const r = await post<{ ok: boolean; message?: string }>('/api/log/open-folder');
      if (!r.ok) throw new Error(r.message);
    },
    diagnostics: () => post('/api/log/diagnostics'),
  };
  return api;
}

/** Joins with the server's separator, inferred from the root (Windows paths use backslashes). */
export function joinPath(root: string, relPath: string): string {
  if (!relPath) return root;
  const sep = /^[A-Za-z]:\\|^\\\\/.test(root) ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + relPath.split('/').join(sep);
}
