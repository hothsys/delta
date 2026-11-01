import type { DiffBlock } from '../../../engine';
import { RowKind, type RowModel } from './rowModel';

/** Which half of the overview a mark is painted in: left file, right file, or across both. */
export type OverviewSide = 'a' | 'b' | 'both';

export interface OverviewMark {
  /** Top and height in CSS pixels within the overview. */
  y: number;
  h: number;
  kind: RowKind;
  side: OverviewSide;
  /** First row the mark stands for; clicking the mark jumps here. */
  row: number;
}

/** Marks shorter than this would be invisible, so they are stretched to it. */
export const MIN_MARK_HEIGHT = 2;

/**
 * Coloured marks for the overview map, scaled so the whole file fits in `height` pixels.
 * Unimportant marks come first so that real changes are painted over them.
 */
export function overviewMarks(rows: RowModel, blocks: readonly DiffBlock[], height: number): OverviewMark[] {
  const minor: OverviewMark[] = [];
  const changes: OverviewMark[] = [];
  if (rows.count === 0 || height <= 0) return [];
  const scale = height / rows.count;

  const add = (list: OverviewMark[], start: number, end: number, kind: RowKind, side: OverviewSide) => {
    const h = Math.min(height, Math.max(MIN_MARK_HEIGHT, (end - start) * scale));
    // Stretched marks near the bottom move up so they stay fully visible.
    const y = Math.min(start * scale, height - h);
    // Neighbouring marks that land on the same pixels are merged to keep drawing cheap.
    const last = list[list.length - 1];
    if (last && last.kind === kind && last.side === side && y <= last.y + last.h) {
      last.h = Math.max(last.h, y + h - last.y);
      return;
    }
    list.push({ y, h, kind, side, row: start });
  };

  blocks.forEach((blk, i) => {
    const start = rows.blockStart[i];
    const end = i + 1 < blocks.length ? rows.blockStart[i + 1] : rows.count;
    switch (blk.kind) {
      case 'unimportant':
        add(minor, start, end, RowKind.Unimportant, 'both');
        break;
      case 'insert':
        add(changes, start, end, RowKind.Inserted, 'b');
        break;
      case 'delete':
        add(changes, start, end, RowKind.Deleted, 'a');
        break;
      case 'modify':
        // A modify block can mix paired, inserted and deleted rows; mark each run separately.
        for (let r = start; r < end; ) {
          const kind = rows.kind[r] as RowKind;
          let e = r + 1;
          while (e < end && rows.kind[e] === kind) e++;
          if (kind === RowKind.Replaced) {
            // Removed on the left, added on the right.
            add(changes, r, e, RowKind.Deleted, 'a');
            add(changes, r, e, RowKind.Inserted, 'b');
          } else {
            add(changes, r, e, kind, kind === RowKind.Inserted ? 'b' : kind === RowKind.Deleted ? 'a' : 'both');
          }
          r = e;
        }
        break;
    }
  });
  return [...minor, ...changes];
}

/** The row at vertical position `y` of an overview `height` pixels tall. */
export function rowAtY(y: number, height: number, rowCount: number): number {
  if (rowCount === 0 || height <= 0) return 0;
  return Math.min(rowCount - 1, Math.max(0, Math.floor((y / height) * rowCount)));
}

/**
 * The mark under `y`, if any. Real changes win over unimportant ones, and a mark within
 * `tolerance` pixels counts so thin marks are easy to hit.
 */
export function markAt(marks: readonly OverviewMark[], y: number, tolerance = 2): OverviewMark | null {
  let best: OverviewMark | null = null;
  let bestScore = Infinity;
  for (const m of marks) {
    const distance = y < m.y ? m.y - y : y > m.y + m.h ? y - (m.y + m.h) : 0;
    if (distance > tolerance) continue;
    // Prefer exact hits, then changes over unimportant marks, then the nearest.
    const score = distance + (m.kind === RowKind.Unimportant ? tolerance + 1 : 0);
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Scroll offset that puts `row` at `anchor` (0 = top, 0.5 = middle) of the viewport,
 * clamped to the scrollable range.
 */
export function scrollTopForRow(
  row: number,
  rowHeight: number,
  viewportHeight: number,
  rowCount: number,
  anchor: number,
): number {
  const max = Math.max(0, rowCount * rowHeight - viewportHeight);
  const top = row * rowHeight - viewportHeight * anchor;
  return Math.round(Math.min(max, Math.max(0, top)));
}
