import { describe, expect, it } from 'vitest';
import { diffSequences, marksToHunks } from '../../src/engine/myers';

const seq = (xs: number[]) => Int32Array.from(xs);

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lcsLength(a: Int32Array, b: Int32Array): number {
  const row = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

/** Asserts the marks describe a valid alignment and returns the length of the common subsequence. */
function checkValid(a: Int32Array, b: Int32Array, changedA: Uint8Array, changedB: Uint8Array): number {
  const keptA = a.filter((_, i) => !changedA[i]);
  const keptB = b.filter((_, i) => !changedB[i]);
  expect(Array.from(keptA)).toEqual(Array.from(keptB));
  return keptA.length;
}

describe('diffSequences', () => {
  it('reports nothing for identical sequences', () => {
    const { changedA, changedB } = diffSequences(seq([1, 2, 3]), seq([1, 2, 3]));
    expect(Array.from(changedA)).toEqual([0, 0, 0]);
    expect(Array.from(changedB)).toEqual([0, 0, 0]);
  });

  it('handles empty inputs', () => {
    expect(Array.from(diffSequences(seq([]), seq([1, 2])).changedB)).toEqual([1, 1]);
    expect(Array.from(diffSequences(seq([1, 2]), seq([])).changedA)).toEqual([1, 1]);
    const empty = diffSequences(seq([]), seq([]));
    expect(empty.changedA.length + empty.changedB.length).toBe(0);
  });

  it('finds an insertion', () => {
    const { changedA, changedB } = diffSequences(seq([1, 2, 3]), seq([1, 2, 9, 3]));
    expect(marksToHunks(changedA, changedB)).toEqual([{ aStart: 2, aEnd: 2, bStart: 2, bEnd: 3 }]);
  });

  it('finds a deletion', () => {
    const { changedA, changedB } = diffSequences(seq([1, 2, 3, 4]), seq([1, 4]));
    expect(marksToHunks(changedA, changedB)).toEqual([{ aStart: 1, aEnd: 3, bStart: 1, bEnd: 1 }]);
  });

  it('finds a replacement', () => {
    const { changedA, changedB } = diffSequences(seq([1, 2, 3]), seq([1, 7, 3]));
    expect(marksToHunks(changedA, changedB)).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  });

  it('marks everything changed when nothing is shared', () => {
    const { changedA, changedB } = diffSequences(seq([1, 2, 3]), seq([4, 5]));
    expect(marksToHunks(changedA, changedB)).toEqual([{ aStart: 0, aEnd: 3, bStart: 0, bEnd: 2 }]);
  });

  it('is valid and minimal on random inputs', () => {
    const rand = rng(42);
    for (let iter = 0; iter < 3000; iter++) {
      const alphabet = 1 + Math.floor(rand() * 6);
      const gen = () => seq(Array.from({ length: Math.floor(rand() * 25) }, () => Math.floor(rand() * alphabet)));
      const a = gen();
      const b = gen();
      const { changedA, changedB } = diffSequences(a, b);
      const common = checkValid(a, b, changedA, changedB);
      expect(common, `a=${a} b=${b}`).toBe(lcsLength(a, b));
    }
  });

  it('is valid and minimal on random edits of a base sequence', () => {
    const rand = rng(7);
    for (let iter = 0; iter < 500; iter++) {
      const base = Array.from({ length: 200 }, () => Math.floor(rand() * 20));
      const edited = base.slice();
      for (let e = 0; e < 15; e++) {
        const p = Math.floor(rand() * (edited.length + 1));
        const r = rand();
        if (r < 0.33) edited.splice(p, 1);
        else if (r < 0.66) edited.splice(p, 0, Math.floor(rand() * 25));
        else edited[p] = Math.floor(rand() * 25);
      }
      const a = seq(base);
      const b = seq(edited);
      const { changedA, changedB } = diffSequences(a, b);
      expect(checkValid(a, b, changedA, changedB)).toBe(lcsLength(a, b));
    }
  });

  it('stays valid and fast on pathological input once the cost limit kicks in', () => {
    const rand = rng(3);
    // Two distinct keys in random order: huge edit distance and very many equal-length paths.
    const a = seq(Array.from({ length: 30_000 }, () => (rand() < 0.5 ? 0 : 1)));
    const b = seq(Array.from({ length: 30_000 }, () => (rand() < 0.5 ? 0 : 1)));
    const t0 = performance.now();
    const { changedA, changedB } = diffSequences(a, b);
    const elapsed = performance.now() - t0;
    checkValid(a, b, changedA, changedB);
    expect(elapsed).toBeLessThan(5000);
  });
});
