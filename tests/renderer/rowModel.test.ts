import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/engine';
import { buildRows, maxColumns, RowKind } from '../../src/renderer/src/model/rowModel';

describe('buildRows', () => {
  it('lays out every block kind with filler rows', () => {
    const a = ['same', 'old value', 'gone', 'tail'];
    const b = ['same', 'new value', 'tail', 'added'];
    const rows = buildRows(diffLines(a, b).blocks);

    expect(Array.from(rows.a)).toEqual([0, 1, 2, 3, -1]);
    expect(Array.from(rows.b)).toEqual([0, 1, -1, 2, 3]);
    expect(Array.from(rows.kind)).toEqual([
      RowKind.Equal,
      RowKind.Modified,
      RowKind.Deleted,
      RowKind.Equal,
      RowKind.Inserted,
    ]);
  });

  it('marks unpaired lines inside a modify block as inserted or deleted', () => {
    const rows = buildRows(diffLines(['x', 'let total = 1;', 'y'], ['x', 'let total = 2;', 'extra line', 'y']).blocks);
    expect(Array.from(rows.kind)).toEqual([RowKind.Equal, RowKind.Modified, RowKind.Inserted, RowKind.Equal]);
    expect(Array.from(rows.a)).toEqual([0, 1, -1, 2]);
  });

  it('marks unrelated lines sharing a row as replaced, not modified', () => {
    const rows = buildRows(diffLines(['x', 'aaa', 'y'], ['x', 'bbb', 'ccc', 'y']).blocks);
    expect(Array.from(rows.kind)).toEqual([RowKind.Equal, RowKind.Replaced, RowKind.Inserted, RowKind.Equal]);
  });

  it('records where each block starts', () => {
    const r = diffLines(['a', 'b', 'c'], ['a', 'X', 'Y', 'c']);
    const rows = buildRows(r.blocks);
    expect(r.blocks.map((blk) => blk.kind)).toEqual(['equal', 'modify', 'equal']);
    expect(Array.from(rows.blockStart)).toEqual([0, 1, 3]);
  });

  it('records the rows each block spans on each side', () => {
    // Blocks: equal [a], insert [new], equal [b], delete [gone], equal [c], modify [x -> y, z].
    const r = diffLines(['a', 'b', 'gone', 'c', 'x'], ['a', 'new', 'b', 'c', 'y', 'zzz']);
    const rows = buildRows(r.blocks);
    expect(r.blocks.map((blk) => blk.kind)).toEqual(['equal', 'insert', 'equal', 'delete', 'equal', 'modify']);
    const extent = (i: number) => [rows.aRowStart[i], rows.aRowEnd[i], rows.bRowStart[i], rows.bRowEnd[i]];
    expect(extent(1)).toEqual([1, 1, 1, 2]); // insertion point on the left
    expect(extent(3)).toEqual([3, 4, 3, 3]); // deletion point on the right
    expect(extent(5)).toEqual([5, 6, 5, 7]);
  });

  it('marks whitespace-only matches as unimportant', () => {
    const rows = buildRows(diffLines(['  a'], ['a'], { whitespace: 'trim' }).blocks);
    expect(Array.from(rows.kind)).toEqual([RowKind.Unimportant]);
  });

  it('handles empty input', () => {
    expect(buildRows([]).count).toBe(0);
  });
});

describe('maxColumns', () => {
  it('expands tabs to tab stops', () => {
    expect(maxColumns(['ab', '\tx', 'a\tb'], 4)).toBe(5);
    expect(maxColumns(['abcdef'], 4)).toBe(6);
    expect(maxColumns(['abc', '\tx'], 4)).toBe(5);
    expect(maxColumns([], 4)).toBe(0);
  });
});
