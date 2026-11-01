import { describe, expect, it } from 'vitest';
import { pairLines } from '../../src/engine/pairing';

describe('pairLines', () => {
  it('zips dissimilar lines row by row, marking them as not similar', () => {
    expect(pairLines(['aaa', 'bbb'], ['xxx', 'yyy', 'zzz'], 10, 20)).toEqual([
      { a: 10, b: 20, similar: false },
      { a: 11, b: 21, similar: false },
      { a: null, b: 22 },
    ]);
  });

  it('marks a zipped pair similar when its lines are alike', () => {
    expect(pairLines(['return total;'], ['return total * 2;'], 0, 0)).toEqual([{ a: 0, b: 0, similar: true }]);
  });

  it('matches similar lines even when they are not at the same offset', () => {
    const pairs = pairLines(
      ['const total = sum(items);', 'return total;'],
      ['// new comment', 'const total = sum(items, tax);', 'return total * 2;'],
      0,
      0,
    );
    expect(pairs).toEqual([
      { a: null, b: 0 },
      { a: 0, b: 1, similar: true },
      { a: 1, b: 2, similar: true },
    ]);
  });

  it('falls back to positional pairing for very large regions', () => {
    const a = Array.from({ length: 300 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 301 }, (_, i) => `a${i}`);
    const pairs = pairLines(a, b, 0, 0);
    expect(pairs).toHaveLength(301);
    expect(pairs[0]).toEqual({ a: 0, b: 0, similar: true });
    expect(pairs[300]).toEqual({ a: null, b: 300 });
  });
});
