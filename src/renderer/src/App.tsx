import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { joinLines, type WhitespaceMode } from '../../engine';
import type {
  Command,
  ComparisonKind,
  FolderCompareMode,
  FolderCompareResult,
  FolderNode,
  FolderProgress,
  LoadedFile,
  LogInfo,
  ReadResult,
  RecentComparison,
  RecentList,
} from '../../shared/api';
import { commandForKey } from '../../shared/menu';
import { ContextMenu, type MenuItem } from './components/ContextMenu';
import { DiffView, type DiffViewHandle } from './components/DiffView';
import { FolderView, type TreeSide } from './components/FolderView';
import { MenuBar } from './components/MenuBar';
import { Notice, type NoticeState } from './components/Notice';
import { StartScreen } from './components/StartScreen';
import { Toolbar, type Theme } from './components/Toolbar';
import { log, setLogLevel } from './log';
import type { Side } from './model/rowModel';
import { api } from './platform';
import { newSourceId, useComparison, type Source } from './useComparison';

const THEME_KEY = 'delta.theme';
const SCAN_CANCELLED = 'The folder comparison was cancelled.';
const isMac = navigator.platform.toUpperCase().includes('MAC');
const FOLDER_MODE_KEY = 'delta.folderCompareBy';

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const emptySource = (side: Side): Source => ({ id: newSourceId(), label: side === 'a' ? 'Left' : 'Right', text: '' });

const fromFile = (f: LoadedFile): Source => ({
  id: newSourceId(),
  label: f.name,
  text: f.text,
  file: { path: f.path, encoding: f.encoding, eol: f.eol, mtimeMs: f.mtimeMs },
});

const sideName = (side: Side) => (side === 'a' ? 'left' : 'right');

/** How often the start screen re-checks whether recent paths (and their drives) are available. */
const RECENTS_REFRESH_MS = 3000;

/** What the window shows: the choice of comparison, two files, or two folders. */
type Mode = 'start' | 'files' | 'folders';

