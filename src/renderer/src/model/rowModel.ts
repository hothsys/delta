import type { DiffBlock } from '../../../engine';

/** What a display row shows. Stored as a byte per row. */
export const RowKind = {
  Equal: 0,
  Unimportant: 1,
  Modified: 2,
  Inserted: 3,
  Deleted: 4,
  /** A left line replaced by an unrelated right line: shown as removed beside added, no word highlights. */
  Replaced: 5,
} as const;
export type RowKind = (typeof RowKind)[keyof typeof RowKind];

/** `a` is the left text, `b` the right. */
export type Side = 'a' | 'b';

/**
 * The aligned display rows shared by both panes. Both panes always have exactly `count`
 * rows, with `-1` marking a filler row on one side, so they scroll in lockstep by
 * construction. Typed arrays keep a million-row file at a few megabytes.
 */
export interface RowModel {
  count: number;
  /** Left line index per row, or -1 for a filler row. */
  a: Int32Array;
  /** Right line index per row, or -1 for a filler row. */
  b: Int32Array;
  kind: Uint8Array;
  /** First row of each diff block, indexed like `LineDiffResult.blocks`. */
  blockStart: Int32Array;
  /**
   * Per block, the rows `[aRowStart, aRowEnd)` that span its real left lines (fillers between
   * them included). When a block has no left lines this is the empty range at its first row,
   * i.e. the point where its lines would be inserted. `b*` likewise for the right side.
   */
  aRowStart: Int32Array;
  aRowEnd: Int32Array;
  bRowStart: Int32Array;
  bRowEnd: Int32Array;
  /** Inverse maps: the row showing each left (`aRow`) and right (`bRow`) line. */
  aRow: Int32Array;
  bRow: Int32Array;
}

export function buildRows(blocks: readonly DiffBlock[]): RowModel {
  let count = 0;
  for (const blk of blocks) {
    count += blk.pairs ? blk.pairs.length : Math.max(blk.a.end - blk.a.start, blk.b.end - blk.b.start);
  }

  const a = new Int32Array(count);
  const b = new Int32Array(count);
  const kind = new Uint8Array(count);
  const blockStart = new Int32Array(blocks.length);
  const aRowStart = new Int32Array(blocks.length);
  const aRowEnd = new Int32Array(blocks.length);
  const bRowStart = new Int32Array(blocks.length);
  const bRowEnd = new Int32Array(blocks.length);
  let r = 0;
  blocks.forEach((blk, i) => {
    blockStart[i] = r;
    switch (blk.kind) {
      case 'equal':
      case 'unimportant': {
        const k = blk.kind === 'equal' ? RowKind.Equal : RowKind.Unimportant;
        for (let x = blk.a.start, y = blk.b.start; x < blk.a.end; x++, y++, r++) {
          a[r] = x;
          b[r] = y;
          kind[r] = k;
        }
        break;
      }
      case 'insert':
        for (let y = blk.b.start; y < blk.b.end; y++, r++) {
          a[r] = -1;
          b[r] = y;
          kind[r] = RowKind.Inserted;
        }
        break;
      case 'delete':
        for (let x = blk.a.start; x < blk.a.end; x++, r++) {
          a[r] = x;
          b[r] = -1;
          kind[r] = RowKind.Deleted;
        }
        break;
      case 'modify':
        for (const p of blk.pairs!) {
          a[r] = p.a ?? -1;
          b[r] = p.b ?? -1;
          kind[r] = p.a === null ? RowKind.Inserted : p.b === null ? RowKind.Deleted : p.similar ? RowKind.Modified : RowKind.Replaced;
          r++;
        }
        break;
    }
    setExtent(a, blockStart[i], r, aRowStart, aRowEnd, i);
    setExtent(b, blockStart[i], r, bRowStart, bRowEnd, i);
  });
  const last = blocks[blocks.length - 1];
  return {
    count,
    a,
    b,
    kind,
    blockStart,
    aRowStart,
    aRowEnd,
    bRowStart,
    bRowEnd,
    aRow: inverse(a, last ? last.a.end : 0),
    bRow: inverse(b, last ? last.b.end : 0),
  };
}

function inverse(side: Int32Array, lineCount: number): Int32Array {
  const inv = new Int32Array(lineCount);
  for (let r = 0; r < side.length; r++) if (side[r] >= 0) inv[side[r]] = r;
  return inv;
}

/**
 * Updates the row model for an edit on one side that replaced `removed` lines starting at
 * `start` with `inserted` lines, without re-diffing.
 *
 * New lines first take the filler rows waiting where they go (the gap above an insertion, or
 * fillers just below the replaced lines), so copying lines into a gap fills it the way the
 * re-diff will, instead of pushing everything below down a row until it arrives (a visible
 * flicker). Only then do surplus new lines get new rows (shown as inserted or deleted, with a
 * filler on the other side). Surplus removed lines become fillers, and their rows disappear
 * if the other side has nothing there either. The result is a consistent
 * layout to render until the debounced re-diff replaces it. Block positions are shifted to
 * match, but block line ranges are not, so merges must wait for that re-diff.
 */
