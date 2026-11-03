import { useCallback, useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';
import type { Anchor, DiffBlock } from '../../../engine';
import { blockAtRow, visibleConnectors, type Connector } from '../model/gutter';
import type { RowModel, Side } from '../model/rowModel';
import { cssVar, prepareCanvas, useElementSize } from './canvas';
import { MergeIcon } from './icons';
import { mergeTitle } from '../model/merge';
import { ROW_HEIGHT } from './layout';

export interface GutterHandle {
  /** Redraws for a new scroll offset. Called straight from the scroll handler so it never lags a frame. */
  draw(scrollTop: number): void;
}

interface GutterProps {
  rows: RowModel;
  blocks: readonly DiffBlock[];
  /** Changes when the theme does, so the canvas repaints in the new colours. */
  theme: string;
  /** Rendered row window, `[first, last)`, for placing merge buttons. */
  first: number;
  last: number;
  /** Merges need up-to-date block boundaries, so they are disabled until a pending re-diff lands. */
  mergeEnabled: boolean;
  /** Shown on the merge buttons instead of what they'd do, when merging is off for a reason (Prettify). */
  mergeDisabledReason?: string;
  onMerge: (block: number, from: Side) => void;
  /** Hovering or focusing a merge button previews what it would change (null when it ends). */
  onMergePreview: (preview: { block: number; from: Side } | null) => void;
  /** Manual alignments, drawn as links between their rows. */
  anchors: Anchor[];
  getScrollTop: () => number;
  handleRef: Ref<GutterHandle>;
  /** The gutter doubles as the divider between the panes: drag to resize, double-click to reset. */
  onDividerDrag: (clientX: number) => void;
  onDividerReset: () => void;
}

/** Merge buttons: big enough to hit easily, small enough for two to fit side by side in the gutter. */
const BUTTON_HEIGHT = 18;

const COLORS: Record<Connector['kind'], { fill: string; stroke: string }> = {
  insert: { fill: '--row-ins', stroke: '--stat-ins' },
  delete: { fill: '--row-del', stroke: '--stat-del' },
  modify: { fill: '--row-mod', stroke: '--stat-mod' },
};

/**
 * The centre column linking each change on the left to its counterpart on the right. An
 * insertion is drawn as a wedge opening out of the point on the left where the lines would
 * go; a deletion is the mirror image; a modification links the two spans. Each change also
 * gets merge buttons, one by each pane, pointing at the side they change: an arrow copies that
 * side's lines across (replacing the other side's), and an arrow ending in a cross, shown when
 * that side has no lines, removes the other side's. Hovering one previews the effect.
 */
export function Gutter(props: GutterProps) {
  const { rows, blocks, theme, first, last, anchors, getScrollTop, handleRef } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(canvasRef);

  const draw = useCallback(
    (scrollTop: number) => {
      // Buttons sit at absolute row positions inside a layer that moves with the scroll offset.
      if (buttonsRef.current) buttonsRef.current.style.transform = `translateY(${-scrollTop}px)`;
      const canvas = canvasRef.current;
      const ctx = canvas && prepareCanvas(canvas, width, height);
      if (!ctx) return;
      const colors = Object.fromEntries(
        Object.entries(COLORS).map(([k, v]) => [k, { fill: cssVar(v.fill), stroke: cssVar(v.stroke) }]),
      ) as typeof COLORS;
      const mid = width / 2;
      ctx.lineWidth = 1;
      for (const c of visibleConnectors(rows, blocks, scrollTop, height, ROW_HEIGHT)) {
        // Half-pixel offsets keep 1px strokes crisp.
        const aTop = c.aTop + 0.5;
        const aBottom = Math.max(aTop, c.aBottom - 0.5);
        const bTop = c.bTop + 0.5;
        const bBottom = Math.max(bTop, c.bBottom - 0.5);

        ctx.beginPath();
        ctx.moveTo(0, aTop);
        ctx.bezierCurveTo(mid, aTop, mid, bTop, width, bTop);
        ctx.lineTo(width, bBottom);
        ctx.bezierCurveTo(mid, bBottom, mid, aBottom, 0, aBottom);
        ctx.closePath();
        ctx.fillStyle = colors[c.kind].fill;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(0, aTop);
        ctx.bezierCurveTo(mid, aTop, mid, bTop, width, bTop);
        ctx.moveTo(0, aBottom);
        ctx.bezierCurveTo(mid, aBottom, mid, bBottom, width, bBottom);
        ctx.strokeStyle = colors[c.kind].stroke;
        ctx.stroke();
      }

      // Manual alignments: a link from the left line's row to the right line's row. After a
      // re-diff both are the same row; while an edit is pending they may briefly differ.
      ctx.strokeStyle = cssVar('--anchor');
      ctx.fillStyle = cssVar('--anchor');
      ctx.lineWidth = 2;
      for (const anc of anchors) {
        if (anc.a >= rows.aRow.length || anc.b >= rows.bRow.length) continue;
        const ya = (rows.aRow[anc.a] + 0.5) * ROW_HEIGHT - scrollTop;
        const yb = (rows.bRow[anc.b] + 0.5) * ROW_HEIGHT - scrollTop;
        if (Math.max(ya, yb) < -ROW_HEIGHT || Math.min(ya, yb) > height + ROW_HEIGHT) continue;
        ctx.beginPath();
        ctx.moveTo(0, ya);
        ctx.bezierCurveTo(mid, ya, mid, yb, width, yb);
        ctx.stroke();
        for (const [x, y] of [
          [3, ya],
          [width - 3, yb],
        ]) {
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
    [rows, blocks, anchors, width, height],
  );

  useImperativeHandle(handleRef, () => ({ draw }), [draw]);

  useEffect(() => {
    draw(getScrollTop());
  }, [draw, getScrollTop, theme]);

  const buttons: ReactNode[] = [];
  for (let i = blockAtRow(rows.blockStart, first); i < blocks.length && rows.blockStart[i] < last; i++) {
    const kind = blocks[i].kind;
    if (kind !== 'insert' && kind !== 'delete' && kind !== 'modify') continue;
    const top = rows.blockStart[i] * ROW_HEIGHT + (ROW_HEIGHT - BUTTON_HEIGHT) / 2;
    const button = (from: Side) => {
      const remove = from === 'a' ? kind === 'insert' : kind === 'delete';
      const preview = () => props.onMergePreview({ block: i, from });
      const endPreview = () => props.onMergePreview(null);
      return (
        <button
          key={`${i}${from}`}
          type="button"
          className={`merge merge-${kind} merge-from-${from}${remove ? ' merge-remove' : ''}`}
          style={{ top }}
          disabled={!props.mergeEnabled}
          title={props.mergeDisabledReason ?? mergeTitle(blocks[i], from)}
          aria-label={from === 'a' ? (remove ? 'Remove on the right' : 'Copy to right') : remove ? 'Remove on the left' : 'Copy to left'}
          onClick={() => {
            endPreview();
            props.onMerge(i, from);
          }}
          onMouseEnter={preview}
          onMouseLeave={endPreview}
          onFocus={preview}
          onBlur={endPreview}
        >
          <MergeIcon toward={from === 'a' ? 'right' : 'left'} remove={remove} />
        </button>
      );
    };
    buttons.push(button('a'), button('b'));
  }

  const dragging = useRef(false);
  const onButton = (e: { target: EventTarget }) => (e.target as HTMLElement).closest('button') !== null;

  return (
    <div
      className="gutter"
      title="Drag to resize the panes; double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0 || onButton(e)) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
      }}
      onPointerMove={(e) => {
        if (dragging.current) props.onDividerDrag(e.clientX);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onDoubleClick={(e) => {
        if (!onButton(e)) props.onDividerReset();
      }}
    >
      <canvas ref={canvasRef} />
      <div ref={buttonsRef} className="merge-layer" style={{ transform: `translateY(${-getScrollTop()}px)` }}>
        {buttons}
      </div>
    </div>
  );
}

