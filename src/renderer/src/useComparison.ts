import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { splitLines, type Anchor, type DiffBlock, type LineDiffOptions, type SplitText } from '../../engine';
import { addAnchor, removeAnchor, transformAnchors } from './model/anchors';
import { patchRows, type RowModel, type Side } from './model/rowModel';
import { applyOp, invertOp, type EditOp, type Selection } from './model/textEdit';
import { UndoHistory, type UndoEntry } from './model/undo';
import { useDiff, type DiffInput } from './useDiff';
import type { EolCounts, LineEnding, TextEncoding } from '../../shared/api';

/**
 * An open text. `lines` is edited in place for speed on large files; `version` changes on
 * every edit and is what React dependencies and diff results are keyed on.
 */
export interface Doc {
  lines: string[];
  eol: SplitText['eol'];
  trailingNewline: boolean;
  version: number;
}

export type Docs = Record<Side, Doc>;

export interface EditMeta {
  /** Selections before and after the edit, restored by undo and redo. */
  before: Selection;
  after: Selection;
  /** Consecutive edits with the same group (e.g. `'type'`) undo as one step. */
  group?: string;
  /** Re-diff now rather than after the typing pause (used for merges). */
  immediate?: boolean;
}

/** What a side shows. A new `id` means a new document (a file was opened or reloaded). */
export interface Source {
  id: number;
  /** Shown in the pane header. */
  label: string;
  text: string;
  /** Present when the text came from disk; needed to save it back the same way. */
  file?: {
    path: string;
    encoding: TextEncoding;
    eol: LineEnding;
    mtimeMs: number;
    /** For the status line under the pane: as last read or saved. */
    size: number;
    eolCounts: EolCounts;
    asciiOnly: boolean;
  };
  /** For a file that exists in only one compared folder: where saving this side creates it. */
  missingPath?: string;
}

let sourceCounter = 0;
export const newSourceId = () => ++sourceCounter;

/** Re-diff once typing has paused this long. */
export const REDIFF_DELAY_MS = 300;

let versionCounter = 0;

function makeDoc(text: string): Doc {
  const s = splitLines(text);
  const version = ++versionCounter;
  return { lines: s.lines, eol: s.eol, trailingNewline: s.trailingNewline, version };
}

const tagOf = (docs: Docs, anchors: Anchor[]) =>
  `${docs.a.version}:${docs.b.version}:${anchors.map((x) => `${x.a}-${x.b}`).join(',')}`;

/** Terminates every line, so the worker splits back exactly the same lines (even a trailing empty one). */
const toDiffText = (lines: readonly string[]) => (lines.length ? lines.join('\n') + '\n' : '');

const toInput = (docs: Docs, anchors: Anchor[]): DiffInput => ({
  left: toDiffText(docs.a.lines),
  right: toDiffText(docs.b.lines),
  anchors,
  tag: tagOf(docs, anchors),
});

interface View {
  docs: Docs;
  rows: RowModel;
  blocks: DiffBlock[];
  /** False between an edit and the re-diff that accounts for it. */
  fresh: boolean;
}

/**
 * Owns the two documents, their shared undo history and the diff of them. Edits apply
 * immediately and patch the row layout locally; the real re-diff runs after a short pause
 * and its result is only accepted if no edit has happened since it was requested.
 */
