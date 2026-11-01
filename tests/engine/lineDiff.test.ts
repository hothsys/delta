import { describe, expect, it } from 'vitest';
import { diffLines, diffText, type DiffBlock, type LineDiffResult } from '../../src/engine';

const kinds = (r: LineDiffResult) => r.blocks.map((b) => b.kind);
const span = (b: DiffBlock) => [b.a.start, b.a.end, b.b.start, b.b.end];

/** Every line of both sides must be covered exactly once, in order. */
function expectCoverage(r: LineDiffResult, n: number, m: number) {
  let i = 0;
  let j = 0;
  for (const blk of r.blocks) {
    expect(blk.a.start).toBe(i);
    expect(blk.b.start).toBe(j);
    if (blk.kind === 'equal' || blk.kind === 'unimportant') {
      expect(blk.a.end - blk.a.start).toBe(blk.b.end - blk.b.start);
    }
    if (blk.kind === 'modify') {
      const as = blk.pairs!.map((p) => p.a).filter((x) => x !== null);
      const bs = blk.pairs!.map((p) => p.b).filter((x) => x !== null);
      expect(as).toEqual(range(blk.a.start, blk.a.end));
      expect(bs).toEqual(range(blk.b.start, blk.b.end));
    }
    i = blk.a.end;
    j = blk.b.end;
  }
  expect([i, j]).toEqual([n, m]);
}

const range = (s: number, e: number) => Array.from({ length: e - s }, (_, k) => s + k);

