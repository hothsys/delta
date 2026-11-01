import type { DiffBlock } from '../../../engine';
import type { RowModel } from './rowModel';

/** A change block's extent on each side, in pixels from the top of the viewport. */
export interface Connector {
  block: number;
  kind: 'insert' | 'delete' | 'modify';
  aTop: number;
  aBottom: number;
  bTop: number;
  bBottom: number;
}

/** Connectors for every change block that intersects the viewport. */
export function visibleConnectors(
  rows: RowModel,
  blocks: readonly DiffBlock[],
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): Connector[] {
  const out: Connector[] = [];
  const firstRow = Math.floor(scrollTop / rowHeight);
  const lastRow = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  for (let i = blockAtRow(rows.blockStart, firstRow); i < blocks.length && rows.blockStart[i] <= lastRow; i++) {
    const kind = blocks[i].kind;
    if (kind !== 'insert' && kind !== 'delete' && kind !== 'modify') continue;
    out.push({
      block: i,
      kind,
      aTop: rows.aRowStart[i] * rowHeight - scrollTop,
      aBottom: rows.aRowEnd[i] * rowHeight - scrollTop,
      bTop: rows.bRowStart[i] * rowHeight - scrollTop,
      bBottom: rows.bRowEnd[i] * rowHeight - scrollTop,
    });
  }
  return out;
}

/** Index of the block containing `row` (the last block starting at or before it). */
export function blockAtRow(blockStart: Int32Array, row: number): number {
  let lo = 0;
  let hi = blockStart.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (blockStart[mid] <= row) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