export function useComparison(left: Source, right: Source, options: LineDiffOptions) {
  const docA = useMemo(() => makeDoc(left.text), [left.id]);
  const docB = useMemo(() => makeDoc(right.text), [right.id]);
  const docs = useMemo<Docs>(() => ({ a: docA, b: docB }), [docA, docB]);
  const history = useMemo(() => new UndoHistory(), []);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // Manual alignments. The ref is what edits transform synchronously; the state re-renders.
  const anchorsRef = useRef<Anchor[]>([]);
  const [anchors, setAnchorsState] = useState<Anchor[]>([]);
  const setAnchors = (next: Anchor[]) => {
    anchorsRef.current = next;
    setAnchorsState(next);
  };

  // Where each side's history stood when it was opened or last saved. A side is unsaved
  // exactly when its history has moved from there, so undoing back to it makes it clean again.
  const savedAt = useRef<Record<Side, UndoEntry | null>>({ a: null, b: null });

  // A newly opened document invalidates that side's undo history and every alignment.
  useEffect(() => {
    history.dropSide('a');
    savedAt.current.a = null;
    setAnchors([]);
  }, [docA, history]);
  useEffect(() => {
    history.dropSide('b');
    savedAt.current.b = null;
    setAnchors([]);
  }, [docB, history]);

  const timer = useRef<number | undefined>(undefined);
  const [input, setInput] = useState<DiffInput>(() => toInput(docs, []));
  const initialDocs = useRef(docs);
  useEffect(() => {
    // A re-diff still scheduled for the old documents would supersede this one; cancel it.
    window.clearTimeout(timer.current);
    // The initial input already covers the first documents; diffing them again doubles the wait.
    if (docs !== initialDocs.current) setInput(toInput(docs, anchorsRef.current));
  }, [docs]);
  const diff = useDiff(input, options);

  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    if (diff.result && diff.rows && diff.tag === tagOf(docs, anchorsRef.current)) {
      setView({ docs, rows: diff.rows, blocks: diff.result.blocks, fresh: true });
    }
  }, [diff.result, diff.rows, diff.tag, docs]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  const scheduleDiff = useCallback(
    (immediate: boolean) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setInput(toInput(docs, anchorsRef.current)), immediate ? 0 : REDIFF_DELAY_MS);
    },
    [docs],
  );

  const apply = useCallback(
    (side: Side, op: EditOp) => {
      applyOp(docs[side].lines, op);
      docs[side].version = ++versionCounter;
      const moved = transformAnchors(anchorsRef.current, side, op);
      if (moved !== anchorsRef.current) setAnchors(moved);
      setView((v) =>
        v && v.docs === docs
          ? { ...v, rows: patchRows(v.rows, side, op.start, op.removed.length, op.inserted.length), fresh: false }
          : v,
      );
      rerender();
    },
    [docs],
  );

  const edit = useCallback(
    (side: Side, op: EditOp, meta: EditMeta) => {
      apply(side, op);
      history.push({ side, op, before: meta.before, after: meta.after, group: meta.group, time: Date.now() });
      scheduleDiff(meta.immediate ?? false);
    },
    [apply, history, scheduleDiff],
  );

  /** Reverts the last edit on either side; returns where to put the selection. */
  const undo = useCallback(() => {
    const e = history.undo();
    if (!e) return null;
    const op = invertOp(e.op);
    apply(e.side, op);
    scheduleDiff(false);
    return { side: e.side, selection: e.before, op };
  }, [apply, history, scheduleDiff]);

  /** Reverts the last edit on one side only. */
  const undoSide = useCallback(
    (side: Side) => {
      const e = history.undoSide(side);
      if (!e) return null;
      const op = invertOp(e.op);
      apply(e.side, op);
      scheduleDiff(false);
      return { side: e.side, selection: e.before, op };
    },
    [apply, history, scheduleDiff],
  );

  const redo = useCallback(() => {
    const e = history.redo();
    if (!e) return null;
    apply(e.side, e.op);
    scheduleDiff(false);
    return { side: e.side, selection: e.after, op: e.op };
  }, [apply, history, scheduleDiff]);

  const sealHistory = useCallback(() => history.seal(), [history]);

  const align = useCallback(
    (a: number, b: number) => {
      setAnchors(addAnchor(anchorsRef.current, a, b));
      scheduleDiff(true);
    },
    [scheduleDiff],
  );
  const unalign = useCallback(
    (side: Side, line: number) => {
      setAnchors(removeAnchor(anchorsRef.current, side, line));
      scheduleDiff(true);
    },
    [scheduleDiff],
  );
  const clearAlignments = useCallback(() => {
    setAnchors([]);
    scheduleDiff(true);
  }, [scheduleDiff]);

  /** Marks a side as matching what is on disk (after saving it). */
  const markSaved = useCallback(
    (side: Side) => {
      // Typing after a save starts a new undo step, so the saved point stays a fixed entry.
      history.seal();
      savedAt.current[side] = history.lastEntry(side);
      history.resetLost(side);
      rerender();
    },
    [history],
  );

  return {
    docs,
    view: view && view.docs === docs ? view : null,
    stats: diff.result?.stats ?? null,
    busy: diff.busy || !view?.fresh,
    elapsedMs: diff.elapsedMs,
    error: diff.error,
    edit,
    undo,
    undoSide,
    canUndo: (side: Side) => history.canUndo(side),
    /** Whether a side differs from what was last opened or saved. */
    // Unsaved when the history moved from where it was saved, or when trimming (past the undo
    // limit) took away the way back to the opened state.
    isEdited: (side: Side) =>
      history.lastEntry(side) !== savedAt.current[side] || (savedAt.current[side] === null && history.lostStart(side)),
    redo,
    sealHistory,
    markSaved,
    anchors,
    align,
    unalign,
    clearAlignments,
  };
}

export type Comparison = ReturnType<typeof useComparison>;
