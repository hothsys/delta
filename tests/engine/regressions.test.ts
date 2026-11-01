import { describe, expect, it } from 'vitest';
import { diffChars, diffLines } from '../../src/engine';
import { MAX_TOKENS } from '../../src/engine/intraLine';
import { pairLines } from '../../src/engine/pairing';

// Bugs found in review, kept fixed.
describe('engine regressions', () => {
  it('handles a large changed region that coalesces with a changed anchored line', () => {
    const n = 200_000;
    const a = Array.from({ length: n }, (_, i) => `left ${i}`);
    const b = Array.from({ length: n }, (_, i) => `right ${i}`);
    const r = diffLines(a, b, { anchors: [{ a: 0, b: 0 }] });
    expect(r.blocks.reduce((s, blk) => s + (blk.pairs?.length ?? 0), 0)).toBe(n);
  });

  it('does not count shared indentation as similarity', () => {
    const indent = ' '.repeat(16);
    expect(pairLines([`${indent}return x;`], [`${indent}foo(bar);`], 0, 0)).toEqual([{ a: 0, b: 0, similar: false }]);
    expect(pairLines([`${indent}return total;`], [`${indent}return total * 2;`], 0, 0)[0].similar).toBe(true);
  });

  it('highlights a spacing-only change on a very long line', () => {
    const a = 'a b '.repeat(MAX_TOKENS);
    const b = 'a  b '.repeat(MAX_TOKENS);
    const d = diffChars(a, b);
    expect(d.a.length).toBe(1);
    expect(d.b.length).toBe(1);
  });
});
