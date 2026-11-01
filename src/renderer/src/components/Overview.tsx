import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, type PointerEvent, type Ref } from 'react';
import type { DiffBlock } from '../../../engine';
import { markAt, overviewMarks, rowAtY, scrollTopForRow } from '../model/overview';
import { RowKind, type RowModel } from '../model/rowModel';
import { cssVar, prepareCanvas, useElementSize } from './canvas';
import { ROW_HEIGHT } from './layout';

export interface OverviewHandle {
  /** Moves the visible-region box. Called straight from the scroll handler. */
  setViewport(scrollTop: number, viewportHeight: number): void;
}

interface OverviewProps {
  rows: RowModel;
  blocks: readonly DiffBlock[];
  theme: string;
  getViewport: () => { scrollTop: number; height: number };
  onJump: (scrollTop: number) => void;
  handleRef: Ref<OverviewHandle>;
}

const MARK_COLORS: Record<RowKind, string> = {
  [RowKind.Equal]: '',
  [RowKind.Unimportant]: '--chg-minor',
  [RowKind.Modified]: '--stat-mod',
  [RowKind.Inserted]: '--stat-ins',
  [RowKind.Deleted]: '--stat-del',
  // Replaced rows are drawn as a deletion beside an insertion (see overviewMarks).
  [RowKind.Replaced]: '',
};

/** Where a clicked change lands in the viewport: a third of the way down, leaving context above. */
const CHANGE_ANCHOR = 1 / 3;
const MIN_VIEWPORT_BOX = 6;
/** Pointer travel (px) before a press turns into a drag. */
const DRAG_THRESHOLD = 3;

/**
 * The whole file at a glance. The left half shows the left file's changes, the right half the
 * right file's. Clicking a mark jumps to that change; clicking elsewhere centres that row;
 * dragging scrubs through the file.
 */
export function Overview({ rows, blocks, theme, getViewport, onJump, handleRef }: OverviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(rootRef);
  const marks = useMemo(() => overviewMarks(rows, blocks, height), [rows, blocks, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas && prepareCanvas(canvas, width, height);
    if (!ctx) return;
    const colors = Object.fromEntries(Object.entries(MARK_COLORS).map(([k, v]) => [k, v && cssVar(v)]));
    const half = width / 2;
    for (const m of marks) {
      ctx.fillStyle = colors[m.kind];
      const x = m.side === 'b' ? half + 1 : 2;
      const w = m.side === 'both' ? width - 4 : half - 3;
      ctx.fillRect(x, m.y, w, m.h);
    }
  }, [marks, width, height, theme]);

  const setViewport = useCallback(
    (scrollTop: number, viewportHeight: number) => {
      const box = boxRef.current;
      const total = rows.count * ROW_HEIGHT;
      if (!box || total === 0 || height === 0) return;
      const top = (scrollTop / total) * height;
      const h = Math.max(MIN_VIEWPORT_BOX, Math.min(height, (viewportHeight / total) * height));
      box.style.transform = `translateY(${Math.min(top, height - h)}px)`;
      box.style.height = `${h}px`;
    },
    [rows, height],
  );

  useImperativeHandle(handleRef, () => ({ setViewport }), [setViewport]);

  useEffect(() => {
    const { scrollTop, height: vh } = getViewport();
    setViewport(scrollTop, vh);
  }, [setViewport, getViewport]);

  const drag = useRef<{ startY: number; dragging: boolean } | null>(null);
  const localY = (e: PointerEvent) => e.clientY - rootRef.current!.getBoundingClientRect().top;
  const centreOn = (y: number) => {
    const row = rowAtY(y, height, rows.count);
    onJump(scrollTopForRow(row, ROW_HEIGHT, getViewport().height, rows.count, 0.5));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const y = localY(e);
    drag.current = { startY: y, dragging: false };
    const mark = markAt(marks, y);
    if (mark) onJump(scrollTopForRow(mark.row, ROW_HEIGHT, getViewport().height, rows.count, CHANGE_ANCHOR));
    else centreOn(y);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const y = localY(e);
    if (!d.dragging && Math.abs(y - d.startY) < DRAG_THRESHOLD) return;
    d.dragging = true;
    centreOn(y);
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      ref={rootRef}
      className="overview"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title="Overview: click a change to jump to it, or drag to scroll"
    >
      <canvas ref={canvasRef} />
      <div ref={boxRef} className="overview-viewport" />
    </div>
  );
}
