import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  TIMESTAMP_TOLERANCE_MS,
  type FolderCompareMode,
  type FolderCompareResult,
  type FolderNode,
  type FolderProgress,
} from '../../../shared/api';
import { countFiles, flattenTree, folderPaths } from '../model/folderTree';
import { ratioAt, useSplit } from './split';
import type { Theme } from './Toolbar';
import { FolderCompareOptions } from './FolderCompareOptions';
import { HomeButton } from './HomeButton';
import { MergeIcon, RefreshIcon } from './icons';
import { ThemeButton } from './ThemeButton';

/** Width of the centre column holding the copy arrows; it doubles as the divider. */
const DIVIDER_WIDTH = 56;
/** Height of one folder row (matches `.frow` in styles.css). */
const FROW_HEIGHT = 24;
/** Rows are rendered in bands of this many, like the text panes, so huge trees stay fast. */
const FBAND_ROWS = 40;
/** After this long comparing contents, suggest the much faster size-and-date mode. */
const SLOW_SCAN_HINT_MS = 4000;
/** Where the list was scrolled, per pair of roots, so returning from a file comparison keeps the place. */
const savedScroll = new Map<string, number>();

export type TreeSide = 'left' | 'right';

interface FolderViewProps {
  leftRoot: string;
  rightRoot: string;
  result: FolderCompareResult | null;
  busy: boolean;
  /** A rescan or an update running behind the current list, which stays usable meanwhile. */
  refreshing?: boolean;
  /** Update automatically when files change elsewhere (the Compare by menu's checkbox). */
  autoUpdate: boolean;
  onAutoUpdateChange: (on: boolean) => void;
  /** Shown in the toolbar when outside changes can't be watched for (and are checked periodically). */
  watchNote?: string | null;
  expanded: ReadonlySet<string>;
  onExpandedChange: (next: Set<string>) => void;
  hideSame: boolean;
  onHideSameChange: (value: boolean) => void;
  selected: string | null;
  onSelect: (relPath: string) => void;
  onBrowse: (side: TreeSide) => void;
  onRescan: () => void;
  compareMode: FolderCompareMode;
  onCompareModeChange: (mode: FolderCompareMode) => void;
  /** Live counters while a comparison runs. */
  progress: FolderProgress | null;
  onCancel: () => void;
  /** Opens a file (present on either side) in the text comparison. */
  onOpen: (node: FolderNode) => void;
  onCopy: (node: FolderNode, from: TreeSide) => void;
  /** Right-click on a row; `side` is the column that was clicked. */
  onEntryContextMenu: (node: FolderNode, side: TreeSide, x: number, y: number) => void;
  /** The file chosen with "Select for comparison", as `side:relPath`, to outline it. */
  pickedKey: string | null;
  /** Back to the start screen (the comparison stays open and can be resumed). */
  onHome: () => void;
  /** A notice bar to show under the toolbar. */
  notice: ReactNode;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

/**
 * Two folders side by side as one tree. Each row is an entry that exists on at least one side,
 * coloured by status; arrows in the middle copy it across. Double-click (or Enter) opens a file
 * in the text comparison or expands a folder.
 */
export function FolderView(props: FolderViewProps) {
  const { result, expanded, hideSame, selected } = props;
  const root = result?.ok ? result.root : null;
  const rows = useMemo(() => (root ? flattenTree(root, expanded, hideSame) : []), [root, expanded, hideSame]);
  const counts = useMemo(() => (root ? countFiles(root) : null), [root]);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useSplit('delta.split.folders');
  const dragging = useRef(false);

  // The centre column is the divider: drag to resize the two sides, double-click to reset.
  const onButton = (e: { target: EventTarget }) => (e.target as HTMLElement).closest('button') !== null;
  const divider = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || onButton(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (dragging.current && rect) setSplit(ratioAt(e.clientX, rect, DIVIDER_WIDTH, DIVIDER_WIDTH));
    },
    onPointerUp: () => {
      dragging.current = false;
    },
    onDoubleClick: (e: { target: EventTarget; stopPropagation: () => void }) => {
      if (onButton(e)) return;
      e.stopPropagation();
      setSplit(0.5);
    },
  };
  const columns = { '--split-cols': `minmax(0, ${split}fr) ${DIVIDER_WIDTH}px minmax(0, ${1 - split}fr)` } as CSSProperties;

