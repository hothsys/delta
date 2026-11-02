/**
 * The contract between the main process (file system, dialogs, menus) and the renderer.
 * The preload script exposes `DeltaApi` as `window.delta`; nothing else crosses the boundary.
 */

/** How a file's bytes were decoded, so saving can write them back the same way. */
export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'latin1';

export type LineEnding = '\n' | '\r\n' | '\r';

export interface LoadedFile {
  path: string;
  /** File name without directories. */
  name: string;
  text: string;
  encoding: TextEncoding;
  /** The most common line ending, used when saving. `\n` for files without line breaks. */
  eol: LineEnding;
  size: number;
  mtimeMs: number;
}

export type ReadResult =
  | { ok: true; file: LoadedFile }
  | { ok: false; path: string; reason: 'binary' | 'error'; message: string };

export interface SaveRequest {
  path: string;
  text: string;
  encoding: TextEncoding;
}

export type SaveResult =
  | { ok: true; path: string; name: string; mtimeMs: number; size: number; encoding: TextEncoding }
  | { ok: false; message: string };

export interface ConfirmOptions {
  message: string;
  detail?: string;
  confirmLabel: string;
}

/** What the app was asked to compare on launch (`delta a.txt b.txt` or `delta dirA dirB`). */
export type LaunchRequest =
  | { kind: 'none' }
  | { kind: 'files'; left?: string; right?: string }
  | { kind: 'folders'; left: string; right: string };

/** Menu and shortcut commands sent from the main process to the renderer. */
export type Command =
  | 'compare-files'
  | 'save'
  | 'save-as'
  | 'save-left'
  | 'save-right'
  | 'refresh'
  | 'undo'
  | 'redo'
  | 'select-all'
  | 'compare-folders'
  | 'toggle-theme'
  | 'next-difference'
  | 'previous-difference'
  | 'toggle-debug-logging'
  | 'open-logs-folder'
  | 'copy-diagnostics';

// ---- Logging ---------------------------------------------------------------------------

/** Most to least severe; a log level writes its own entries and everything above it. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Extra details on a log entry: paths, sizes, counts, timings. Never file contents. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** An entry written by the interface. */
export interface LogEntry {
  level: LogLevel;
  /** What part of Delta it's about: `files`, `folders`, `merge`… */
  area: string;
  message: string;
  fields?: LogFields;
  /** For errors. */
  stack?: string;
}

/** Where the log level came from, strongest first. */
export type LogLevelSource = 'command line' | 'DELTA_LOG_LEVEL' | 'setting' | 'default';

export interface LogInfo {
  level: LogLevel;
  from: LogLevelSource;
  /** The log file, or null if it couldn't be opened. */
  file: string | null;
}

// ---- Folder comparison ----------------------------------------------------------------

export type EntryKind = 'file' | 'dir';

export interface EntryInfo {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  /**
   * Files only: the content is binary, so it can be copied but not compared as text. Only
   * determined when comparing by contents (the fast modes never open files).
   */
  binary?: boolean;
}

/**
 * - `same` / `different`: present on both sides (for folders: whether anything inside differs).
 * - `left-only` / `right-only`: present on one side.
 * - `kind-mismatch`: a file on one side and a folder on the other.
 */
export type EntryStatus = 'same' | 'different' | 'left-only' | 'right-only' | 'kind-mismatch';

export interface FolderNode {
  name: string;
  /** Path relative to the compared roots, using `/`. Empty for the roots themselves. */
  relPath: string;
  left?: EntryInfo;
  right?: EntryInfo;
  status: EntryStatus;
  /** Present for folders that exist on at least one side. */
  children?: FolderNode[];
  /** Why this entry couldn't be compared (a folder or file that can't be read); never "same". */
  error?: string;
}

/**
 * How files present on both sides are judged equal in a folder comparison:
 * - `contents`: sizes, then every byte (exact; reads the files).
 * - `size-date`: same size and modified time (fast; never opens files).
 * - `date`: same modified time only (fastest).
 */
export type FolderCompareMode = 'contents' | 'size-date' | 'date';

/**
 * Modified times this close count as equal. FAT/exFAT drives store times to 2 seconds, so a
 * file copied to a USB drive and back can come back up to 2 seconds off.
 */
export const TIMESTAMP_TOLERANCE_MS = 2000;

export type FolderCompareResult =
  | { ok: true; root: FolderNode; leftRoot: string; rightRoot: string; elapsedMs: number }
  | { ok: false; message: string; cancelled?: boolean };

/** Live counters while a folder comparison runs. */
export interface FolderProgress {
  /** Files and folders listed so far, on both sides. */
  entries: number;
  /** File pairs whose contents (or metadata) have been compared. */
  filesCompared: number;
  /** Bytes read to compare contents. */
  bytesRead: number;
  /** The folder being scanned, relative to the roots. */
  current: string;
  elapsedMs: number;
}

