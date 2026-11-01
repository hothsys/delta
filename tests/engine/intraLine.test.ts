import { describe, expect, it } from 'vitest';
import { diffChars, type IntraLineDiff } from '../../src/engine';
import { MAX_TOKENS } from '../../src/engine/intraLine';

/** Renders changed ranges inline as [..] for readable assertions. */
function mark(s: string, ranges: IntraLineDiff['a']): string {
  let out = '';
  let pos = 0;
  for (const r of ranges) {
    out += s.slice(pos, r.start) + '[' + s.slice(r.start, r.end) + ']';
    pos = r.end;
  }
  return out + s.slice(pos);
}

function show(a: string, b: string, opts = {}) {
  const d = diffChars(a, b, opts);
  return [mark(a, d.a), mark(b, d.b)];
}

describe('diffChars', () => {
  it('reports no ranges for identical lines', () => {
    expect(diffChars('same', 'same')).toEqual({ a: [], b: [] });
  });

  it('highlights a single changed character', () => {
    expect(show('let x = 1;', 'let x = 2;')).toEqual(['let x = [1];', 'let x = [2];']);
  });

  it('highlights an insertion on one side only', () => {
    expect(show('foo(a)', 'foo(a, b)')).toEqual(['foo(a)', 'foo(a[, b])']);
  });

  it('highlights whole words, never part of one', () => {
    expect(show('mounted/unmounted in real time', 'mounted or ejected, in real time')).toEqual([
      'mounted[/unmounted] in real time',
      'mounted [or ejected,] in real time',
    ]);
    expect(show('kitten', 'sitting')).toEqual(['[kitten]', '[sitting]']);
  });

  it('lines up real words rather than spaces, and never highlights a lone space', () => {
    expect(show('results, EXIF data, and blur scores', 'results and EXIF data')).toEqual([
      'results[,] EXIF data[, and blur scores]',
      'results [and] EXIF data',
    ]);
  });

  it('never pulls a word that is on both sides into a highlight', () => {
    expect(show('thumbnail card grid grouped by folder', 'thumbnail grid (see docs)')).toEqual([
      'thumbnail [card] grid [grouped by folder]',
      'thumbnail grid [(see docs)]',
    ]);
  });

  it('gives the same highlights with ignoreCase when only case-free text differs', () => {
    const a = '- **EXIF Info**: scans every image (camera, GPS) as a thumbnail card grid grouped by folder';
    const b = '- **EXIF Info**: camera, and GPS across a directory, as a thumbnail grid ([details](docs/exif.md))';
    expect(diffChars(a, b, { ignoreCase: true })).toEqual(diffChars(a, b));
  });

  it('keeps a shared start and end unhighlighted even when most of a long line changed', () => {
    const a = '<button class="btn-outline" onclick="exportExifData()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"></svg>Export EXIF CSV</button>';
    const b = '<button class="btn-outline" id="exif-export-btn" style="padding:5px 14px">Export CSV</button>';
    const d = diffChars(a, b);
    expect(d.a.length).toBeGreaterThan(0);
    expect(d.b.length).toBeGreaterThan(0);
    expect(show(a, b)[0].startsWith('<button class="btn-outline" [')).toBe(true);
    expect(show(a, b)[1].endsWith('Export CSV</button>')).toBe(true);
  });

  it('highlights the whole of two lines that were rewritten rather than edited', () => {
    expect(show('  // Deprecated: use countAll() instead.', '  level(item: Item): number {')).toEqual([
      '  [// Deprecated: use countAll() instead.]',
      '  [level(item: Item): number {]',
    ]);
  });

  it('stays precise for small edits to short lines', () => {
    expect(show('x = 1;', 'x = 2;')).toEqual(['x = [1];', 'x = [2];']);
  });

  it('absorbs short unchanged runs between edits', () => {
    expect(show('GPS coordinates, dimensions', 'GPS across a directory')).toEqual(['GPS [coordinates, dimensions]', 'GPS [across a directory]']);
  });

  it('respects ignoreCase', () => {
    expect(diffChars('Hello World', 'hello world', { ignoreCase: true })).toEqual({ a: [], b: [] });
    expect(show('Hello world', 'hello world')).toEqual(['[Hello] world', '[hello] world']);
  });

  it('does not highlight ignored whitespace', () => {
    expect(diffChars('  x = 1  ', 'x = 1', { whitespace: 'trim' })).toEqual({ a: [], b: [] });
    expect(diffChars('a   b', 'a b', { whitespace: 'collapse' })).toEqual({ a: [], b: [] });
    expect(diffChars('a b', 'ab', { whitespace: 'ignore' })).toEqual({ a: [], b: [] });
    expect(show('a   b', 'a b')).toEqual(['a[   ]b', 'a[ ]b']);
  });

  it('widens highlights to whole words when all whitespace is ignored', () => {
    expect(show('mounted/unmounted', 'mounted or ejected', { whitespace: 'ignore' })).toEqual([
      'mounted[/unmounted]',
      'mounted [or ejected]',
    ]);
  });

  it('highlights changed indentation and spacing between matching words', () => {
    expect(show('    return false;', '      return false;')).toEqual(['[    ]return false;', '[      ]return false;']);
    expect(show('foo (x)', 'foo(x)')).toEqual(['foo[ ](x)', 'foo(x)']);
    expect(diffChars('foo (x)', 'foo  (x)', { whitespace: 'collapse' })).toEqual({ a: [], b: [] });
    expect(diffChars('    return false;', '      return false;', { whitespace: 'trim' })).toEqual({ a: [], b: [] });
  });

  it('still highlights real changes when whitespace is ignored', () => {
    expect(show('  return a;', 'return b;', { whitespace: 'trim' })).toEqual(['  return [a];', 'return [b];']);
  });

  it('never splits a surrogate pair', () => {
    expect(show('a😀b', 'a😃b')).toEqual(['a[😀]b', 'a[😃]b']);
  });

  it('stays fast on very long lines, highlighting between their common start and end', () => {
    // Minified code: tens of thousands of tokens with changes scattered throughout.
    const words = Array.from({ length: MAX_TOKENS }, (_, i) => `w${i}`);
    const a = `start ${words.join(',')} end`;
    const b = `start ${words.map((w, i) => (i % 97 === 5 ? 'x' + w : w)).join(',')} end`;
    const t = performance.now();
    const d = diffChars(a, b);
    expect(performance.now() - t).toBeLessThan(500);
    // One range per side, from the first changed word (w5) to the last one.
    let last = MAX_TOKENS - 1;
    while (last % 97 !== 5) last--;
    const span = (text: string, first: string, final: string) => {
      const start = text.indexOf(`,${first},`) + 1;
      const end = text.indexOf(`,${final},`) + 1 + final.length;
      return [{ start, end }];
    };
    expect(d.a).toEqual(span(a, 'w5', `w${last}`));
    expect(d.b).toEqual(span(b, 'xw5', `xw${last}`));
  });

  it('highlights nothing on long lines that differ only in ignored whitespace', () => {
    const long = Array.from({ length: MAX_TOKENS }, (_, i) => `w${i}`).join(' ');
    expect(diffChars(long, long.replace(/ /g, '  '), { whitespace: 'collapse' })).toEqual({ a: [], b: [] });
  });
});