  const toggle = (relPath: string, open?: boolean) => {
    const next = new Set(expanded);
    if (open ?? !next.has(relPath)) next.add(relPath);
    else next.delete(relPath);
    props.onExpandedChange(next);
  };
  const activate = (node: FolderNode) => (node.children ? toggle(node.relPath) : props.onOpen(node));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.node.relPath === selected);
    const row = rows[i];
    switch (e.key) {
      case 'ArrowDown':
        if (rows.length) props.onSelect(rows[Math.min(rows.length - 1, i + 1)].node.relPath);
        break;
      case 'ArrowUp':
        if (rows.length) props.onSelect(rows[Math.max(0, i - 1)].node.relPath);
        break;
      case 'ArrowRight':
        if (row?.isDir) toggle(row.node.relPath, true);
        break;
      case 'ArrowLeft':
        if (row?.isDir && row.expanded) toggle(row.node.relPath, false);
        else if (row) {
          // Jump to the parent folder.
          const parent = row.node.relPath.split('/').slice(0, -1).join('/');
          if (parent) props.onSelect(parent);
        }
        break;
      case 'Enter':
        if (row) activate(row.node);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Only rows near the viewport are rendered; the list re-renders when scrolling enters a new band.
  const [band, setBand] = useState(0);
  const [listHeight, setListHeight] = useState(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setListHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scrollKey = `${props.leftRoot}\0${props.rightRoot}`;
  // Restored on arrival, and after a full rescan (the list is hidden while it runs).
  useLayoutEffect(() => {
    const el = listRef.current;
    const top = savedScroll.get(scrollKey);
    if (!el || top === undefined || !root || props.busy) return;
    el.scrollTop = top;
    setBand(Math.floor(el.scrollTop / (FBAND_ROWS * FROW_HEIGHT)));
  }, [scrollKey, !root, props.busy]);
  const firstRow = Math.max(0, (band - 1) * FBAND_ROWS);
  const lastRow = Math.min(rows.length, (band + 2 + Math.ceil(listHeight / (FBAND_ROWS * FROW_HEIGHT))) * FBAND_ROWS);

  // Keep the selected row in view when it moves with the keyboard (it may not be rendered yet).
  useEffect(() => {
    const el = listRef.current;
    const i = rows.findIndex((r) => r.node.relPath === selected);
    if (!el || i < 0) return;
    const top = i * FROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + FROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + FROW_HEIGHT - el.clientHeight;
  }, [selected]);

  const cell = (node: FolderNode, side: TreeSide, depth: number, isDir: boolean, open: boolean) => {
    const entry = side === 'left' ? node.left : node.right;
    if (!entry) return <div className="fcell missing" />;
    const picked = props.pickedKey === `${side}:${node.relPath}`;
    return (
      <div className={`fcell${picked ? ' picked' : ''}${entry.binary ? ' binary' : ''}`}>
        <span className="fname" style={{ paddingLeft: depth * 16 }}>
          <span className="twisty">{isDir ? (open ? '▾' : '▸') : ''}</span>
          {node.name}
          {entry.kind === 'dir' ? '/' : ''}
        </span>
        {entry.binary && (
          <span className="ftag" title="Binary file: it can be copied across, but not compared as text">
            binary
          </span>
        )}
        {node.error && (
          <span className="ftag ftag-error" title={`Couldn't be compared: ${node.error}`}>
            can't read
          </span>
        )}
        <span className="fmeta">
          {entry.kind === 'file' && `${formatSize(entry.size)}  `}
          <span
            className={newerSide(node) === side ? 'newer' : undefined}
            title={newerSide(node) === side ? 'Newer than the other side' : undefined}
          >
            {formatDate(entry.mtimeMs)}
          </span>
        </span>
      </div>
    );
  };

  return (
    <div className="folder-view" ref={rootRef} style={columns}>
      <div className="toolbar">
        <HomeButton onClick={props.onHome} />
        <span className="toolbar-sep" />
        <FolderCompareOptions mode={props.compareMode} onChange={props.onCompareModeChange} autoUpdate={props.autoUpdate} onAutoUpdateChange={props.onAutoUpdateChange} />
        <button
          type="button"
          className="icon-button"
          onClick={props.onRescan}
          disabled={props.busy || props.refreshing}
          title="Rescan: compare both folders again (F5)"
          aria-label="Rescan"
        >
          <RefreshIcon />
        </button>
        <button type="button" onClick={() => root && props.onExpandedChange(new Set(folderPaths(root)))} disabled={!root}>
          Expand all
        </button>
        <button type="button" onClick={() => props.onExpandedChange(new Set())} disabled={!root}>
          Collapse all
        </button>
        <label className="check">
          <input type="checkbox" checked={hideSame} onChange={(e) => props.onHideSameChange(e.target.checked)} />
          Hide identical
        </label>
        <div className="spacer" />
        <span className="stats">
          {props.busy && <span className="elapsed">Comparing…</span>}
          {props.refreshing && <span className="elapsed">Updating…</span>}
          {props.watchNote && !props.refreshing && (
            <span className="elapsed watch-note" title={props.watchNote}>
              Checking for changes periodically
            </span>
          )}
          {!props.busy && counts && (
            <>
              <strong>
                {counts.different + counts['left-only'] + counts['right-only'] + counts['kind-mismatch'] === 0
                  ? 'Identical'
                  : `${counts.different + counts['kind-mismatch']} different`}
              </strong>
              <span className="stat del">{counts['left-only']} left only</span>
              <span className="stat ins">{counts['right-only']} right only</span>
              <span className="elapsed">{counts.same} same</span>
            </>
          )}
        </span>
        <ThemeButton theme={props.theme} onToggle={() => props.onThemeChange(props.theme === 'dark' ? 'light' : 'dark')} />
      </div>

      {props.notice}

      <div className="folder-roots">
        {(['left', 'right'] as const).map((side) => [
          <div key={side} className="pane-header">
            <span className="pane-title" title={side === 'left' ? props.leftRoot : props.rightRoot}>
              {side === 'left' ? props.leftRoot : props.rightRoot}
            </span>
            <button type="button" className="header-button" onClick={() => props.onBrowse(side)}>
              Browse…
            </button>
          </div>,
          side === 'left' && (
            <div key="divider" className="folder-divider" title="Drag to resize; double-click to reset" {...divider} />
          ),
        ])}
      </div>

      {result && !result.ok && <div className="notice notice-error">{result.message}</div>}

      <div
        className="folder-list"
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          // While scanning the list collapses, which scrolls to the top; that isn't the user's place.
          if (!props.busy) savedScroll.set(scrollKey, top);
          setBand(Math.floor(top / (FBAND_ROWS * FROW_HEIGHT)));
        }}
      >
        {props.busy && (
          <ScanProgress
            progress={props.progress}
            slowContentsScan={props.compareMode === 'contents' && (props.progress?.elapsedMs ?? 0) > SLOW_SCAN_HINT_MS}
            onCancel={props.onCancel}
            onUseFastMode={() => props.onCompareModeChange('size-date')}
          />
        )}
        {!props.busy && !result && <div className="placeholder">Nothing compared yet. Press Rescan (the circular arrow) or F5 to compare these folders.</div>}
        {!props.busy && root && rows.length === 0 && <div className="placeholder">{hideSame ? 'No differences.' : 'Both folders are empty.'}</div>}
        <div className="folder-rows" style={{ height: props.busy ? 0 : rows.length * FROW_HEIGHT }}>
          {!props.busy && rows.slice(firstRow, lastRow).map(({ node, depth, isDir, expanded: open }, k) => (
            <div
              key={node.relPath}
              style={{ top: (firstRow + k) * FROW_HEIGHT }}
              className={`frow st-${node.status}${node.relPath === selected ? ' selected' : ''}`}
              onClick={() => props.onSelect(node.relPath)}
              onDoubleClick={() => activate(node)}
              onContextMenu={(e) => {
                e.preventDefault();
                props.onSelect(node.relPath);
                // Which column was clicked decides which side's entry the menu is about.
                const rect = e.currentTarget.getBoundingClientRect();
                props.onEntryContextMenu(node, e.clientX < rect.left + rect.width / 2 ? 'left' : 'right', e.clientX, e.clientY);
              }}
            >
              {cell(node, 'left', depth, isDir, open)}
              <div className="factions" {...divider}>
                <button
                  type="button"
                  className="merge merge-from-a"
                  disabled={!node.left || node.status === 'same'}
                  title="Copy to the right"
                  aria-label={`Copy ${node.relPath} to the right`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onCopy(node, 'left');
                  }}
                >
                  <MergeIcon toward="right" />
                </button>
                <button
                  type="button"
                  className="merge merge-from-b"
                  disabled={!node.right || node.status === 'same'}
                  title="Copy to the left"
                  aria-label={`Copy ${node.relPath} to the left`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onCopy(node, 'right');
                  }}
                >
                  <MergeIcon toward="left" />
                </button>
              </div>
              {cell(node, 'right', depth, isDir, open)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * For a file that differs, the side modified more recently (beyond the timestamp tolerance),
 * so its date can be emphasised. Null when the files match, are folders, or the times agree.
 */
function newerSide(node: FolderNode): TreeSide | null {
  const { left, right } = node;
  if (node.status !== 'different' || left?.kind !== 'file' || right?.kind !== 'file') return null;
  if (Math.abs(left.mtimeMs - right.mtimeMs) <= TIMESTAMP_TOLERANCE_MS) return null;
  return left.mtimeMs > right.mtimeMs ? 'left' : 'right';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shown in place of the list while a comparison runs. */
function ScanProgress(props: {
  progress: FolderProgress | null;
  slowContentsScan: boolean;
  onCancel: () => void;
  onUseFastMode: () => void;
}) {
  const p = props.progress;
  return (
    <div className="scan-progress" role="status" aria-live="polite">
      <div className="scan-title">Comparing folders…</div>
      <div className="scan-counts">
        {p
          ? `${p.entries.toLocaleString()} items · ${p.filesCompared.toLocaleString()} files compared · ${formatSize(p.bytesRead)} read · ${formatElapsed(p.elapsedMs)}`
          : 'Starting…'}
      </div>
      {p?.current && (
        <div className="scan-current" title={p.current}>
          {p.current}
        </div>
      )}
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
      {props.slowContentsScan && (
        <div className="scan-hint">
          Comparing contents reads every file. For large folders, comparing by size and modified date is much faster.
          <button type="button" onClick={props.onUseFastMode}>
            Use size and modified date
          </button>
        </div>
      )}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