export interface CopyRequest {
  leftRoot: string;
  rightRoot: string;
  relPath: string;
  /** Copy direction: from the left tree into the right one, or the reverse. */
  from: 'left' | 'right';
}

export type CopyResult = { ok: true } | { ok: false; message: string };

// ---- Recent comparisons ----------------------------------------------------------------

export type ComparisonKind = 'files' | 'folders';

/**
 * - `available`: the path exists (and is the right kind: a file or a folder).
 * - `unmounted`: the path is on an external drive or network share that is not connected.
 * - `missing`: the path no longer exists (moved or deleted).
 */
export type PathState = 'available' | 'missing' | 'unmounted';

export interface RecentSide {
  path: string;
  state: PathState;
  /** Name of the external drive or share the path is on, if any (e.g. "Backup", "D:"). */
  volume?: string;
}

export interface RecentComparison {
  kind: ComparisonKind;
  left: RecentSide;
  right: RecentSide;
  /** When it was last opened (ms since the epoch). */
  at: number;
}

export interface RecentList {
  items: RecentComparison[];
  /** The user's home folder, so paths can be shown as ~/… */
  homeDir: string;
}

// ---- Browsing (the browser version's in-app file picker) --------------------------------

export interface DirEntry {
  name: string;
  /** Absolute path. */
  path: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  /** Starts with a dot (hidden by convention on macOS and Linux). */
  hidden: boolean;
}

export type DirectoryListing =
  | { ok: true; path: string; parent: string | null; entries: DirEntry[] }
  | { ok: false; path: string; message: string };

export interface Location {
  name: string;
  path: string;
  /** `home`: the home folder; `root`: the filesystem root or system drive; `volume`: another drive or share. */
  kind: 'home' | 'root' | 'volume';
}

/**
 * What the host can do, so the interface adapts instead of branching on "desktop or web".
 * - `nativeDialogs`: file and folder pickers and confirmations are the operating system's.
 * - `nativeMenu`: there is an application menu sending `Command`s.
 */
export interface Capabilities {
  nativeDialogs: boolean;
  nativeMenu: boolean;
}

export interface DeltaApi {
  capabilities: Capabilities;
  /** Shows an open dialog and reads the chosen file. `null` if cancelled. */
  openFileDialog(title: string): Promise<ReadResult | null>;
  readFile(path: string): Promise<ReadResult>;
  /** Shows a save dialog. Returns the chosen path or `null`. */
  saveFileDialog(defaultName: string): Promise<string | null>;
  saveFile(request: SaveRequest): Promise<SaveResult>;
  /** The paths to watch for outside changes; replaces the previous set. */
  watchFiles(paths: string[]): Promise<void>;
  onFileChanged(listener: (path: string) => void): () => void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Lets the main process warn before closing a window with unsaved edits. */
  setUnsavedChanges(unsaved: boolean): void;
  /** Whether a path is a file, a folder, or missing. */
  pathKind(path: string): Promise<EntryKind | null>;
  launchRequest(): Promise<LaunchRequest>;
  onCommand(listener: (command: Command) => void): () => void;
  openFolderDialog(title: string): Promise<string | null>;
  /** Starting a comparison cancels any still running in this window or tab. */
  compareFolders(left: string, right: string, mode: FolderCompareMode): Promise<FolderCompareResult>;
  onFolderProgress(listener: (progress: FolderProgress) => void): () => void;
  /** Stops the running comparison; its promise resolves with `cancelled: true`. */
  cancelFolderCompare(): Promise<void>;
  copyEntry(request: CopyRequest): Promise<CopyResult>;
  /** The most recent comparisons, newest first, with each path's current availability. */
  recentComparisons(): Promise<RecentList>;
  /** Records a comparison as just used (moving it to the top if it was already listed). */
  rememberComparison(kind: ComparisonKind, left: string, right: string): Promise<void>;
  forgetComparison(kind: ComparisonKind, left: string, right: string): Promise<void>;
  /** A folder's entries, for the in-app file browser. */
  listDirectory(path: string, showHidden: boolean): Promise<DirectoryListing>;
  /** Starting points for browsing: home, the root, mounted drives. */
  locations(): Promise<Location[]>;
  /** Joins a root and a relative path from a `FolderNode` using the platform separator. */
  joinPath(root: string, relPath: string): string;
  /** Adds an entry to the log (sent in the background; never fails). */
  log(entry: LogEntry): void;
  logInfo(): Promise<LogInfo>;
  /** Turns debug logging on or off, now and on later starts. */
  setDebugLogging(on: boolean): Promise<LogInfo>;
  /** Shows the logs folder in Finder, Explorer or the file manager. */
  openLogsFolder(): Promise<void>;
  /** Versions, settings and the latest log lines, for a bug report. */
  diagnostics(): Promise<string>;
}
