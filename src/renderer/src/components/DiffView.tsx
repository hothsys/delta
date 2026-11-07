import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from 'react';
import { diffChars, type Anchor, type CompareOptions, type DiffBlock, type IntraLineDiff } from '../../../engine';
import { log } from '../log';
import { mergeOp } from '../model/merge';
import { maxColumns, RowKind, type RowModel, type Side } from '../model/rowModel';
import {
  caretAt,
  clampPos,
  colAtVisual,
  isCaret,
  ordered,
  replaceRange,
  textInRange,
  transformPos,
  visualColumn,
  wordAt,
  wordLeft,
  wordRight,
  type EditOp,
  type Pos,
  type Selection,
} from '../model/textEdit';
import type { Docs, EditMeta } from '../useComparison';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Gutter, type GutterHandle } from './Gutter';
import { SaveIcon, UndoIcon } from './icons';
import { FileStatus } from './FileStatus';
import { LineDetails } from './LineDetails';
import type { FileDetails } from '../model/fileDetails';
import { BAND_ROWS, BAND_WIDTH, CELL_PADDING, charWidth, FONT, GUTTER_WIDTH, OVERVIEW_WIDTH, ROW_HEIGHT, TAB_SIZE } from './layout';
import { scrollTopForRow } from '../model/overview';
import { splitPath, tildePath } from '../model/paths';
import { Overview, type OverviewHandle } from './Overview';
import { Pane } from './Pane';
import { ratioAt, useSplit } from './split';

/** Commands the app forwards from the menu. */
export interface DiffViewHandle {
  undo(): void;
  redo(): void;
  selectAll(): void;
  /** Moves to the next (1) or previous (-1) change after or before the caret. */
  goToDifference(direction: 1 | -1): void;
  /** The side the user last worked in. */
  activeSide(): Side;
  scrollTop(): number;
}

interface DiffViewProps {
  handleRef: Ref<DiffViewHandle>;
  docs: Docs;
  labels: Record<Side, string>;
  /** Full paths of sides that came from files, shown in the headers. */
  paths: Partial<Record<Side, string>>;
  /** The user's home folder, shown as ~ in header paths ('' if unknown). */
  homeDir: string;
  /** Messages for sides with no file yet (a file missing from one of two compared folders). */
  placeholders: Partial<Record<Side, string | undefined>>;
  rows: RowModel;
  blocks: readonly DiffBlock[];
  /** False while the layout is a local patch awaiting re-diff; merges are disabled then. */
  fresh: boolean;
  options: CompareOptions;
  theme: string;
  onEdit: (side: Side, op: EditOp, meta: EditMeta) => void;
  onUndo: () => UndoResult | null;
  /** Undo for one side only (the Undo button in each header). */
  onUndoSide: (side: Side) => UndoResult | null;
  canUndo: (side: Side) => boolean;
  /** Whether a side differs from what was last opened or saved. */
  isEdited: (side: Side) => boolean;
  onRedo: () => UndoResult | null;
  onSealHistory: () => void;
  onSave: (side: Side) => void;
  /** A scroll offset to apply once on mount (after a reload), then cleared. */
  restoreScroll: { current: number | null };
  anchors: Anchor[];
  onAlign: (a: number, b: number) => void;
  onUnalign: (side: Side, line: number) => void;
  onClearAlignments: () => void;
  /** Each side's file encoding, size and line endings, for the status line under its pane. */
  fileDetails: Record<Side, FileDetails | null>;
  /** File conventions that differ between the sides, emphasised in both status lines. */
  conventionsDiffer: { encoding: boolean; eol: boolean; newline: boolean };
  /**
   * Set while the view can't be edited (Prettify is on), saying why. The caret, selection,
   * copying and alignment still work; typing, merging, saving and undo do nothing.
   */
  readOnly?: string;
  /**
   * Which difference the caret was last moved to by F7 or the toolbar arrows, as "2 of 5",
   * while it's still there (null once it moves away, or the text changes).
   */
  onLandedChange?: (position: { index: number; total: number } | null) => void;
}

/** What undo and redo did: the side and edit they applied, and the selection they remembered. */
interface UndoResult {
  side: Side;
  selection: Selection;
  op: EditOp;
}

const isMac = navigator.platform.toUpperCase().includes('MAC');
/** Presses closer together than this (and within a few pixels) count as a double or triple click. */
const MULTI_CLICK_MS = 400;
/** Wheel steps at least this many pixels (a mouse wheel's clicks, not a trackpad) are eased. */
const SMOOTH_WHEEL_STEP = 40;
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

/**
 * Side-by-side comparison with both panes editable. Both panes render the same row model and
 * the same content width, so their scroll ranges are identical and syncing is a matter of
 * copying scroll offsets.
 */
