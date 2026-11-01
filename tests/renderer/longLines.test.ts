import { describe, expect, it } from 'vitest';
import { clipRanges, columnSlice, TAB_SIZE } from '../../src/renderer/src/components/layout';

/** Visual column of every character, as the panes lay them out. */
function columns(text: string): number[] {
  const cols: number[] = [];
  let v = 0;
  for (let i = 0; i < text.length; i++) {
    cols.push(v);
    v = text.charCodeAt(i) === 9 ? v + TAB_SIZE - (v % TAB_SIZE) : v + 1;
  }
  return cols;
}

describe('columnSlice', () => {
  it('covers the requested columns, starting on a tab stop', () => {
    const text = 'ab\tcdef\t\tghijklmnop\tq'.repeat(50);
    const cols = columns(text);
    for (const [from, to] of [[0, 10], [5, 40], [37, 200], [101, 102], [500, 9999]]) {
      const s = columnSlice(text, from, to);
      expect(s.col % TAB_SIZE).toBe(0);
      expect(s.col).toBe(s.start < text.length ? cols[s.start] : s.col);
      // Starts no later than the first tab stop at or after `from`, and no earlier than `from`.
      expect(s.col).toBeGreaterThanOrEqual(from);
      expect(s.col).toBeLessThan(from + TAB_SIZE);
      // Reaches `to` (or the end of the line).
      expect(s.end === text.length || cols[s.end] >= to).toBe(true);
    }
  });

  it('returns an empty slice past the end of the line', () => {
    const s = columnSlice('short', 100, 200);
    expect(s.start).toBe(5);
    expect(s.end).toBe(5);
  });
});

describe('clipRanges', () => {
  it('keeps overlapping ranges, clipped and relative to the slice', () => {
    const ranges = [
      { start: 0, end: 5 },
      { start: 8, end: 20 },
      { start: 25, end: 30 },
      { start: 40, end: 50 },
    ];
    expect(clipRanges(ranges, 10, 30)).toEqual([
      { start: 0, end: 10 },
      { start: 15, end: 20 },
    ]);
    expect(clipRanges(undefined, 0, 10)).toEqual([]);
  });
});
