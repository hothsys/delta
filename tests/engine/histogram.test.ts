import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/engine';
import { histogramDiff, MAX_CHAIN } from '../../src/engine/histogram';
import { diffSequences } from '../../src/engine/myers';

const seq = (xs: number[]) => Int32Array.from(xs);
let seed = 11;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** The unchanged elements, in order, must be equal and present on both sides (a common subsequence). */
function expectValid(a: Int32Array, b: Int32Array, r: { changedA: Uint8Array; changedB: Uint8Array }) {
  const keptA = Array.from(a).filter((_, i) => !r.changedA[i]);
  const keptB = Array.from(b).filter((_, j) => !r.changedB[j]);
  expect(keptA).toEqual(keptB);
}
const changes = (r: { changedA: Uint8Array; changedB: Uint8Array }) => r.changedA.reduce((n, x) => n + x, 0) + r.changedB.reduce((n, x) => n + x, 0);

/** Equal rows of a line diff, as [leftLine, rightLine] pairs. */
function equalPairs(a: string[], b: string[], algorithm: 'histogram' | 'myers') {
  const out: [number, number][] = [];
  for (const blk of diffLines(a, b, { algorithm }).blocks) {
    if (blk.kind !== 'equal') continue;
    for (let i = blk.a.start, j = blk.b.start; i < blk.a.end; i++, j++) out.push([i, j]);
  }
  return out;
}

describe('histogramDiff', () => {
  it('handles empty and identical inputs, and inputs with nothing in common', () => {
    expect(changes(histogramDiff(seq([]), seq([])))).toBe(0);
    expect(Array.from(histogramDiff(seq([]), seq([1, 2])).changedB)).toEqual([1, 1]);
    expect(changes(histogramDiff(seq([1, 2, 3]), seq([1, 2, 3])))).toBe(0);
    expect(changes(histogramDiff(seq([1, 2]), seq([3, 4])))).toBe(4);
  });

  it('always returns a valid alignment, never far larger than the minimal one', () => {
    for (let round = 0; round < 300; round++) {
      const vocab = 2 + Math.floor(rand() * 30);
      const a = Array.from({ length: Math.floor(rand() * 80) }, () => Math.floor(rand() * vocab));
      const b = a.filter(() => rand() > 0.15).map((x) => (rand() < 0.1 ? Math.floor(rand() * vocab) : x));
      for (let k = 0; k < rand() * 5; k++) b.splice(Math.floor(rand() * (b.length + 1)), 0, Math.floor(rand() * vocab));
      const sa = seq(a);
      const sb = seq(b);
      const h = histogramDiff(sa, sb);
      expectValid(sa, sb, h);
      const minimal = changes(diffSequences(sa, sb, { minimal: true }));
      // Not minimal by design, but never much larger: Myers (with its cost limit) is the safety
      // net, and is itself close to minimal on inputs this size.
      expect(changes(h)).toBeLessThanOrEqual(Math.ceil(minimal * 1.25 * 1.25) + 8);
    }
  });

  it('falls back to Myers when the only shared lines are very common', () => {
    const a = seq(Array.from({ length: 200 }, (_, i) => i % 2));
    const b = seq(Array.from({ length: 200 }, (_, i) => (i + 1) % 2));
    expect(MAX_CHAIN).toBeLessThan(5);
    const r = histogramDiff(a, b);
    expectValid(a, b, r);
    expect(changes(r)).toBe(changes(diffSequences(a, b)));
  });

  it('prefers the first of equally good matches, as Git does', () => {
    // "shared" (left 1) or "x" (left 0) can be kept, not both; Git keeps the one found first on the right.
    expect(equalPairs(['x', 'shared', 'y'], ['shared', 'p', 'q', 'x'], 'histogram')).toEqual([[1, 0]]);
  });
});

describe('histogram diff reads better on code', () => {
  const fn = (name: string, body: string[]) => [`function ${name}(input) {`, ...body.map((l) => `  ${l}`), '  return result;', '}', ''];

  it('keeps a moved function whole instead of matching its common lines elsewhere', () => {
    const level = fn('level', ['const result = input * 2;', 'log(result);']);
    const parse = fn('parse', ['const result = JSON.parse(input);', 'validate(result);', 'normalise(result);']);
    const render = fn('render', ['const result = template(input);', 'escape(result);']);
    const a = [...level, ...parse, ...render];
    const b = [...parse, ...render, ...level]; // level() moved to the end
    const owner = (lines: string[]) => {
      let current = '';
      return lines.map((l) => (l.startsWith('function ') ? (current = l) : current));
    };
    const [oa, ob] = [owner(a), owner(b)];
    for (const [i, j] of equalPairs(a, b, 'histogram')) expect(ob[j], `left ${i + 1} "${a[i]}" matched right ${j + 1}`).toBe(oa[i]);
  });

  it('matches generic lines (try:, blanks) where their section is, not far away', () => {
    // The shape of a real pair: a short script, and a long one with the same section near the
    // top plus hundreds of unrelated lines further down that reuse the same generic lines.
    const section = ['def _ensure_dependencies():', '    try:', '        import flask', '    except ImportError:', '        subprocess.check_call(cmd)', '', '_ensure_dependencies()', ''];
    const a = ['#!/usr/bin/env python3', '', ...section, 'main()'];
    const filler = Array.from({ length: 400 }, (_, i) => (i % 5 === 0 ? '    try:' : i % 5 === 1 ? '' : i % 5 === 2 ? '    except ImportError:' : `    work_${i}()`));
    const b = ['#!/usr/bin/env python3', '', 'import os', ...section, ...filler, 'main()'];
    const sectionRows = new Set(Array.from({ length: section.length }, (_, k) => 3 + k));
    for (const [i, j] of equalPairs(a, b, 'histogram')) {
      if (i >= 2 && i < 2 + section.length) expect(sectionRows.has(j), `left ${i + 1} "${a[i]}" matched right ${j + 1}`).toBe(true);
    }
  });
});
