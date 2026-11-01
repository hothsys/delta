import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/engine';
import { blockAtRow, visibleConnectors } from '../../src/renderer/src/model/gutter';
import { markAt, MIN_MARK_HEIGHT, overviewMarks, rowAtY, scrollTopForRow } from '../../src/renderer/src/model/overview';
import { buildRows, RowKind } from '../../src/renderer/src/model/rowModel';

const RH = 20;

/** 100 equal lines with one insertion at line 10 and one modification at line 60. */
function fixture() {
  const a = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const b = a.slice();
  b[60] = 'line 60 changed';
  b.splice(10, 0, 'new A', 'new B');
  const result = diffLines(a, b);
  return { result, rows: buildRows(result.blocks) };
}

describe('visibleConnectors', () => {
  it('returns only change blocks in view, in viewport pixels', () => {
    const { result, rows } = fixture();
    const all = visibleConnectors(rows, result.blocks, 0, 102 * RH, RH);
    expect(all.map((c) => c.kind)).toEqual(['insert', 'modify']);

    // The insertion is a point on the left (rows 10..10) and two lines on the right.
    expect(all[0]).toMatchObject({ aTop: 200, aBottom: 200, bTop: 200, bBottom: 240 });

    // Scrolled so only the modification (row 62) is visible.
    const scrolled = visibleConnectors(rows, result.blocks, 50 * RH, 20 * RH, RH);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toMatchObject({ kind: 'modify', aTop: 12 * RH, aBottom: 13 * RH });
  });

  it('includes a block that starts above the viewport but extends into it', () => {
    const a = ['x'];
    const b = Array.from({ length: 50 }, (_, i) => `n${i}`).concat('x');
    const result = diffLines(a, b);
    const rows = buildRows(result.blocks);
    const c = visibleConnectors(rows, result.blocks, 30 * RH, 10 * RH, RH);
    expect(c.map((x) => x.kind)).toEqual(['insert']);
    expect(c[0].bTop).toBe(-30 * RH);
  });
});

describe('blockAtRow', () => {
  it('finds the block containing a row', () => {
    const starts = Int32Array.from([0, 10, 12, 60]);
    expect([0, 9, 10, 11, 12, 59, 60, 99].map((r) => blockAtRow(starts, r))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(blockAtRow(new Int32Array(0), 5)).toBe(0);
  });
});

describe('overviewMarks', () => {
  it('places each change proportionally, on the correct side', () => {
    const { result, rows } = fixture();
    const marks = overviewMarks(rows, result.blocks, rows.count); // 1px per row
    expect(marks).toEqual([
      { y: 10, h: 2, kind: RowKind.Inserted, side: 'b', row: 10 },
      { y: 62, h: MIN_MARK_HEIGHT, kind: RowKind.Modified, side: 'both', row: 62 },
    ]);
  });

  it('stretches tiny changes to stay visible and merges ones that overlap', () => {
    const a = Array.from({ length: 10_000 }, (_, i) => `l${i}`);
    const b = a.slice();
    // Small edits (similar lines), so each is a modified row.
    b[5000] = 'l5000x';
    b[5001] = 'l5001y';
    b[5003] = 'l5003z';
    const result = diffLines(a, b);
    const marks = overviewMarks(buildRows(result.blocks), result.blocks, 500);
    expect(marks).toHaveLength(1);
    expect(marks[0].h).toBeGreaterThanOrEqual(MIN_MARK_HEIGHT);
    expect(marks[0].row).toBe(5000);
  });

  it('paints unimportant marks first so changes cover them', () => {
    const result = diffLines(['  a', 'value 1'], ['a', 'value 2'], { whitespace: 'trim' });
    const marks = overviewMarks(buildRows(result.blocks), result.blocks, 100);
    expect(marks.map((m) => m.kind)).toEqual([RowKind.Unimportant, RowKind.Modified]);
  });

  it('shows replaced lines as removed on the left beside added on the right', () => {
    const result = diffLines(['x', 'aaa', 'y'], ['x', 'bbb', 'y']);
    const marks = overviewMarks(buildRows(result.blocks), result.blocks, 100);
    expect(marks.map((m) => [m.kind, m.side])).toEqual([
      [RowKind.Deleted, 'a'],
      [RowKind.Inserted, 'b'],
    ]);
  });
});

describe('overview hit testing', () => {
  it('maps a click to the exact row at that position', () => {
    expect(rowAtY(0, 500, 1000)).toBe(0);
    expect(rowAtY(250, 500, 1000)).toBe(500);
    expect(rowAtY(499.9, 500, 1000)).toBe(999);
    expect(rowAtY(800, 500, 1000)).toBe(999);
    expect(rowAtY(-5, 500, 1000)).toBe(0);
  });

  it('snaps to a mark under or near the pointer, preferring real changes', () => {
    const marks = [
      { y: 100, h: 50, kind: RowKind.Unimportant, side: 'both' as const, row: 1 },
      { y: 120, h: 2, kind: RowKind.Modified, side: 'both' as const, row: 2 },
    ];
    expect(markAt(marks, 121)?.row).toBe(2);
    expect(markAt(marks, 123.5)?.row).toBe(2); // just below the thin mark, within tolerance
    expect(markAt(marks, 140)?.row).toBe(1);
    expect(markAt(marks, 300)).toBeNull();
  });

  it('computes clamped scroll offsets for a target row', () => {
    expect(scrollTopForRow(50, RH, 400, 100, 0.5)).toBe(800);
    expect(scrollTopForRow(2, RH, 400, 100, 0.5)).toBe(0);
    expect(scrollTopForRow(99, RH, 400, 100, 0.5)).toBe(1600);
    expect(scrollTopForRow(10, RH, 400, 5, 0.5)).toBe(0);
  });
});
