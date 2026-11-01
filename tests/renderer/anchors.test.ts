import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/engine';
import { addAnchor, removeAnchor, transformAnchors } from '../../src/renderer/src/model/anchors';
import { buildRows } from '../../src/renderer/src/model/rowModel';

describe('addAnchor', () => {
  it('keeps anchors sorted and replaces conflicting ones', () => {
    let anchors = addAnchor([], 5, 7);
    anchors = addAnchor(anchors, 1, 2);
    expect(anchors).toEqual([
      { a: 1, b: 2 },
      { a: 5, b: 7 },
    ]);
    // Shares left line 5: replaces it.
    expect(addAnchor(anchors, 5, 9)).toEqual([
      { a: 1, b: 2 },
      { a: 5, b: 9 },
    ]);
    // Crosses {1,2} (left later, right earlier): replaces it.
    expect(addAnchor(anchors, 3, 1)).toEqual([
      { a: 3, b: 1 },
      { a: 5, b: 7 },
    ]);
  });

  it('removes anchors by line', () => {
    expect(removeAnchor([{ a: 1, b: 2 }, { a: 5, b: 7 }], 'b', 7)).toEqual([{ a: 1, b: 2 }]);
  });
});

describe('transformAnchors', () => {
  const anchors = [
    { a: 2, b: 3 },
    { a: 10, b: 12 },
  ];

  it('shifts anchors below an edit and keeps the array when nothing moves', () => {
    expect(transformAnchors(anchors, 'a', { start: 5, removed: ['x'], inserted: ['x', 'y'] })).toEqual([
      { a: 2, b: 3 },
      { a: 11, b: 12 },
    ]);
    expect(transformAnchors(anchors, 'a', { start: 2, removed: ['old'], inserted: ['new'] })).toBe(anchors);
  });

  it('drops an anchor whose line was deleted', () => {
    expect(transformAnchors(anchors, 'b', { start: 2, removed: ['p', 'q'], inserted: ['pq'] })).toEqual([{ a: 10, b: 11 }]);
  });
});

describe('anchors in the diff', () => {
  it('puts anchored lines on the same row', () => {
    const a = ['header', 'apple', 'banana', 'cherry'];
    const b = ['header', 'cherry', 'apple', 'banana'];
    const result = diffLines(a, b, { anchors: [{ a: 3, b: 1 }] });
    const rows = buildRows(result.blocks);
    expect(rows.aRow[3]).toBe(rows.bRow[1]);
  });
});
