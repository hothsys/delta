import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Command, DeltaApi, FolderProgress } from '../shared/api';

/** Subscribes to a main-process event and returns an unsubscribe function. */
function on<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const sep = process.platform === 'win32' ? '\\' : '/';

const api: DeltaApi = {
  capabilities: { nativeDialogs: true, nativeMenu: true },
  openFileDialog: (title) => ipcRenderer.invoke('file:open-dialog', title),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  saveFileDialog: (defaultName) => ipcRenderer.invoke('file:save-dialog', defaultName),
  saveFile: (request) => ipcRenderer.invoke('file:save', request),
  watchFiles: (paths) => ipcRenderer.invoke('file:watch', paths),
  onFileChanged: (listener) => on<string>('file:changed', listener),
  confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
  setUnsavedChanges: (unsaved) => ipcRenderer.send('app:unsaved-changes', unsaved),
  pathKind: (path) => ipcRenderer.invoke('app:path-kind', path),
  launchRequest: () => ipcRenderer.invoke('app:launch-request'),
  onCommand: (listener) => on<Command>('menu:command', listener),
  openFolderDialog: (title) => ipcRenderer.invoke('folder:open-dialog', title),
  compareFolders: (left, right, mode) => ipcRenderer.invoke('folder:compare', left, right, mode),
  onFolderProgress: (listener) => on<FolderProgress>('folder:progress', listener),
  cancelFolderCompare: () => ipcRenderer.invoke('folder:cancel'),
  copyEntry: (request) => ipcRenderer.invoke('folder:copy', request),
  recentComparisons: () => ipcRenderer.invoke('recents:list'),
  rememberComparison: (kind, left, right) => ipcRenderer.invoke('recents:remember', kind, left, right),
  forgetComparison: (kind, left, right) => ipcRenderer.invoke('recents:forget', kind, left, right),
  listDirectory: (path, showHidden) => ipcRenderer.invoke('browse:list', path, showHidden),
  locations: () => ipcRenderer.invoke('browse:locations'),
  joinPath: (root, relPath) => (relPath ? root.replace(/[\\/]+$/, '') + sep + relPath.split('/').join(sep) : root),
};

contextBridge.exposeInMainWorld('delta', api);