describe('diffLines', () => {
  it('reports an exact match as a single equal block', () => {
    const r = diffLines(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(r.blocks).toEqual([{ kind: 'equal', a: { start: 0, end: 3 }, b: { start: 0, end: 3 } }]);
    expect(r.stats).toMatchObject({ equalLines: 3, changeBlocks: 0 });
  });

  it('handles empty texts', () => {
    expect(diffLines([], []).blocks).toEqual([]);
    expect(kinds(diffLines([], ['x']))).toEqual(['insert']);
    expect(kinds(diffLines(['x'], []))).toEqual(['delete']);
  });

  it('identifies an insertion', () => {
    const r = diffLines(['a', 'b', 'c'], ['a', 'b', 'new', 'c']);
    expect(kinds(r)).toEqual(['equal', 'insert', 'equal']);
    expect(span(r.blocks[1])).toEqual([2, 2, 2, 3]);
    expect(r.stats).toMatchObject({ insertedLines: 1, changeBlocks: 1 });
  });

  it('identifies a deletion', () => {
    const r = diffLines(['a', 'b', 'c', 'd'], ['a', 'd']);
    expect(kinds(r)).toEqual(['equal', 'delete', 'equal']);
    expect(span(r.blocks[1])).toEqual([1, 3, 1, 1]);
    expect(r.stats).toMatchObject({ deletedLines: 2, changeBlocks: 1 });
  });

  it('identifies a modification and pairs the changed lines', () => {
    const r = diffLines(['a', 'let x = 1;', 'c'], ['a', 'let x = 2;', 'c']);
    expect(kinds(r)).toEqual(['equal', 'modify', 'equal']);
    expect(r.blocks[1].pairs).toEqual([{ a: 1, b: 1, similar: true }]);
    expect(r.stats).toMatchObject({ modifiedPairs: 1, changeBlocks: 1 });
  });

  it('counts a block replaced by unrelated lines as deleted and inserted, not modified', () => {
    const r = diffLines(
      ['a', 'VENDOR_FILES = {', '  "maplibre.js": "https://unpkg.com/maplibre"', '}', 'z'],
      ['a', 'def rotate_log():', '    # keep only the newest lines', '    try:', '        pass', 'z'],
    );
    expect(kinds(r)).toEqual(['equal', 'modify', 'equal']);
    expect(r.blocks[1].pairs!.map((p) => p.similar ?? null)).toEqual([false, false, false, null]);
    expect(r.stats).toMatchObject({ modifiedPairs: 0, deletedLines: 3, insertedLines: 4, changeBlocks: 1 });
  });

  it('treats a change of letter case as an edit', () => {
    const r = diffLines(['bravo'], ['BRAVO']);
    expect(r.blocks[0].pairs).toEqual([{ a: 0, b: 0, similar: true }]);
  });

  it('keeps similar lines on the same row when a line is inserted above an edit', () => {
    const r = diffLines(
      ['start', 'function total(items) {', 'end'],
      ['start', '// sums prices', 'function total(items, tax) {', 'end'],
    );
    expect(r.blocks[1].kind).toBe('modify');
    expect(r.blocks[1].pairs).toEqual([
      { a: null, b: 1 },
      { a: 1, b: 2, similar: true },
    ]);
  });

  it('covers both texts exactly once for a mixed diff', () => {
    const a = ['header', 'one', 'two', 'three', 'four', 'five', 'footer'];
    const b = ['header', 'one', 'TWO', 'three', 'five', 'six', 'seven', 'footer'];
    const r = diffLines(a, b);
    expectCoverage(r, a.length, b.length);
    expect(kinds(r)).toEqual(['equal', 'modify', 'equal', 'delete', 'equal', 'insert', 'equal']);
  });

  describe('whitespace and case options', () => {
    const a = ['  indented', 'trailing   ', 'a  b', 'Mixed Case'];
    const b = ['indented', 'trailing', 'a b', 'mixed case'];

    it('treats every whitespace difference as a change by default', () => {
      expect(diffLines(a, b).stats.equalLines).toBe(0);
    });

    it('trim ignores leading/trailing whitespace only', () => {
      const r = diffLines(a, b, { whitespace: 'trim' });
      expect(kinds(r)).toEqual(['unimportant', 'modify']);
      expect(span(r.blocks[0])).toEqual([0, 2, 0, 2]);
    });

    it('collapse also equates runs of internal whitespace', () => {
      const r = diffLines(a, b, { whitespace: 'collapse' });
      expect(kinds(r)).toEqual(['unimportant', 'modify']);
      expect(span(r.blocks[0])).toEqual([0, 3, 0, 3]);
    });

    it('ignore removes whitespace entirely', () => {
      const r = diffLines(['a b c'], ['abc'], { whitespace: 'ignore' });
      expect(kinds(r)).toEqual(['unimportant']);
    });

    it('ignoreCase combines with whitespace modes', () => {
      const r = diffLines(a, b, { whitespace: 'collapse', ignoreCase: true });
      expect(kinds(r)).toEqual(['unimportant']);
      expect(r.stats).toMatchObject({ unimportantLines: 4, changeBlocks: 0 });
    });

    it('lines identical in raw form stay equal even when options are on', () => {
      const r = diffLines(['same', ' x'], ['same', 'x'], { whitespace: 'trim' });
      expect(kinds(r)).toEqual(['equal', 'unimportant']);
    });
  });

  describe('manual alignment', () => {
    it('forces two different lines onto the same row', () => {
      const a = ['alpha', 'beta', 'gamma'];
      const b = ['gamma', 'delta', 'beta'];
      // Without anchors the diff aligns one of the shared lines on its own.
      const r = diffLines(a, b, { anchors: [{ a: 0, b: 1 }] });
      expectCoverage(r, a.length, b.length);
      const row = r.blocks.flatMap((blk) => blk.pairs ?? []).find((p) => p.a === 0);
      // Aligned, but still unrelated text: shown as a replacement rather than an edit.
      expect(row).toEqual({ a: 0, b: 1, similar: false });
      expect(r.anchors).toEqual([{ a: 0, b: 1 }]);
    });

    it('aligns matching lines that Myers would otherwise leave unpaired', () => {
      const a = ['x', 'shared', 'y'];
      const b = ['shared', 'p', 'q', 'x'];
      const plain = diffLines(a, b);
      const anchored = diffLines(a, b, { anchors: [{ a: 0, b: 3 }] });
      expectCoverage(anchored, a.length, b.length);
      const equalRows = (r: LineDiffResult) =>
        r.blocks.filter((blk) => blk.kind === 'equal').flatMap((blk) => range(blk.a.start, blk.a.end));
      expect(equalRows(plain)).toEqual([1]);
      expect(equalRows(anchored)).toEqual([0]);
    });

    it('drops out-of-range and crossing anchors', () => {
      const a = ['a', 'b', 'c', 'd'];
      const b = ['a', 'b', 'c', 'd'];
      const r = diffLines(a, b, {
        anchors: [
          { a: 2, b: 1 },
          { a: 1, b: 2 },
          { a: 9, b: 0 },
          { a: 3, b: 3 },
        ],
      });
      expect(r.anchors).toEqual([
        { a: 1, b: 2 },
        { a: 3, b: 3 },
      ]);
      expectCoverage(r, 4, 4);
    });
  });

  it('slides an inserted block so it ends on a blank line', () => {
    const a = ['function a() {', '}', '', 'function c() {', '}'];
    const b = ['function a() {', '}', '', 'function b() {', '}', '', 'function c() {', '}'];
    const r = diffLines(a, b);
    expect(kinds(r)).toEqual(['equal', 'insert', 'equal']);
    expect(span(r.blocks[1])).toEqual([3, 3, 3, 6]);
  });

  it('handles large files with scattered edits quickly', () => {
    const a = Array.from({ length: 200_000 }, (_, i) => `line ${i} ${'x'.repeat(i % 40)}`);
    const b = a.slice();
    for (let i = 0; i < b.length; i += 97) b[i] = `${b[i]} changed`;
    for (let i = 500; i < b.length; i += 1013) b.splice(i, 0, `inserted ${i}`);
    const t0 = performance.now();
    const r = diffLines(a, b);
    const elapsed = performance.now() - t0;
    expectCoverage(r, a.length, b.length);
    expect(r.stats.modifiedPairs).toBeGreaterThan(2000);
    expect(elapsed).toBeLessThan(3000);
  });

  it('handles completely different large files instantly', () => {
    const a = Array.from({ length: 100_000 }, (_, i) => `left ${i}`);
    const b = Array.from({ length: 100_000 }, (_, i) => `right ${i}`);
    const t0 = performance.now();
    const r = diffLines(a, b);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(kinds(r)).toEqual(['modify']);
  });
});

describe('diffText', () => {
  it('splits both texts and returns their line metadata', () => {
    const r = diffText('a\r\nb\r\n', 'a\nc');
    expect(r.left).toMatchObject({ lines: ['a', 'b'], eol: '\r\n', trailingNewline: true });
    expect(r.right).toMatchObject({ lines: ['a', 'c'], eol: '\n', trailingNewline: false });
    expect(kinds(r)).toEqual(['equal', 'modify']);
  });
});