export function App() {
  const [mode, setMode] = useState<Mode>('start');
  const [sources, setSources] = useState<Record<Side, Source>>(() => ({ a: emptySource('a'), b: emptySource('b') }));
  const [whitespace, setWhitespace] = useState<WhitespaceMode>('exact');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const view = useRef<DiffViewHandle>(null);
  /** The comparison left open when going Home, so the start screen can offer to resume it. */
  const [resumeMode, setResumeMode] = useState<'files' | 'folders' | null>(null);
  const [recents, setRecents] = useState<RecentList>({ items: [], homeDir: '' });
  const [logInfo, setLogInfo] = useState<LogInfo | null>(null);

  // Folder comparison. File comparisons opened from it can return to it.
  const [roots, setRoots] = useState<{ left: string; right: string } | null>(null);
  const [folderResult, setFolderResult] = useState<FolderCompareResult | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderRefreshing, setFolderRefreshing] = useState(false);
  /** Set when a file is saved after opening it from the folder comparison, whose result may now be out of date. */
  const folderStale = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hideSame, setHideSame] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [folderMode, setFolderMode] = useState<FolderCompareMode>(() => {
    const saved = localStorage.getItem(FOLDER_MODE_KEY);
    return saved === 'size-date' || saved === 'date' ? saved : 'contents';
  });
  /** A file chosen with "Select for comparison", waiting for the file to compare it with. */
  const [picked, setPicked] = useState<{ side: TreeSide; relPath: string; path: string; name: string } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // A layout effect, so the theme is applied before child effects repaint canvases from its colours.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  /**
   * Switches light and dark with a short crossfade: the browser snapshots the page before and
   * after (canvases included) and fades between them on the GPU, rather than animating the
   * colours of every element. Instant where unsupported, or when the system asks for reduced motion.
   */
  const changeTheme = (next: Theme) => {
    if (next === (pendingTheme.current ?? theme)) return;
    log.info('view', 'Theme changed', { theme: next });
    if (!('startViewTransition' in document) || matchMedia('(prefers-reduced-motion: reduce)').matches) return setTheme(next);
    // The transition applies the change a moment later; until then a second toggle must start
    // from this theme, not the one still on screen.
    pendingTheme.current = next;
    // The new theme must be on screen when the callback returns, so React renders synchronously.
    const transition = document.startViewTransition(() => flushSync(() => setTheme(next)));
    // The browser skips the animation (not the change) if, say, the window is hidden.
    transition.ready.catch(() => {});
    void transition.finished.finally(() => {
      if (pendingTheme.current === next) pendingTheme.current = null;
    });
  };
  const pendingTheme = useRef<Theme | null>(null);
  const toggleTheme = () => changeTheme((pendingTheme.current ?? theme) === 'dark' ? 'light' : 'dark');

  const options = useMemo(() => ({ whitespace, ignoreCase }), [whitespace, ignoreCase]);
  const cmp = useComparison(sources.a, sources.b, options);
  const edited = cmp.isEdited;

  // Let the main process warn before the window closes with unsaved edits.
  const anyEdited = edited('a') || edited('b');
  useEffect(() => api.setUnsavedChanges(anyEdited), [anyEdited]);

  const title =
    mode === 'files'
      ? `${sources.a.label} ↔ ${sources.b.label} · Delta`
      : mode === 'folders' && roots
        ? `${baseName(roots.left)} ↔ ${baseName(roots.right)} · Delta`
        : 'Delta';
  useEffect(() => {
    document.title = title;
  }, [title]);

  const confirmDiscard = async (sides: Side[]) => {
    const dirty = sides.filter(edited);
    if (dirty.length === 0) return true;
    const ok = await api.confirm({
      message: `Discard your changes to ${dirty.map((s) => sources[s].label).join(' and ')}?`,
      detail: 'Your edits have not been saved.',
      confirmLabel: 'Discard Changes',
    });
    log.info('edit', ok ? 'Discarded unsaved changes' : 'Kept unsaved changes', { sides: dirty.map(sideName).join(',') });
    return ok;
  };

  /**
   * Before the file comparison is left for something else: asks about unsaved edits and, if
   * the user agrees, discards them by re-reading those sides from disk. False if cancelled.
   */
  const leaveFiles = async (): Promise<boolean> => {
    const dirty = (['a', 'b'] as const).filter(edited);
    if (dirty.length === 0) return true;
    if (!(await confirmDiscard([...dirty]))) return false;
    const fresh = await Promise.all(
      dirty.map(async (s) => {
        const f = sources[s].file;
        const r = f && (await api.readFile(f.path));
        return r && r.ok ? fromFile(r.file) : { ...sources[s], id: newSourceId() };
      }),
    );
    setSources((cur) => {
      const next = { ...cur };
      dirty.forEach((s, i) => (next[s] = fresh[i]));
      return next;
    });
    return true;
  };

  /** Shows an error notice for a failed read; returns the file when it worked. */
  const fileOrNotice = (r: ReadResult): LoadedFile | null => {
    if (r.ok) return r.file;
    setNotice({ kind: 'error', text: r.message });
    return null;
  };

  const remember = (kind: ComparisonKind, left: string, right: string) =>
    void api.rememberComparison(kind, left, right);

  /** Shows two files side by side. `fromFolders` keeps the way back to the folder comparison. */
  const showFiles = async (a: Source, b: Source, fromFolders = false) => {
    if (!(await confirmDiscard(['a', 'b']))) return;
    if (!fromFolders) {
      // A folder comparison still scanning is no longer wanted.
      if (folderBusy || folderRefreshing) {
        scanId.current++;
        void api.cancelFolderCompare();
      }
      setRoots(null);
      // Files opened from inside a folder comparison are not listed separately.
      if (a.file && b.file) remember('files', a.file.path, b.file.path);
    }
    log.info('files', 'Comparing files', {
      left: a.file?.path ?? a.missingPath,
      right: b.file?.path ?? b.missingPath,
      fromFolders: fromFolders || undefined,
    });
    setResumeMode(null);
    setNotice(null);
    setSources({ a, b });
    setMode('files');
  };

  /** Asks for a left and then a right file. Cancelling either leaves things as they were. */
  const compareFiles = async (preset?: LoadedFile) => {
    const leftResult = preset ? null : await api.openFileDialog('Choose the left file');
    const left = preset ?? (leftResult && fileOrNotice(leftResult));
    if (!left) return log.debug('files', 'No left file chosen');
    const rightResult = await api.openFileDialog('Choose the right file');
    const right = rightResult && fileOrNotice(rightResult);
    if (!right) return log.debug('files', 'No right file chosen');
    await showFiles(fromFile(left), fromFile(right));
  };

  /** Saves one side to its file (creating it for a side that was missing), or asks where with `as`. */
  const save = async (side: Side, as = false) => {
    if (mode !== 'files') return;
    const source = sources[side];
    const doc = cmp.docs[side];
    let path = source.file?.path ?? source.missingPath;
    if (as || !path) {
      path = (await api.saveFileDialog(path ?? source.label)) ?? undefined;
      if (!path) return log.debug('files', 'Save cancelled', { side: sideName(side) });
    }
    // A file being created (missing from one folder) follows its counterpart's conventions.
    const other = side === 'a' ? 'b' : 'a';
    const model = source.file ?? sources[other].file;
    const eol = model?.eol ?? '\n';
    const encoding = model?.encoding ?? 'utf8';
    const trailingNewline = source.file ? doc.trailingNewline : cmp.docs[other].trailingNewline;
    const version = doc.version;
    const text = joinLines(doc.lines, eol, trailingNewline);
    if (encoding === 'latin1' && /[^\u0000-\u00ff]/.test(text)) {
      const ok = await api.confirm({
        message: `Save ${source.label} as UTF-8?`,
        detail: 'It was read as Latin-1, which can\'t store some of the characters it now contains. Saving converts the whole file to UTF-8.',
        confirmLabel: 'Save as UTF-8',
      });
      log.info('files', ok ? 'Saving as UTF-8 (was Latin-1)' : 'Save cancelled: kept Latin-1', { side: sideName(side) });
      if (!ok) return;
    }
    const result = await api.saveFile({ path, text, encoding });
    log.info('files', result.ok ? `Saved the ${sideName(side)} side` : `Could not save the ${sideName(side)} side`, {
      path,
      as: as || undefined,
      lines: doc.lines.length,
      error: result.ok ? undefined : result.message,
    });
    if (!result.ok) {
      setNotice({ kind: 'error', text: `Could not save ${source.label}: ${result.message}` });
      return;
    }
    // Only mark clean if nothing was typed while the write was in flight.
    if (doc.version === version) cmp.markSaved(side);
    if (roots) folderStale.current = true;
    setSources((s) => ({
      ...s,
      [side]: {
        ...s[side],
        label: result.name,
        missingPath: undefined,
        file: { path: result.path, encoding: result.encoding, eol, mtimeMs: result.mtimeMs },
      },
    }));
  };

  /** Re-reads file-backed sides from disk, asking first about any with unsaved edits. */
  const reload = async (sides: Side[] = ['a', 'b']) => {
    const targets = sides.filter((s) => sources[s].file);
    if (targets.length === 0 || !(await confirmDiscard(targets))) return;
    const results = await Promise.all(targets.map((s) => api.readFile(sources[s].file!.path)));
    const errors = results.flatMap((r) => (r.ok ? [] : [r.message]));
    log.info('files', 'Reloaded from disk', { sides: targets.map(sideName).join(','), failed: errors.length || undefined });
    setNotice(errors.length ? { kind: 'error', text: errors.join(' ') } : null);
    restoreScroll.current = view.current?.scrollTop() ?? 0;
    setSources((s) => {
      const next = { ...s };
      targets.forEach((side, i) => {
        const r = results[i];
        if (r.ok) next[side] = fromFile(r.file);
      });
      return next;
    });
  };
  /** Scroll offset to restore once the reloaded comparison is on screen. */
  const restoreScroll = useRef<number | null>(null);

  // Tell the main process which files to watch, and offer a reload when one changes elsewhere.
  const watched =
    mode === 'files' ? [sources.a.file?.path, sources.b.file?.path].filter((p): p is string => !!p) : [];
  const watchKey = watched.join('\0');
  useEffect(() => void api.watchFiles(watched), [watchKey]);
  const onFileChanged = useRef<(path: string) => void>(() => {});
  onFileChanged.current = (path: string) => {
    const sides = (['a', 'b'] as const).filter((s) => sources[s].file?.path === path);
    if (sides.length === 0) return;
    const names = sides.map((s) => sources[s].label).join(' and ');
    const unsavedNote = sides.some(edited) ? ' Reloading will discard your unsaved edits.' : '';
    log.info('files', 'Changed on disk; offered to reload', { path, unsaved: sides.some(edited) || undefined });
    setNotice({
      kind: 'info',
      text: `${names} changed on disk.${unsavedNote}`,
      actions: [{ label: 'Reload', run: () => void reload(sides) }],
    });
  };
  useEffect(() => api.onFileChanged((p) => onFileChanged.current(p)), []);

  // ---- Folders ---------------------------------------------------------------------------

  const [folderProgress, setFolderProgress] = useState<FolderProgress | null>(null);
  useEffect(() => api.onFolderProgress(setFolderProgress), []);
  /** Identifies the latest scan, so a superseded one can't overwrite newer results. */
  const scanId = useRef(0);

  /** Compares the folders. `quiet` keeps the current list on screen until the new result arrives. */
  const rescan = async (r = roots, mode = folderMode, quiet = false) => {
    if (!r) return;
    const id = ++scanId.current;
    folderStale.current = false;
    setFolderBusy(!quiet);
    setFolderRefreshing(quiet);
    setFolderProgress(null);
    setNotice((n) => (n?.text === SCAN_CANCELLED ? null : n));
    let result: FolderCompareResult;
    try {
      result = await api.compareFolders(r.left, r.right, mode);
    } catch (err) {
      // The request itself failed (the server stopped, say): never leave "Comparing…" up.
      log.error('folders', 'The folder comparison request failed', {}, err);
      if (id === scanId.current) {
        setFolderBusy(false);
        setFolderRefreshing(false);
        setNotice({ kind: 'error', text: `The folder comparison failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    if (id !== scanId.current) return;
    setFolderBusy(false);
    setFolderRefreshing(false);
    if (!result.ok && result.cancelled) {
      // Keep whatever was on screen; the list explains how to scan again.
      setNotice({ kind: 'info', text: SCAN_CANCELLED });
      return;
    }
    setFolderResult(result);
  };

  const changeFolderMode = (mode: FolderCompareMode) => {
    log.info('folders', 'Compare by changed', { mode });
    setFolderMode(mode);
    localStorage.setItem(FOLDER_MODE_KEY, mode);
    void rescan(roots, mode);
  };

  const showFolders = async (r: { left: string; right: string }, fresh = true) => {
    if (!(await leaveFiles())) return;
    if (fresh) {
      setExpanded(new Set());
      setSelected(null);
      setFolderResult(null);
      setPicked(null);
      remember('folders', r.left, r.right);
    }
    log.info('folders', fresh ? 'Opened a folder comparison' : 'Reopened the folder comparison', { left: r.left, right: r.right, mode: folderMode });
    setResumeMode(null);
    setRoots(r);
    setMode('folders');
    setNotice(null);
    void rescan(r);
  };

  /** Asks for a left and then a right folder. */
  const compareFolders = async () => {
    const left = await api.openFolderDialog('Choose the left folder');
    if (!left) return log.debug('folders', 'No left folder chosen');
    const right = await api.openFolderDialog('Choose the right folder');
    if (!right) return log.debug('folders', 'No right folder chosen');
    showFolders({ left, right });
  };

  const browseFolder = async (side: TreeSide) => {
    if (!roots) return;
    const picked = await api.openFolderDialog(`Choose the ${side} folder`);
    log.info('folders', picked ? `Chose another ${side} folder` : `No ${side} folder chosen`, { path: picked ?? undefined });
    if (picked) showFolders({ ...roots, [side]: picked });
  };

  /** Opens a file from the folder tree; a side where it does not exist yet can be saved to create it. */
  const openFromFolders = async (node: FolderNode) => {
    if (!roots) return;
    if (node.left?.binary || node.right?.binary) {
      log.info('folders', 'Refused to compare a binary file', { relPath: node.relPath });
      setNotice({ kind: 'error', text: `${node.name} is a binary file. Delta compares text files only.` });
      return;
    }
    const read = async (root: string, present: boolean, side: Side): Promise<Source | null> => {
      const path = api.joinPath(root, node.relPath);
      if (!present) {
        return { id: newSourceId(), label: `${node.name} (not in the ${sideName(side)} folder)`, text: '', missingPath: path };
      }
      const file = fileOrNotice(await api.readFile(path));
      return file && fromFile(file);
    };
    const [a, b] = await Promise.all([read(roots.left, !!node.left, 'a'), read(roots.right, !!node.right, 'b')]);
    if (a && b) await showFiles(a, b, true);
  };

  const copyInFolders = async (node: FolderNode, from: TreeSide) => {
    if (!roots) return;
    const to = from === 'left' ? 'right' : 'left';
    const target = from === 'left' ? node.right : node.left;
    if (target) {
      const replacing = target.kind === 'dir' ? 'folder' : 'file';
      const ok = await api.confirm({
        message: `Replace the ${replacing} ${node.relPath} on the ${to} with the ${from} version?`,
        detail:
          target.kind === 'dir'
            ? `Files inside are overwritten with the ${from} versions; files that are only on the ${to} are kept.`
            : undefined,
        confirmLabel: 'Replace',
      });
      log.info('folders', ok ? 'Replace confirmed' : 'Replace cancelled', { relPath: node.relPath, from });
      if (!ok) return;
    }
    const r = await api.copyEntry({ leftRoot: roots.left, rightRoot: roots.right, relPath: node.relPath, from });
    if (!r.ok) setNotice({ kind: 'error', text: `Could not copy ${node.relPath}: ${r.message}` });
    // Behind the list, so it keeps its place.
    await rescan(roots, folderMode, true);
  };

  /** Compares any two files, keeping the way back to the folder comparison. */
  const compareFilePaths = async (leftPath: string, rightPath: string) => {
    const [l, r] = await Promise.all([api.readFile(leftPath), api.readFile(rightPath)]);
    const left = fileOrNotice(l);
    const right = fileOrNotice(r);
    if (left && right) await showFiles(fromFile(left), fromFile(right), true);
  };

  /**
   * Right-click menu for an entry in the folder tree. Every entry can be copied across; text
   * files can also be compared with any other file, staying on the side they were clicked on.
   */
  const onEntryContextMenu = (node: FolderNode, clicked: TreeSide, x: number, y: number) => {
    if (!roots) return;
    const opposite: TreeSide = clicked === 'left' ? 'right' : 'left';
    const side = (clicked === 'left' ? node.left : node.right) ? clicked : opposite;
    const entry = side === 'left' ? node.left : node.right;
    if (!entry) return;
    const path = api.joinPath(side === 'left' ? roots.left : roots.right, node.relPath);
    const items: MenuItem[] = [];
    const copyItems: MenuItem[] = [
      { label: 'Copy to the right ▶', run: () => void copyInFolders(node, 'left'), disabled: !node.left || node.status === 'same' },
      { label: 'Copy to the left ◀', run: () => void copyInFolders(node, 'right'), disabled: !node.right || node.status === 'same' },
    ];
    if (entry.kind === 'dir') {
      setFolderMenu({ x, y, items: copyItems });
      return;
    }
    if (entry.binary) {
      items.push({ label: `${node.name} is a binary file and can't be compared`, run: () => {}, disabled: true });
    } else {
      const counterpart = side === 'left' ? node.right : node.left;
      if (counterpart?.kind === 'file' && !counterpart.binary) {
        items.push({ label: 'Compare left and right', run: () => void openFromFolders(node) });
      }
      if (picked && picked.path !== path) {
        const p = picked;
        items.push({
          label: `Compare with “${p.name}” (${p.side})`,
          run: () => {
            setPicked(null);
            setNotice(null);
            // Files from different columns keep their columns; otherwise the selected one goes left.
            if (p.side === 'right' && side === 'left') void compareFilePaths(path, p.path);
            else void compareFilePaths(p.path, path);
          },
        });
      }
      items.push({
        label: 'Compare with a file…',
        run: async () => {
          const chosen = await api.openFileDialog(`Choose a file to compare with ${node.name}`);
          const other = chosen && fileOrNotice(chosen);
          if (!other) return;
          if (side === 'left') await compareFilePaths(path, other.path);
          else await compareFilePaths(other.path, path);
        },
      });
      items.push(
        picked?.path === path
          ? { label: 'Clear selection for comparison', run: () => (setPicked(null), setNotice(null)) }
          : {
              label: `Select “${node.name}” for comparison`,
              run: () => {
                log.info('folders', 'Selected a file for comparison', { path });
                setPicked({ side, relPath: node.relPath, path, name: node.name });
                setNotice({
                  kind: 'info',
                  text: `“${node.name}” is selected. Right-click another file and choose Compare with “${node.name}”.`,
                  actions: [{ label: 'Clear', run: () => (setPicked(null), setNotice(null)) }],
                });
              },
            },
      );
    }
    setFolderMenu({ x, y, items: [...items, ...copyItems] });
  };

  /** Returns to the folder comparison as it was, rescanning in the background only if a file was saved. */
  const backToFolders = async () => {
    if (!roots || !(await leaveFiles())) return;
    log.info('folders', 'Back to the folder comparison', { rescan: folderStale.current || undefined });
    if (!folderResult?.ok) return showFolders(roots, false);
    setResumeMode(null);
    setMode('folders');
    setNotice(null);
    if (folderStale.current) void rescan(roots, folderMode, true);
  };

  // ---- Home and recent comparisons -------------------------------------------------------

  const goHome = () => {
    log.info('app', 'Home', { from: mode });
    setResumeMode(mode === 'start' ? resumeMode : mode);
    setNotice(null);
    setMode('start');
  };

  /** Back to a folder comparison left open from Home; refreshes it if a file was saved since. */
  const resumeFolders = () => {
    log.info('app', 'Resumed the folder comparison');
    setResumeMode(null);
    setMode('folders');
    if (folderStale.current) void rescan(roots, folderMode, true);
  };

  /** Back to a file comparison left open from Home; says so if a file changed on disk meanwhile. */
  const resumeFiles = async () => {
    log.info('app', 'Resumed the file comparison');
    setResumeMode(null);
    setMode('files');
    for (const side of ['a', 'b'] as const) {
      const f = sources[side].file;
      if (!f) continue;
      const r = await api.readFile(f.path);
      if (r.ok && r.file.mtimeMs !== f.mtimeMs) onFileChanged.current(f.path);
    }
  };

  const loadRecents = async () => setRecents(await api.recentComparisons());

  // On the start screen, keep the list and each path's availability current: drives can be
  // plugged in or ejected while it is showing.
  useEffect(() => {
    if (mode !== 'start') return;
    void loadRecents();
    const timer = window.setInterval(() => !document.hidden && void loadRecents(), RECENTS_REFRESH_MS);
    const onFocus = () => void loadRecents();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [mode]);

  const openRecent = async (item: RecentComparison) => {
    log.info('app', 'Opened a recent comparison', { kind: item.kind });
    if (item.kind === 'folders') showFolders({ left: item.left.path, right: item.right.path });
    else await openPaths([item.left.path, item.right.path]);
  };

  const forgetRecent = async (item: RecentComparison) => {
    log.info('app', 'Removed a recent comparison', { kind: item.kind, left: item.left.path, right: item.right.path });
    await api.forgetComparison(item.kind, item.left.path, item.right.path);
    await loadRecents();
  };

  // ---- Paths from the command line -------------------------------------------------------

  /** Two files compare as files, two folders as folders. One file starts a file comparison. */
  const openPaths = async (paths: string[]) => {
    const kinds = await Promise.all(paths.slice(0, 2).map((p) => api.pathKind(p)));
    if (paths.length >= 2 && kinds[0] === 'dir' && kinds[1] === 'dir') return showFolders({ left: paths[0], right: paths[1] });
    if (paths.length >= 2 && kinds[0] === 'file' && kinds[1] === 'file') {
      const [l, r] = await Promise.all([api.readFile(paths[0]), api.readFile(paths[1])]);
      const left = fileOrNotice(l);
      const right = fileOrNotice(r);
      if (left && right) await showFiles(fromFile(left), fromFile(right));
      return;
    }
    if (paths.length === 1 && kinds[0] === 'file') {
      const left = fileOrNotice(await api.readFile(paths[0]));
      if (left) await compareFiles(left);
      return;
    }
    const missing = paths.slice(0, 2).filter((_, i) => kinds[i] === null);
    log.warn('app', 'Nothing to compare at the paths given', { paths: paths.join(' | '), missing: missing.length });
    setNotice({
      kind: 'error',
      text: missing.length ? `${missing.join(' and ')} ${missing.length > 1 ? "weren't" : "wasn't"} found.` : 'Choose two files or two folders to compare.',
    });
  };

  // ---- Menu commands ---------------------------------------------------------------------

  // Commands arrive through one subscription; the ref always holds this render's handler.
  const onCommand = useRef<(c: Command) => void>(() => {});
  onCommand.current = (command: Command) => {
    // The native menu doesn't grey items out, so commands that don't apply here do nothing.
    if (!commandEnabled(command)) return log.debug('menu', 'Command not available here', { command, mode });
    log.debug('menu', 'Command', { command });
    switch (command) {
      case 'compare-files':
        return void compareFiles();
      case 'compare-folders':
        return void compareFolders();
      case 'save':
        return void save(view.current?.activeSide() ?? 'a');
      case 'save-as':
        return void save(view.current?.activeSide() ?? 'a', true);
      case 'save-left':
        return void save('a');
      case 'save-right':
        return void save('b');
      case 'refresh':
        return void (mode === 'folders' ? rescan() : reload());
      case 'undo':
        return view.current?.undo();
      case 'redo':
        return view.current?.redo();
      case 'select-all':
        return view.current?.selectAll();
      case 'next-difference':
        return view.current?.goToDifference(1);
      case 'previous-difference':
        return view.current?.goToDifference(-1);
      case 'toggle-theme':
        return toggleTheme();
      case 'toggle-debug-logging':
        return void toggleDebugLogging();
      case 'open-logs-folder':
        return void api.openLogsFolder().catch((err: unknown) => {
          log.warn('app', 'Could not open the logs folder', {}, err);
          setNotice({ kind: 'error', text: `Could not open the logs folder: ${err instanceof Error ? err.message : String(err)}` });
        });
      case 'copy-diagnostics':
        return void copyDiagnostics();
    }
  };
  useEffect(() => api.onCommand((c) => onCommand.current(c)), []);

  // ---- Logging ---------------------------------------------------------------------------

  useEffect(() => {
    log.info('app', 'Interface opened', { host: api.capabilities.nativeMenu ? 'desktop' : 'browser', window: `${innerWidth}x${innerHeight}` });
    void api.logInfo().then((info) => {
      setLogLevel(info.level);
      setLogInfo(info);
    });
  }, []);

  /** Help > Debug Logging. */
  const toggleDebugLogging = async () => {
    const info = await api.setDebugLogging(logInfo?.level !== 'debug');
    setLogLevel(info.level);
    setLogInfo(info);
    setNotice({
      kind: 'info',
      text: info.level === 'debug' ? `Debug logging is on, until you turn it off. The log is ${info.file ?? 'unavailable'}.` : 'Debug logging is off.',
    });
  };

  /** Help > Copy Diagnostic Info: versions, settings and the latest log entries, for a bug report. */
  const copyDiagnostics = async () => {
    const text = api.diagnostics().then((t) => {
      // After the host's summary, before its log entries.
      const [summary, ...rest] = t.split('\n\n');
      return [`${summary}\nInterface: ${navigator.userAgent}`, ...rest].join('\n\n');
    });
    try {
      // Safari only allows copying during the click, so the text is handed over as a promise.
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      } else await navigator.clipboard.writeText(await text);
      log.info('app', 'Copied diagnostic info');
      setNotice({ kind: 'info', text: 'Diagnostic info copied. Paste it into your bug report.' });
    } catch (err) {
      log.warn('app', 'Could not copy diagnostic info', {}, err);
      setNotice({ kind: 'error', text: `Could not copy diagnostic info: ${err instanceof Error ? err.message : String(err)}` });
    }
  };


  // Anything that fails without its own handling (a request to a server that stopped, say)
  // still tells the user, instead of silently doing nothing.
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      log.error('app', 'Unhandled rejection', {}, e.reason);
      const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
      setNotice({ kind: 'error', text: `Something went wrong: ${reason}` });
    };
    // Errors nothing else caught are logged with their stacks.
    const onError = (e: ErrorEvent) => log.error('app', 'Uncaught error', {}, e.error ?? e.message);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);

  /** Whether a command applies to what's on screen (for the in-page menu and shortcuts). */
  const commandEnabled = (command: Command): boolean => {
    switch (command) {
      case 'compare-files':
      case 'compare-folders':
      case 'toggle-theme':
      case 'toggle-debug-logging':
      case 'open-logs-folder':
      case 'copy-diagnostics':
        return true;
      case 'refresh':
        return mode === 'folders' ? !!roots && !folderBusy && !folderRefreshing : mode === 'files' && !!(sources.a.file || sources.b.file);
      default:
        return mode === 'files';
    }
  };
  const isCommandEnabled = useRef(commandEnabled);
  isCommandEnabled.current = commandEnabled;

  // The browser version's keyboard shortcuts (the desktop app's come from its native menu).
  // Keys the editor already handled, and editing keys in other text fields, are left alone.
  // A shortcut that doesn't apply right now (or while a dialog is open) does nothing, like a
  // greyed-out menu item, rather than falling through to the browser: Cmd+S would otherwise
  // offer to save the web page, and F5 would reload it.
  useEffect(() => {
    if (api.capabilities.nativeMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const command = commandForKey(e, isMac);
      if (!command) return;
      const target = e.target as HTMLElement;
      const inField = (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && !target.classList.contains('input-proxy');
      if (inField && (command === 'undo' || command === 'redo' || command === 'select-all')) return;
      e.preventDefault();
      // A held key repeats; only editing and navigation should.
      if (e.repeat && command !== 'undo' && command !== 'redo' && command !== 'next-difference' && command !== 'previous-difference') return;
      if (document.querySelector('.modal-backdrop') || !isCommandEnabled.current(command)) return;
      onCommand.current(command);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Paths named on the command line: `delta a.txt b.txt` or `delta dirA dirB`.
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current) return; // effects run twice in development
    launched.current = true;
    void api.launchRequest().then((req) => {
      if (req.kind !== 'none') log.info('app', 'Opening what Delta was launched with', { kind: req.kind });
      if (req.kind === 'folders') showFolders({ left: req.left, right: req.right });
      if (req.kind === 'files') void openPaths([req.left, req.right].filter((p): p is string => !!p));
    });
  }, []);

  // ---- Rendering -------------------------------------------------------------------------

  const noticeBar = notice && <Notice notice={notice} onDismiss={() => setNotice(null)} />;
  const menuBar = !api.capabilities.nativeMenu && <MenuBar enabled={commandEnabled} checked={(c) => c === 'toggle-debug-logging' && logInfo?.level === 'debug'} onCommand={(c) => onCommand.current(c)} />;
  if (mode === 'folders' && roots) {
    return (
      <div className="app">
        {menuBar}
        <FolderView
          leftRoot={roots.left}
          rightRoot={roots.right}
          result={folderResult}
          busy={folderBusy}
          refreshing={folderRefreshing}
          expanded={expanded}
          onExpandedChange={setExpanded}
          hideSame={hideSame}
          onHideSameChange={(hide) => {
            log.info('folders', hide ? 'Hiding identical entries' : 'Showing identical entries');
            setHideSame(hide);
          }}
          selected={selected}
          onSelect={setSelected}
          onBrowse={(side) => void browseFolder(side)}
          onRescan={() => {
            log.info('folders', 'Rescan');
            void rescan();
          }}
          compareMode={folderMode}
          onCompareModeChange={changeFolderMode}
          progress={folderProgress}
          onCancel={() => {
            log.info('folders', 'Cancel pressed');
            void api.cancelFolderCompare();
          }}
          onOpen={(node) => void openFromFolders(node)}
          onCopy={(node, from) => void copyInFolders(node, from)}
          onEntryContextMenu={onEntryContextMenu}
          pickedKey={picked ? `${picked.side}:${picked.relPath}` : null}
          onHome={goHome}
          theme={theme}
          onThemeChange={changeTheme}
          notice={noticeBar}
        />
        {folderMenu && <ContextMenu {...folderMenu} onClose={() => setFolderMenu(null)} />}
      </div>
    );
  }

  if (mode === 'start') {
    return (
      <div className="app">
        {menuBar}
        {noticeBar}
        <StartScreen
          onCompareFiles={() => void compareFiles()}
          onCompareFolders={() => void compareFolders()}
          recents={recents.items}
          homeDir={recents.homeDir}
          onOpenRecent={(item) => void openRecent(item)}
          onForgetRecent={(item) => void forgetRecent(item)}
          resume={
            resumeMode === 'folders' && roots
              ? { label: `${baseName(roots.left)} ↔ ${baseName(roots.right)}`, run: resumeFolders }
              : resumeMode === 'files'
                ? { label: `${sources.a.label} ↔ ${sources.b.label}`, run: () => void resumeFiles() }
                : undefined
          }
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {menuBar}
      <Toolbar
        onHome={goHome}
        onBackToFolders={roots ? backToFolders : undefined}
        whitespace={whitespace}
        onWhitespaceChange={(w) => {
          log.info('view', 'Whitespace option changed', { whitespace: w });
          setWhitespace(w);
        }}
        ignoreCase={ignoreCase}
        onIgnoreCaseChange={(on) => {
          log.info('view', 'Ignore case changed', { ignoreCase: on });
          setIgnoreCase(on);
        }}
        theme={theme}
        onThemeChange={changeTheme}
        stats={cmp.stats}
        busy={cmp.busy}
        elapsedMs={cmp.elapsedMs}
        canRefresh={watched.length > 0}
        onRefresh={() => {
          log.info('files', 'Refresh pressed');
          void reload();
        }}
      />
      {noticeBar}
      {cmp.error && <div className="error">Comparison failed: {cmp.error}</div>}
      {cmp.view && (
        <DiffView
          handleRef={view}
          docs={cmp.docs}
          labels={{ a: sources.a.label, b: sources.b.label }}
          paths={{ a: sources.a.file?.path ?? sources.a.missingPath, b: sources.b.file?.path ?? sources.b.missingPath }}
          homeDir={recents.homeDir}
          placeholders={{
            a: sources.a.missingPath && `This file is not in the left folder. Copy changes into this side and save to create it.`,
            b: sources.b.missingPath && `This file is not in the right folder. Copy changes into this side and save to create it.`,
          }}
          rows={cmp.view.rows}
          blocks={cmp.view.blocks}
          fresh={cmp.view.fresh}
          options={options}
          theme={theme}
          onEdit={cmp.edit}
          onUndo={cmp.undo}
          onUndoSide={cmp.undoSide}
          canUndo={cmp.canUndo}
          isEdited={cmp.isEdited}
          onRedo={cmp.redo}
          onSealHistory={cmp.sealHistory}
          onSave={save}
          restoreScroll={restoreScroll}
          anchors={cmp.anchors}
          onAlign={cmp.align}
          onUnalign={cmp.unalign}
          onClearAlignments={cmp.clearAlignments}
        />
      )}
    </div>
  );
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
