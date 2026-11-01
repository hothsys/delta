import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/engine';
import { clipRanges, columnSlice } from '../../src/renderer/src/components/layout';
import { overviewMarks } from '../../src/renderer/src/model/overview';
import { buildRows, patchRows } from '../../src/renderer/src/model/rowModel';
import { applyOp } from '../../src/renderer/src/model/textEdit';

// Bugs found in review, kept fixed.
describe('renderer model regressions', () => {
  it('applies an edit inserting hundreds of thousands of lines', () => {
    const lines = ['first', 'last'];
    const inserted = Array.from({ length: 300_000 }, (_, i) => `l${i}`);
    applyOp(lines, { start: 1, removed: [], inserted });
    expect(lines).toHaveLength(300_002);
    expect(lines[0]).toBe('first');
    expect(lines[1]).toBe('l0');
    expect(lines[300_001]).toBe('last');
  });

  it('keeps rows inserted at the top of the file inside the first block', () => {
    const r = diffLines(['a', 'b'], ['a', 'c']);
    const rows = patchRows(buildRows(r.blocks), 'a', 0, 0, 2);
    expect(rows.blockStart[0]).toBe(0);
  });

  it('keeps a change on the last row fully visible in the overview', () => {
    const a = Array.from({ length: 1000 }, (_, i) => `l${i}`);
    const r = diffLines(a, [...a, 'new last line']);
    const [mark] = overviewMarks(buildRows(r.blocks), r.blocks, 100);
    expect(mark.y + mark.h).toBeLessThanOrEqual(100);
  });

  it('never cuts a surrogate pair at the edges of a column window', () => {
    const text = '😀'.repeat(10);
    for (const [from, to] of [[3, 9], [1, 2], [5, 6]]) {
      const s = columnSlice(text, from, to);
      expect(text.charCodeAt(s.start) >= 0xdc00 && text.charCodeAt(s.start) <= 0xdfff).toBe(false);
      expect(s.end === text.length || !(text.charCodeAt(s.end) >= 0xdc00 && text.charCodeAt(s.end) <= 0xdfff)).toBe(true);
    }
    expect(clipRanges([{ start: 0, end: 4 }], 2, 6)).toEqual([{ start: 0, end: 2 }]);
  });
});

import { transformAnchors } from '../../src/renderer/src/model/anchors';
import { UndoHistory } from '../../src/renderer/src/model/undo';

describe('editing regressions', () => {
  it('remembers that a side changed after its oldest edits are trimmed from history', () => {
    const h = new UndoHistory();
    const entry = (side: 'a' | 'b', i: number) => ({
      side,
      op: { start: 0, removed: [`${i}`], inserted: [`${i + 1}`] },
      before: { anchor: { line: 0, col: 0 }, head: { line: 0, col: 0 } },
      after: { anchor: { line: 0, col: 0 }, head: { line: 0, col: 0 } },
      time: i,
    });
    h.push(entry('a', 0));
    for (let i = 1; i <= 1100; i++) h.push(entry('b', i));
    expect(h.lastEntry('a')).toBeNull();
    expect(h.lostStart('a')).toBe(true);
    h.resetLost('a');
    expect(h.lostStart('a')).toBe(false);
  });

  it('moves an alignment down with its line when Enter is pressed at its start', () => {
    const anchors = [{ a: 9, b: 4 }];
    const op = { start: 9, removed: ['aligned text'], inserted: ['', 'aligned text'] };
    expect(transformAnchors(anchors, 'a', op)).toEqual([{ a: 10, b: 4 }]);
    // Typing on the aligned line keeps it in place.
    expect(transformAnchors(anchors, 'a', { start: 9, removed: ['aligned text'], inserted: ['aligned text!'] })).toBe(anchors);
  });
});

import { parentDir } from '../../src/renderer/src/model/paths';

describe('path regressions', () => {
  it('gives a drive root, never a bare drive letter, as the parent of a file at the root', () => {
    expect(parentDir('C:\\a.txt')).toBe('C:\\');
    expect(parentDir('C:\\Users\\me\\a.txt')).toBe('C:\\Users\\me');
    expect(parentDir('/a.txt')).toBe('/');
    expect(parentDir('/home/me/a.txt')).toBe('/home/me');
  });
});