export function patchRows(rows: RowModel, side: Side, start: number, removed: number, inserted: number): RowModel {
  if (removed === inserted) return rows;
  const mine = side === 'a' ? rows.a : rows.b;
  const other = side === 'a' ? rows.b : rows.a;
  const inv = side === 'a' ? rows.aRow : rows.bRow;
  const onlyMine = side === 'a' ? RowKind.Deleted : RowKind.Inserted;
  const onlyOther = side === 'a' ? RowKind.Inserted : RowKind.Deleted;

  // Rows covering the replaced lines; for a pure insertion, the row it goes before.
  let r0: number;
  let r1: number;
  if (removed > 0) {
    r0 = inv[start];
    r1 = inv[start + removed - 1] + 1;
  } else {
    r0 = r1 = start < inv.length ? inv[start] : rows.count;
  }
  // Take in the fillers new lines can fill: above an insertion point (the gap between the line
  // before and the line after), or right after the replaced lines.
  if (inserted > removed) {
    if (removed === 0) while (r0 > 0 && mine[r0 - 1] < 0) r0--;
    else while (r1 < rows.count && mine[r1] < 0) r1++;
  }

  // New lines go into the rows in order, fillers included; rows left over keep the other
  // side's line (with a filler here) or disappear if neither side has one.
  const segMine: number[] = [];
  const segOther: number[] = [];
  const segKind: number[] = [];
  let next = 0;
  for (let r = r0; r < r1; r++) {
    if (next < inserted) {
      segMine.push(start + next++);
      segOther.push(other[r]);
      segKind.push(rows.kind[r]);
    } else if (other[r] >= 0) {
      segMine.push(-1);
      segOther.push(other[r]);
      segKind.push(mine[r] < 0 ? rows.kind[r] : onlyOther);
    }
  }
  while (next < inserted) {
    segMine.push(start + next++);
    segOther.push(-1);
    segKind.push(onlyMine);
  }

  const growth = segMine.length - (r1 - r0);
  const lineShift = inserted - removed;
  const count = rows.count + growth;
  const newMine = new Int32Array(count);
  const newOther = new Int32Array(count);
  const kind = new Uint8Array(count);
  newMine.set(mine.subarray(0, r0));
  newOther.set(other.subarray(0, r0));
  kind.set(rows.kind.subarray(0, r0));
  newMine.set(segMine, r0);
  newOther.set(segOther, r0);
  kind.set(segKind, r0);
  const tail = r0 + segMine.length;
  newOther.set(other.subarray(r1), tail);
  kind.set(rows.kind.subarray(r1), tail);
  for (let r = r1, t = tail; r < rows.count; r++, t++) newMine[t] = mine[r] < 0 ? -1 : mine[r] + lineShift;

  // Rows inserted at the very top belong to the first block, so position 0 never moves.
  const shift = (positions: Int32Array) =>
    positions.map((p) => (p >= r1 && p > 0 ? p + growth : p > r0 ? Math.min(p, tail) : p));
  const a = side === 'a' ? newMine : newOther;
  const b = side === 'a' ? newOther : newMine;
  const aLines = rows.aRow.length + (side === 'a' ? lineShift : 0);
  const bLines = rows.bRow.length + (side === 'b' ? lineShift : 0);
  return {
    count,
    a,
    b,
    kind,
    blockStart: shift(rows.blockStart),
    aRowStart: shift(rows.aRowStart),
    aRowEnd: shift(rows.aRowEnd),
    bRowStart: shift(rows.bRowStart),
    bRowEnd: shift(rows.bRowEnd),
    aRow: inverse(a, aLines),
    bRow: inverse(b, bLines),
  };
}

function setExtent(side: Int32Array, start: number, end: number, outStart: Int32Array, outEnd: Int32Array, i: number) {
  let lo = start;
  while (lo < end && side[lo] < 0) lo++;
  if (lo === end) {
    outStart[i] = outEnd[i] = start;
    return;
  }
  let hi = end;
  while (side[hi - 1] < 0) hi--;
  outStart[i] = lo;
  outEnd[i] = hi;
}

/** Widest line in display columns, with tabs expanded to the next multiple of `tabSize`. */
export function maxColumns(lines: readonly string[], tabSize: number): number {
  let max = 0;
  for (const line of lines) {
    // Tabs only ever widen a line, so a line already no wider than `max` in raw length can be
    // skipped unless it contains tabs.
    const hasTab = line.includes('\t');
    if (line.length <= max && !hasTab) continue;
    let cols = line.length;
    if (hasTab) {
      cols = 0;
      for (let i = 0; i < line.length; i++) {
        cols = line.charCodeAt(i) === 9 ? cols + tabSize - (cols % tabSize) : cols + 1;
      }
    }
    if (cols > max) max = cols;
  }
  return max;
}
