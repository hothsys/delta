import type { LinePair } from './types';

/** Lines at least this similar (Dice coefficient over character bigrams) are kept on the same row. */
const SIMILARITY_THRESHOLD = 0.5;
/** Changed regions larger than this (left lines x right lines) are paired positionally. */
const MAX_DP_CELLS = 40_000;

/**
 * Decides which left and right lines of a changed region share a display row.
 *
 * Clearly similar lines are matched first (an order-preserving maximum-similarity alignment),
 * so a line inserted above an edited line does not push the edit out of alignment. The lines
 * left between those matches are then zipped row by row, keeping the block compact; any
 * surplus gets a filler row on the other side. Each pair says whether its lines are similar:
 * zipped lines usually aren't (a block replaced by different code), and the UI shows those
 * as removed and added rather than as edits with word highlights.
 *
 * Similarity ignores letter case (`bravo` and `BRAVO` count as an edit) and spacing: shared
 * indentation would otherwise make any two indented lines look alike.
 *
 * `aKeys`/`bKeys` are the region's lines in comparison form; `aStart`/`bStart` are the
 * absolute indexes of their first lines.
 */
export function pairLines(aKeys: readonly string[], bKeys: readonly string[], aStart: number, bStart: number): LinePair[] {
  const n = aKeys.length;
  const m = bKeys.length;
  const pairs: LinePair[] = [];
  const aLower = aKeys.map(similarityForm);
  const bLower = bKeys.map(similarityForm);
  const aGrams = aLower.map(bigrams);
  const bGrams = bLower.map(bigrams);
  const sim = (i: number, j: number) => similarity(aLower[i], bLower[j], aGrams[i], bGrams[j]);
  const zip = (ai: number, aj: number, bi: number, bj: number) => {
    for (; ai < aj && bi < bj; ai++, bi++) pairs.push({ a: aStart + ai, b: bStart + bi, similar: sim(ai, bi) >= SIMILARITY_THRESHOLD });
    while (ai < aj) pairs.push({ a: aStart + ai++, b: null });
    while (bi < bj) pairs.push({ a: null, b: bStart + bi++ });
  };

  if (n * m > MAX_DP_CELLS) {
    zip(0, n, 0, m);
    return pairs;
  }

  // score[i][j]: best total similarity aligning aKeys[0..i) with bKeys[0..j).
  const w = m + 1;
  const score = new Float64Array((n + 1) * w);
  const move = new Uint8Array((n + 1) * w); // 1 = skip a, 2 = skip b, 3 = match
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = score[(i - 1) * w + j];
      let mv = 1;
      if (score[i * w + j - 1] > best) {
        best = score[i * w + j - 1];
        mv = 2;
      }
      const s = sim(i - 1, j - 1);
      if (s >= SIMILARITY_THRESHOLD && score[(i - 1) * w + j - 1] + s > best) {
        best = score[(i - 1) * w + j - 1] + s;
        mv = 3;
      }
      score[i * w + j] = best;
      move[i * w + j] = mv;
    }
  }

  const matches: [number, number][] = [];
  for (let i = n, j = m; i > 0 && j > 0; ) {
    const mv = move[i * w + j];
    if (mv === 3) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (mv === 1) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();

  let pi = 0;
  let pj = 0;
  for (const [i, j] of matches) {
    zip(pi, i, pj, j);
    pairs.push({ a: aStart + i, b: bStart + j, similar: true });
    pi = i + 1;
    pj = j + 1;
  }
  zip(pi, n, pj, m);
  return pairs;
}

/** Similarity looks at this many characters at most, so very long lines stay cheap to pair. */
const SIMILARITY_CHARS = 500;

/** A line as compared for similarity: lower case, runs of whitespace collapsed, ends trimmed, bounded. */
function similarityForm(key: string): string {
  return key.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, SIMILARITY_CHARS);
}

/** Sorted character bigrams, each packed into one number. */
function bigrams(s: string): Uint32Array {
  if (s.length < 2) return new Uint32Array(0);
  const out = new Uint32Array(s.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = (s.charCodeAt(i) << 16) | s.charCodeAt(i + 1);
  return out.sort();
}

function similarity(a: string, b: string, ga: Uint32Array, gb: Uint32Array): number {
  if (a === b) return 1;
  if (ga.length === 0 || gb.length === 0) return 0;
  let common = 0;
  for (let i = 0, j = 0; i < ga.length && j < gb.length; ) {
    if (ga[i] === gb[j]) {
      common++;
      i++;
      j++;
    } else if (ga[i] < gb[j]) {
      i++;
    } else {
      j++;
    }
  }
  return (2 * common) / (ga.length + gb.length);
}