export function DiffView(props: DiffViewProps) {
  const { docs, rows, blocks, fresh, options, theme, onEdit } = props;
  const refs = { a: useRef<HTMLDivElement>(null), b: useRef<HTMLDivElement>(null) };
  const rootRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useSplit('delta.split.files');
  // Pane widths, so both panes can be given the same horizontal scroll range when the split is uneven.
  const [paneWidths, setPaneWidths] = useState({ a: 0, b: 0 });
  const inputs = { a: useRef<HTMLTextAreaElement>(null), b: useRef<HTMLTextAreaElement>(null) };
  /** Which band of rows the viewport's top is in; changes far less often than the scroll offset. */
  const [band, setBand] = useState(0);
  /** The same for horizontal scrolling, in BAND_WIDTH steps; only long lines depend on it. */
  const [hBand, setHBand] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const a = refs.a.current;
    const b = refs.b.current;
    if (!a || !b) return;
    const ro = new ResizeObserver(() => {
      setViewportHeight(b.clientHeight);
      setPaneWidths({ a: a.clientWidth, b: b.clientWidth });
    });
    ro.observe(a);
    ro.observe(b);
    return () => ro.disconnect();
  }, []);

  // Lines are edited in place, so the versions are what tell memos that the text changed.
  const versions = `${docs.a.version}:${docs.b.version}`;
  const linesOf = (side: Side) => docs[side].lines;
  const cw = charWidth();
  const digits = String(Math.max(docs.a.lines.length, docs.b.lines.length, 1)).length;
  const lineNumberWidth = Math.ceil(digits * cw) + 2 * CELL_PADDING;
  const textLeft = lineNumberWidth + CELL_PADDING;
  const columns = useMemo(
    () => Math.max(maxColumns(docs.a.lines, TAB_SIZE), maxColumns(docs.b.lines, TAB_SIZE)),
    [docs, versions],
  );
  // One extra column so the caret fits after the longest line.
  const contentWidth = textLeft + Math.ceil((columns + 1) * cw) + CELL_PADDING;

  // Character-level highlights are computed on demand for visible rows and cached per row.
  const { whitespace, ignoreCase } = options;
  const intraCache = useMemo(() => new Map<number, IntraLineDiff>(), [rows, versions, whitespace, ignoreCase]);
  const intraLine = useCallback(
    (r: number): IntraLineDiff | null => {
      const a = rows.a[r];
      const b = rows.b[r];
      if (a < 0 || b < 0) return null;
      let d = intraCache.get(r);
      if (!d) {
        // Unimportant rows show the raw differences that the active options are hiding.
        const opts = rows.kind[r] === RowKind.Unimportant ? {} : { whitespace, ignoreCase };
        d = diffChars(docs.a.lines[a], docs.b.lines[b], opts);
        intraCache.set(r, d);
      }
      return d;
    },
    [rows, docs, whitespace, ignoreCase, intraCache],
  );

  // ---- Scrolling -------------------------------------------------------------------------

  // The pane the user last interacted with leads; the other follows. Programmatic scrolls and
  // layout clamps also fire scroll events, possibly in the same frame as the user's next scroll,
  // so letting either pane push its offsets would let a stale event drag the leader backwards.
  const leader = useRef<Side>('b');
  const lead = (side: Side) => () => {
    leader.current = side;
  };
  const gutter = useRef<GutterHandle>(null);
  const overview = useRef<OverviewHandle>(null);

  /** Brings the gutter, overview and rendered band up to date with the leading pane. */
  const syncDecorations = (leadEl: HTMLDivElement) => {
    // Cheap canvas updates every time, so nothing lags; React only re-renders on a new band.
    gutter.current?.draw(leadEl.scrollTop);
    overview.current?.setViewport(leadEl.scrollTop, leadEl.clientHeight);
    setBand(Math.floor(leadEl.scrollTop / (BAND_ROWS * ROW_HEIGHT)));
    setHBand(Math.floor(leadEl.scrollLeft / BAND_WIDTH));
  };

  // Scrollbar drags, keyboard scrolling and caret moves scroll one pane; the other follows here.
  // A scroll the app didn't make (a scrollbar drag, keyboard scrolling) on the follower makes
  // it the leader: WebKit reports no pointer press on scrollbars, so the drag would otherwise
  // be pulled back. Any such scroll also stops a running wheel animation, which would undo it.
  const onScroll = (from: Side) => () => {
    const el = refs[from].current;
    if (!el) return;
    const exp = expected.current[from];
    expected.current[from] = null;
    const programmatic = exp !== null && Math.abs(el.scrollTop - exp.top) <= 1 && Math.abs(el.scrollLeft - exp.left) <= 1;
    if (!programmatic) {
      leader.current = from;
      const w = wheel.current;
      if (w.frame) {
        cancelAnimationFrame(w.frame);
        w.frame = 0;
      }
    }
    const leadEl = refs[leader.current].current;
    const followEl = refs[other(leader.current)].current;
    if (!leadEl || !followEl) return;
    if (followEl.scrollTop !== leadEl.scrollTop || followEl.scrollLeft !== leadEl.scrollLeft) {
      setScroll(followEl, leadEl.scrollTop, leadEl.scrollLeft);
    }
    if (from === leader.current) syncDecorations(leadEl);
  };

  /**
   * Wheel and trackpad scrolling over the panes, gutter or overview moves both panes in the same
   * frame. Left to the browser, only the pane under the pointer would scroll natively, and the
   * other would catch up only when a scroll event reached script, which browsers (Safari
   * especially) deliver less often than they paint, so it visibly lagged and jumped.
   * The offsets are kept unrounded here, so small trackpad deltas aren't lost to rounding.
   * Trackpads send small steps every frame and are applied at once; a mouse wheel's large
   * steps are eased over a few frames, as the browser would, so they don't jump.
   */
  const wheel = useRef({ top: 0, left: 0, targetTop: 0, targetLeft: 0, frame: 0 });
  /** Offsets the app last set on each pane, so its own scrolls can be told from the user's. */
  const expected = useRef<Record<Side, { top: number; left: number } | null>>({ a: null, b: null });
  const setScroll = (el: HTMLDivElement, top: number, left: number) => {
    const side: Side = el === refs.a.current ? 'a' : 'b';
    el.scrollTop = top;
    el.scrollLeft = left;
    expected.current[side] = { top: el.scrollTop, left: el.scrollLeft };
  };
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const apply = () => {
      const w = wheel.current;
      for (const ref of [refs.a, refs.b]) if (ref.current) setScroll(ref.current, w.top, w.left);
      const leadEl = refs[leader.current].current;
      if (leadEl) syncDecorations(leadEl);
    };
    const step = () => {
      const w = wheel.current;
      const t = w.targetTop - w.top;
      const l = w.targetLeft - w.left;
      const done = Math.abs(t) < 0.5 && Math.abs(l) < 0.5;
      w.top = done ? w.targetTop : w.top + t * 0.35;
      w.left = done ? w.targetLeft : w.left + l * 0.35;
      apply();
      w.frame = done ? 0 : requestAnimationFrame(step);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || !(e.target as Element).closest('.pane, .gutter, .overview')) return; // Ctrl: zoom.
      const leadEl = refs[leader.current].current;
      if (!leadEl) return;
      e.preventDefault();
      // Wheel deltas can be in pixels, lines or pages; Shift turns a plain wheel sideways.
      const unit = e.deltaMode === 1 ? ROW_HEIGHT : e.deltaMode === 2 ? leadEl.clientHeight : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
      const w = wheel.current;
      if (!w.frame) {
        // Resync after anything else scrolled (scrollbar, keyboard, jumps).
        if (Math.abs(w.top - leadEl.scrollTop) >= 1) w.top = leadEl.scrollTop;
        if (Math.abs(w.left - leadEl.scrollLeft) >= 1) w.left = leadEl.scrollLeft;
        w.targetTop = w.top;
        w.targetLeft = w.left;
      }
      w.targetTop = Math.max(0, Math.min(leadEl.scrollHeight - leadEl.clientHeight, w.targetTop + dy));
      w.targetLeft = Math.max(0, Math.min(leadEl.scrollWidth - leadEl.clientWidth, w.targetLeft + dx));
      if (w.frame || Math.abs(dx) >= SMOOTH_WHEEL_STEP || Math.abs(dy) >= SMOOTH_WHEEL_STEP) {
        if (!w.frame) w.frame = requestAnimationFrame(step);
      } else {
        w.top = w.targetTop;
        w.left = w.targetLeft;
        apply();
      }
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      root.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(wheel.current.frame);
    };
  }, []);

  const getScrollTop = useCallback(() => refs[leader.current].current?.scrollTop ?? 0, []);
  const getViewport = useCallback(
    () => ({ scrollTop: getScrollTop(), height: refs.b.current?.clientHeight ?? 0 }),
    [getScrollTop],
  );
  // Programmatic scrolls move both panes at once, so there is nothing for the follower to catch up on.
  const scrollTo = useCallback((top: number) => {
    for (const ref of [refs.a, refs.b]) if (ref.current) setScroll(ref.current, top, ref.current.scrollLeft);
  }, []);
  const scrollLeftTo = (left: number) => {
    for (const ref of [refs.a, refs.b]) if (ref.current) setScroll(ref.current, ref.current.scrollTop, left);
  };

  // ---- Editing state ---------------------------------------------------------------------

  const [selections, setSelections] = useState<Record<Side, Selection>>({
    a: caretAt({ line: 0, col: 0 }),
    b: caretAt({ line: 0, col: 0 }),
  });
  const [active, setActive] = useState<Side>('a');
  const [focused, setFocused] = useState(false);
  /** Display column that vertical movement tries to keep, like any text editor. */
  const goalColumn = useRef<number | null>(null);
  const reveal = useRef(false);
  const composing = useRef(false);
  /** Where the last F7/Shift+F7 put the caret, and the row of the change it went to. */
  const lastJump = useRef<{ side: Side; line: number; row: number } | null>(null);

  // Selections can point past the end after edits elsewhere; always read them clamped.
  const selOf = (side: Side): Selection => {
    const lines = linesOf(side);
    const s = selections[side];
    return { anchor: clampPos(lines, s.anchor), head: clampPos(lines, s.head) };
  };

  const select = (side: Side, s: Selection, opts: { reveal?: boolean; keepGoal?: boolean } = {}) => {
    if (!opts.keepGoal) goalColumn.current = null;
    if (opts.reveal) reveal.current = true;
    setSelections((prev) => ({ ...prev, [side]: s }));
  };

  const rowOfLine = (side: Side, line: number): number => {
    const inv = side === 'a' ? rows.aRow : rows.bRow;
    return inv.length ? inv[Math.min(line, inv.length - 1)] : 0;
  };

  // Scroll the caret into view after keyboard moves and edits.
  useLayoutEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    const el = refs[active].current;
    if (!el) return;
    const head = selOf(active).head;
    leader.current = active;
    const top = rowOfLine(active, head.line) * ROW_HEIGHT;
    if (top < el.scrollTop) scrollTo(top);
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) scrollTo(top + ROW_HEIGHT - el.clientHeight);
    const x = textLeft + visualColumn(linesOf(active)[head.line] ?? '', head.col, TAB_SIZE) * cw;
    const margin = 4 * cw;
    if (x < el.scrollLeft + textLeft) scrollLeftTo(Math.max(0, x - textLeft - margin));
    else if (x > el.scrollLeft + el.clientWidth - margin) scrollLeftTo(x - el.clientWidth + margin);
  });

  /** Replaces the active side's selection with `text`. */
  const insert = (text: string, group?: string) => {
    if (props.readOnly) return;
    const side = active;
    const lines = linesOf(side);
    const before = selOf(side);
    const [from, to] = ordered(before);
    const { op, end } = replaceRange(lines, from, to, text);
    const after = caretAt(end);
    onEdit(side, op, { before, after, group });
    select(side, after, { reveal: true });
  };

  /** Deletes the selection, or the text between the caret and `target` when there is none. */
  const deleteTo = (target: (head: Pos, lines: readonly string[]) => Pos, group: string) => {
    if (props.readOnly) return;
    const side = active;
    const lines = linesOf(side);
    const before = selOf(side);
    if (!isCaret(before)) return insert('', group);
    const t = clampPos(lines, target(before.head, lines));
    if (t.line === before.head.line && t.col === before.head.col) return;
    const [from, to] = ordered({ anchor: before.head, head: t });
    const { op, end } = replaceRange(lines, from, to, '');
    const after = caretAt(end);
    onEdit(side, op, { before, after, group });
    select(side, after, { reveal: true });
  };

  const undoRedo = (which: 'undo' | 'redo' | Side) => {
    if (props.readOnly) return;
    const r = which === 'undo' ? props.onUndo() : which === 'redo' ? props.onRedo() : props.onUndoSide(which);
    const what = which === 'redo' ? 'Redo' : which === 'undo' ? 'Undo' : `Undo on the ${which === 'a' ? 'left' : 'right'}`;
    if (!r) return log.debug('edit', `${what}: nothing to ${which === 'redo' ? 'redo' : 'undo'}`);
    log.info('edit', what, { side: r.side === 'a' ? 'left' : 'right', line: r.op.start + 1 });
    setActive(r.side);
    inputs[r.side].current?.focus({ preventScroll: true });
    // Show where the change happened. The remembered selection is right for typing, but for a
    // merge it is wherever the caret happened to be on that side (often line 1), so it is only
    // used when it lies within the changed lines. Revealing scrolls only if that spot is off-screen.
    const first = r.op.start;
    const last = r.op.start + Math.max(0, r.op.inserted.length - 1);
    const head = r.selection.head.line;
    select(r.side, head >= first && head <= last ? r.selection : caretAt({ line: first, col: 0 }), { reveal: true });
  };

  /** Jumps to the next or previous change block relative to the caret on the active side. */
  const goToDifference = (direction: 1 | -1) => {
    const side = active;
    const index = side === 'a' ? rows.a : rows.b;
    const caretLine = selOf(side).head.line;
    // Still where the last jump put the caret: measure from that block, not the caret's row
    // (on the side without lines in the block, the caret sits on the line after it, and
    // stepping back would find the same block again).
    const nav = lastJump.current;
    const caretRow =
      nav && nav.side === side && nav.line === caretLine && nav.row < rows.count
        ? nav.row
        : linesOf(side).length
          ? rowOfLine(side, caretLine)
          : 0;
    const isChange = (i: number) => blocks[i].kind !== 'equal' && blocks[i].kind !== 'unimportant';
    let target = -1;
    if (direction === 1) {
      for (let i = 0; i < blocks.length && target < 0; i++) if (isChange(i) && rows.blockStart[i] > caretRow) target = i;
    } else {
      for (let i = blocks.length - 1; i >= 0 && target < 0; i--) {
        const end = i + 1 < blocks.length ? rows.blockStart[i + 1] : rows.count;
        if (isChange(i) && end <= caretRow) target = i;
      }
    }
    if (target < 0) return log.debug('view', `No ${direction === 1 ? 'next' : 'previous'} difference`);
    log.info('view', direction === 1 ? 'Next difference' : 'Previous difference', { block: target });
    const startRow = rows.blockStart[target];
    // Put the caret on the block's first line on this side, or where its lines would go.
    let r = startRow;
    while (r < rows.count && index[r] < 0) r++;
    const line = r < rows.count ? index[r] : Math.max(0, linesOf(side).length - 1);
    select(side, caretAt({ line, col: 0 }));
    lastJump.current = { side, line, row: startRow };
    setLanded((prev) => ({ block: target, side, line, flash: (prev?.flash ?? 0) + 1 }));
    const el = refs[side].current;
    if (el) scrollTo(scrollTopForRow(startRow, ROW_HEIGHT, el.clientHeight, rows.count, 1 / 3));
    scrollLeftTo(0);
  };

  useImperativeHandle(props.handleRef, () => ({
    undo: () => undoRedo('undo'),
    redo: () => undoRedo('redo'),
    selectAll: () => {
      const lines = linesOf(active);
      const last = Math.max(0, lines.length - 1);
      select(active, { anchor: { line: 0, col: 0 }, head: clampPos(lines, { line: last, col: Infinity }) });
    },
    goToDifference,
    activeSide: () => active,
    scrollTop: () => refs[leader.current].current?.scrollTop ?? 0,
  }));

  useLayoutEffect(() => {
    const top = props.restoreScroll.current;
    props.restoreScroll.current = null;
    if (top) scrollTo(top);
  }, []);

  /** The merge button being hovered or focused, previewed in both panes. */
  /**
   * The difference F7 or the toolbar arrows moved to, outlined in both panes (with a flash on
   * arrival) so it's obvious where it is. It stays while the caret is where the jump put it;
   * clicking elsewhere, typing or a re-diff clears it. `flash` restarts the animation.
   */
  const [landed, setLanded] = useState<{ block: number; side: Side; line: number; flash: number } | null>(null);
  useEffect(() => setLanded(null), [blocks]);
  const landedHere = landed && blocks[landed.block] && selOf(landed.side).head.line === landed.line && isCaret(selOf(landed.side)) ? landed : null;
  const landedRows = landedHere && {
    first: rows.blockStart[landedHere.block],
    last: landedHere.block + 1 < blocks.length ? rows.blockStart[landedHere.block + 1] : rows.count,
    flash: landedHere.flash,
  };
  const landedIndex = landedHere ? blocks.slice(0, landedHere.block + 1).filter((b) => b.kind !== 'equal' && b.kind !== 'unimportant').length : 0;
  const changeCount = useMemo(() => blocks.filter((b) => b.kind !== 'equal' && b.kind !== 'unimportant').length, [blocks]);
  const { onLandedChange } = props;
  useEffect(() => onLandedChange?.(landedHere ? { index: landedIndex, total: changeCount } : null), [landedIndex, changeCount, !!landedHere, onLandedChange]);
  useEffect(() => () => onLandedChange?.(null), [onLandedChange]);

  const [mergePreview, setMergePreview] = useState<{ block: number; from: Side } | null>(null);
  useEffect(() => setMergePreview(null), [blocks]);
  /** This pane's part in the previewed merge: the change's rows, and whether it's copied from or changed. */
  const previewFor = (side: Side) => {
    if (!mergePreview || !blocks[mergePreview.block]) return null;
    const i = mergePreview.block;
    const first = rows.blockStart[i];
    const last = i + 1 < blocks.length ? rows.blockStart[i + 1] : rows.count;
    const src = mergePreview.from === 'a' ? blocks[i].a : blocks[i].b;
    // Removing lines (nothing to copy from this side): only the side that changes is outlined.
    if (side === mergePreview.from && src.end === src.start) return null;
    return { first, last, role: side === mergePreview.from ? ('source' as const) : ('target' as const) };
  };

  const merge = (block: number, from: Side) => {
    if (props.readOnly) return;
    const to = other(from);
    const op = mergeOp(blocks[block], from, linesOf(from), linesOf(to));
    if (op.removed.length === 0 && op.inserted.length === 0) return;
    log.info('merge', `Copied a change to the ${to === 'a' ? 'left' : 'right'}`, {
      kind: blocks[block].kind,
      line: op.start + 1,
      removed: op.removed.length,
      inserted: op.inserted.length,
    });
    const before = selOf(to);
    const after = { anchor: transformPos(before.anchor, op), head: transformPos(before.head, op) };
    onEdit(to, op, { before, after, immediate: true });
    select(to, after);
  };

  // ---- Keyboard --------------------------------------------------------------------------

  const onKeyDown = (side: Side) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // keyCode 229: the key that ends a composition in WebKit, which fires compositionend first.
    if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'Escape' && pendingAlign) {
      setPendingAlign(null);
      e.preventDefault();
      return;
    }
    const lines = linesOf(side);
    const sel = selOf(side);
    const { head } = sel;
    const text = lines[head.line] ?? '';
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const byWord = isMac ? e.altKey : e.ctrlKey;
    const extend = e.shiftKey;
    const lastLine = Math.max(0, lines.length - 1);
    const pageLines = Math.max(1, Math.floor((refs[side].current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);

    const moveTo = (p: Pos, keepGoal = false) => {
      const target = clampPos(lines, p);
      select(side, extend ? { anchor: sel.anchor, head: target } : caretAt(target), { reveal: true, keepGoal });
      props.onSealHistory();
    };
    const vertical = (delta: number) => {
      if (goalColumn.current === null) goalColumn.current = visualColumn(text, head.col, TAB_SIZE);
      const line = head.line + delta;
      if (line < 0) return moveTo({ line: 0, col: 0 }, true);
      if (line > lastLine) return moveTo({ line: lastLine, col: (lines[lastLine] ?? '').length }, true);
      moveTo({ line, col: colAtVisual(lines[line], goalColumn.current, TAB_SIZE) }, true);
    };
    const [selStart, selEnd] = ordered(sel);

    switch (e.key) {
      case 'ArrowLeft':
        if (!extend && !isCaret(sel)) moveTo(selStart);
        else if (isMac && e.metaKey) moveTo({ line: head.line, col: 0 });
        else if (head.col === 0) moveTo(head.line > 0 ? { line: head.line - 1, col: lines[head.line - 1].length } : head);
        else moveTo({ line: head.line, col: byWord ? wordLeft(text, head.col) : prevChar(text, head.col) });
        break;
      case 'ArrowRight':
        if (!extend && !isCaret(sel)) moveTo(selEnd);
        else if (isMac && e.metaKey) moveTo({ line: head.line, col: text.length });
        else if (head.col >= text.length) moveTo(head.line < lastLine ? { line: head.line + 1, col: 0 } : head);
        else moveTo({ line: head.line, col: byWord ? wordRight(text, head.col) : nextChar(text, head.col) });
        break;
      case 'ArrowUp':
        if (isMac && e.metaKey) moveTo({ line: 0, col: 0 });
        else vertical(-1);
        break;
      case 'ArrowDown':
        if (isMac && e.metaKey) moveTo({ line: lastLine, col: Infinity });
        else vertical(1);
        break;
      case 'PageUp':
        vertical(-pageLines);
        break;
      case 'PageDown':
        vertical(pageLines);
        break;
      case 'Home': {
        if (mod) moveTo({ line: 0, col: 0 });
        else {
          // Toggle between the first non-blank character and the start of the line.
          const indent = text.length - text.trimStart().length;
          moveTo({ line: head.line, col: head.col === indent ? 0 : indent });
        }
        break;
      }
      case 'End':
        moveTo(mod ? { line: lastLine, col: Infinity } : { line: head.line, col: text.length });
        break;
      case 'Backspace':
        if (isMac && e.metaKey) deleteTo((h) => ({ line: h.line, col: 0 }), 'delete');
        else
          deleteTo(
            (h, ls) =>
              h.col > 0
                ? { line: h.line, col: byWord ? wordLeft(ls[h.line], h.col) : prevChar(ls[h.line], h.col) }
                : h.line > 0
                  ? { line: h.line - 1, col: ls[h.line - 1].length }
                  : h,
            'delete',
          );
        break;
      case 'Delete':
        deleteTo(
          (h, ls) =>
            h.col < (ls[h.line] ?? '').length
              ? { line: h.line, col: byWord ? wordRight(ls[h.line], h.col) : nextChar(ls[h.line], h.col) }
              : h.line < ls.length - 1
                ? { line: h.line + 1, col: 0 }
                : h,
          'delete',
        );
        break;
      case 'Enter': {
        // Keep the current line's indentation.
        const indent = /^[ \t]*/.exec(text.slice(0, head.col))![0];
        insert('\n' + indent);
        break;
      }
      case 'Tab': {
        if (e.shiftKey) break;
        const usesTabs = lines.some((l) => l.startsWith('\t'));
        const v = visualColumn(text, selStart.col, TAB_SIZE);
        insert(usesTabs ? '\t' : ' '.repeat(TAB_SIZE - (v % TAB_SIZE)), 'type');
        break;
      }
      case 'z':
      case 'Z':
        if (!mod) return;
        undoRedo(e.shiftKey ? 'redo' : 'undo');
        break;
      case 'y':
        if (!mod || isMac) return;
        undoRedo('redo');
        break;
      case 'a':
        if (!mod) return;
        select(side, { anchor: { line: 0, col: 0 }, head: clampPos(lines, { line: lastLine, col: Infinity }) });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    if (composing.current) return;
    const ta = e.currentTarget;
    const text = ta.value;
    ta.value = '';
    if (text) insert(text, 'type');
  };
  // While composing, the input shows the text being composed at the caret (it's invisible otherwise).
  const onCompositionStart = (e: { currentTarget: HTMLTextAreaElement }) => {
    composing.current = true;
    e.currentTarget.classList.add('composing');
  };
  const onCompositionEnd = (e: { currentTarget: HTMLTextAreaElement }) => {
    composing.current = false;
    const ta = e.currentTarget;
    ta.classList.remove('composing');
    const text = ta.value;
    ta.value = '';
    if (text) insert(text, 'type');
  };

  const selectedText = (side: Side) => {
    const [from, to] = ordered(selOf(side));
    return textInRange(linesOf(side), from, to);
  };
  const onCopy = (side: Side) => (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    if (!isCaret(selOf(side))) e.clipboardData.setData('text/plain', selectedText(side));
  };
  const onCut = (side: Side) => (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    if (isCaret(selOf(side))) return;
    e.clipboardData.setData('text/plain', selectedText(side));
    insert('');
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) insert(text);
  };

  // ---- Mouse -----------------------------------------------------------------------------

  /** Document position under a point; clicks on filler rows land on the next real line. */
  const posAt = (side: Side, clientX: number, clientY: number): Pos => {
    const el = refs[side].current!;
    const lines = linesOf(side);
    if (lines.length === 0 || rows.count === 0) return { line: 0, col: 0 };
    const rect = el.getBoundingClientRect();
    const row = Math.min(rows.count - 1, Math.max(0, Math.floor((clientY - rect.top + el.scrollTop) / ROW_HEIGHT)));
    const index = side === 'a' ? rows.a : rows.b;
    if (index[row] < 0) {
      let r = row;
      while (r < rows.count && index[r] < 0) r++;
      if (r < rows.count) return { line: index[r], col: 0 };
      r = row;
      while (r >= 0 && index[r] < 0) r--;
      return { line: index[r], col: lines[index[r]].length };
    }
    const line = index[row];
    const x = clientX - rect.left < lineNumberWidth ? 0 : clientX - rect.left + el.scrollLeft - textLeft;
    return { line, col: colAtVisual(lines[line], Math.max(0, x) / cw, TAB_SIZE) };
  };

  // ---- Manual alignment ------------------------------------------------------------------

  /** First half of an alignment: a line picked on one side, waiting for its partner. */
  const [pendingAlign, setPendingAlign] = useState<{ side: Side; line: number } | null>(null);
  // An edit can move the picked line, so it cancels a half-made alignment.
  useEffect(() => setPendingAlign(null), [versions]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const lineLabel = (side: Side, line: number) => `${side === 'a' ? 'left' : 'right'} line ${line + 1}`;

  const onContextMenu = (side: Side) => (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (linesOf(side).length === 0) return;
    const { line } = posAt(side, e.clientX, e.clientY);
    const items: MenuItem[] = [];
    if (pendingAlign && pendingAlign.side !== side) {
      const p = pendingAlign;
      items.push({
        label: `Align with ${lineLabel(p.side, p.line)}`,
        run: () => {
          const [a, b] = side === 'a' ? [line, p.line] : [p.line, line];
          log.info('edit', 'Aligned lines', { left: a + 1, right: b + 1 });
          setPendingAlign(null);
          props.onAlign(a, b);
        },
      });
    } else {
      items.push({
        label: `Align ${lineLabel(side, line)} with…`,
        run: () => {
          log.debug('edit', 'Choosing a line to align with', { side: side === 'a' ? 'left' : 'right', line: line + 1 });
          setPendingAlign({ side, line });
        },
      });
    }
    if (pendingAlign) items.push({ label: 'Cancel alignment', run: () => setPendingAlign(null) });
    if (props.anchors.some((x) => x[side] === line)) {
      items.push({
        label: 'Remove this alignment',
        run: () => {
          log.info('edit', 'Removed an alignment', { side: side === 'a' ? 'left' : 'right', line: line + 1 });
          props.onUnalign(side, line);
        },
      });
    }
    if (props.anchors.length > 0) {
      items.push({
        label: 'Clear all alignments',
        run: () => {
          log.info('edit', 'Cleared all alignments', { count: props.anchors.length });
          props.onClearAlignments();
        },
      });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const anchoredLines = useMemo(
    () => ({ a: new Set(props.anchors.map((x) => x.a)), b: new Set(props.anchors.map((x) => x.b)) }),
    [props.anchors],
  );

  const drag = useRef<{ side: Side; anchor: Pos } | null>(null);
  // Pointer events always report detail 0, so double and triple clicks are counted here.
  const lastClick = useRef({ time: 0, x: 0, y: 0, count: 0 });

  const onPointerDown = (side: Side) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = refs[side].current!;
    const rect = el.getBoundingClientRect();
    // Leave presses on the scrollbars to the browser.
    if (e.clientX - rect.left >= el.clientWidth || e.clientY - rect.top >= el.clientHeight) return;
    e.preventDefault();
    inputs[side].current?.focus({ preventScroll: true });
    setActive(side);
    props.onSealHistory();

    const prev = lastClick.current;
    const near = Math.abs(e.clientX - prev.x) < 4 && Math.abs(e.clientY - prev.y) < 4;
    const clicks = near && e.timeStamp - prev.time < MULTI_CLICK_MS ? prev.count + 1 : 1;
    lastClick.current = { time: e.timeStamp, x: e.clientX, y: e.clientY, count: clicks };

    const lines = linesOf(side);
    const pos = posAt(side, e.clientX, e.clientY);
    let s: Selection;
    if (clicks === 2 && lines.length) {
      const [ws, we] = wordAt(lines[pos.line], pos.col);
      s = { anchor: { line: pos.line, col: ws }, head: { line: pos.line, col: we } };
    } else if (clicks >= 3 && lines.length) {
      const end = pos.line + 1 < lines.length ? { line: pos.line + 1, col: 0 } : { line: pos.line, col: lines[pos.line].length };
      s = { anchor: { line: pos.line, col: 0 }, head: end };
    } else if (e.shiftKey) {
      s = { anchor: selOf(side).anchor, head: pos };
    } else {
      s = caretAt(pos);
    }
    select(side, s);
    el.setPointerCapture(e.pointerId);
    drag.current = { side, anchor: s.anchor };
  };

  const onPointerMove = (side: Side) => (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.side !== side) return;
    const el = refs[side].current!;
    const rect = el.getBoundingClientRect();
    // Dragging past the top or bottom edge scrolls.
    if (e.clientY < rect.top) scrollTo(Math.max(0, el.scrollTop - ROW_HEIGHT));
    else if (e.clientY > rect.top + el.clientHeight) scrollTo(el.scrollTop + ROW_HEIGHT);
    select(side, { anchor: d.anchor, head: posAt(side, e.clientX, e.clientY) });
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  // ---- Layout ----------------------------------------------------------------------------

  // Render the viewport's bands plus one band of margin above and below.
  const first = Math.max(0, (band - 1) * BAND_ROWS);
  const last = Math.min(rows.count, (band + 2 + Math.ceil(viewportHeight / (BAND_ROWS * ROW_HEIGHT))) * BAND_ROWS);
  // Columns likewise, for long lines: the viewport's bands plus one either side.
  const firstCol = Math.floor((Math.max(0, hBand - 1) * BAND_WIDTH) / cw);
  const lastCol = Math.ceil(((hBand + 2) * BAND_WIDTH + Math.max(paneWidths.a, paneWidths.b)) / cw);
  const style = {
    font: FONT,
    gridTemplateColumns: `minmax(0, ${split}fr) ${GUTTER_WIDTH}px minmax(0, ${1 - split}fr) ${OVERVIEW_WIDTH}px`,
    gridTemplateRows: 'auto 1fr auto auto',
    '--row-height': `${ROW_HEIGHT}px`,
    '--tab-size': TAB_SIZE,
  } as CSSProperties;

  const pane = (side: Side) => {
    const sel = selOf(side);
    return (
      <Pane
        side={side}
        lines={linesOf(side)}
        rows={rows}
        first={first}
        last={last}
        firstCol={firstCol}
        lastCol={lastCol}
        // Each pane is widened by however much wider it is than the narrower one, so both can
        // scroll exactly as far sideways and the horizontal sync stays exact.
        contentWidth={contentWidth + paneWidths[side] - Math.min(paneWidths.a, paneWidths.b)}
        lineNumberWidth={lineNumberWidth}
        charWidth={cw}
        intraLine={intraLine}
        selection={sel}
        caretRow={linesOf(side).length ? rowOfLine(side, sel.head.line) : -1}
        placeholder={linesOf(side).length === 0 ? props.placeholders[side] : undefined}
        showCaret={focused && active === side}
        scrollRef={refs[side]}
        inputRef={inputs[side]}
        onScroll={onScroll(side)}
        onInteract={lead(side)}
        onPointerDown={onPointerDown(side)}
        onPointerMove={onPointerMove(side)}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu(side)}
        anchoredLines={anchoredLines[side]}
        mergePreview={previewFor(side)}
        landed={landedRows || null}
        pendingLine={pendingAlign?.side === side ? pendingAlign.line : -1}
        inputHandlers={{
          onKeyDown: onKeyDown(side),
          onInput,
          onCompositionStart,
          onCompositionEnd,
          onCopy: onCopy(side),
          onCut: onCut(side),
          onPaste,
          onFocus: () => {
            setActive(side);
            setFocused(true);
          },
          onBlur: () => setFocused(false),
        }}
      />
    );
  };

  // The line pair at the caret, shown in full in the details strip at the bottom.
  const detailRow = rows.count ? Math.min(rows.count - 1, rowOfLine(active, selOf(active).head.line)) : -1;
  const detail = (side: Side) => {
    const line = detailRow < 0 ? -1 : (side === 'a' ? rows.a : rows.b)[detailRow];
    const kind = detailRow < 0 ? RowKind.Equal : (rows.kind[detailRow] as RowKind);
    const ranges = kind === RowKind.Modified || kind === RowKind.Unimportant ? (intraLine(detailRow)?.[side] ?? []) : [];
    return {
      number: line < 0 ? null : line + 1,
      text: line < 0 ? '' : linesOf(side)[line],
      ranges,
      highlight: kind === RowKind.Unimportant ? 'chg-minor' : side === 'a' ? 'chg-del' : 'chg-ins',
    };
  };

  const fileStatus = (side: Side) => (
    <FileStatus
      side={side}
      details={props.fileDetails[side]}
      lines={linesOf(side).length}
      trailingNewline={props.docs[side].trailingNewline}
      edited={props.isEdited(side)}
      differs={props.conventionsDiffer}
      prettified={!!props.readOnly}
    />
  );

  const header = (side: Side) => (
    <div className="pane-header">
      <span className="pane-title" title={props.paths[side] ?? props.labels[side]}>
        {props.paths[side] && (
          // The folder gives way first, cut from the left, so the file name stays visible.
          <span className="pane-dir">
            <bdi>{splitPath(tildePath(props.paths[side]!, props.homeDir)).dir}</bdi>
          </span>
        )}
        <span className="pane-name">{props.labels[side]}</span>
      </span>
      {props.isEdited(side) && <span className="edited">(edited)</span>}
      <button
        type="button"
        className="header-button header-icon"
        onClick={() => props.onSave(side)}
        disabled={!props.isEdited(side) || !!props.readOnly}
        title={props.readOnly ?? (props.isEdited(side) ? `Save the ${side === 'a' ? 'left' : 'right'} file` : 'No unsaved changes')}
        aria-label={`Save the ${side === 'a' ? 'left' : 'right'} file`}
      >
        <SaveIcon />
      </button>
      <button
        type="button"
        className="header-button header-icon"
        onClick={() => undoRedo(side)}
        disabled={!props.canUndo(side) || !!props.readOnly}
        title={props.readOnly ?? `Undo the last change to the ${side === 'a' ? 'left' : 'right'} side`}
        aria-label={`Undo the last change to the ${side === 'a' ? 'left' : 'right'} side`}
      >
        <UndoIcon />
      </button>
    </div>
  );

  return (
    <div className="diff-view" ref={rootRef} style={style}>
      {header('a')}
      <div className="pane-header gutter-header" />
      {header('b')}
      <div className="pane-header overview-header" />
      {pane('a')}
      <Gutter
        rows={rows}
        blocks={blocks}
        theme={theme}
        first={first}
        last={last}
        mergeEnabled={fresh && !props.readOnly}
        mergeDisabledReason={props.readOnly}
        onMerge={merge}
        onMergePreview={setMergePreview}
        anchors={props.anchors}
        getScrollTop={getScrollTop}
        handleRef={gutter}
        onDividerDrag={(x) => {
          const rect = rootRef.current?.getBoundingClientRect();
          if (rect) setSplit(ratioAt(x, rect, GUTTER_WIDTH + OVERVIEW_WIDTH, GUTTER_WIDTH));
        }}
        onDividerReset={() => setSplit(0.5)}
      />
      {pane('b')}
      <Overview
        rows={rows}
        blocks={blocks}
        theme={theme}
        getViewport={getViewport}
        onJump={scrollTo}
        handleRef={overview}
      />
      {fileStatus('a')}
      <div className="file-status gutter-status" />
      {fileStatus('b')}
      <div className="file-status overview-status" />
      <LineDetails left={detail('a')} right={detail('b')} charWidth={cw} rowKey={detailRow < 0 ? '' : `${detailRow}:${rows.a[detailRow]}:${rows.b[detailRow]}`} />
      {pendingAlign && (
        <div className="align-hint" role="status">
          Right-click a line in the {pendingAlign.side === 'a' ? 'right' : 'left'} pane to align it with{' '}
          {lineLabel(pendingAlign.side, pendingAlign.line)}. Esc cancels.
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

/** Offset of the previous character boundary, stepping over surrogate pairs. */
function prevChar(text: string, col: number): number {
  const c = text.charCodeAt(col - 1);
  return c >= 0xdc00 && c <= 0xdfff && col >= 2 ? col - 2 : col - 1;
}

/** Offset of the next character boundary, stepping over surrogate pairs. */
function nextChar(text: string, col: number): number {
  const c = text.charCodeAt(col);
  return c >= 0xd800 && c <= 0xdbff && col + 1 < text.length ? col + 2 : col + 1;
}
