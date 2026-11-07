import { diffSequences, type SequenceDiff } from './myers';

/**
 * Histogram diff for lines, after Git's `--histogram` (JGit's HistogramDiff) and the patience
 * diff it extends: instead of the smallest possible set of changes, anchor on *rare* lines (a
 * function's signature, a distinctive statement) and never let common ones (`}`, blank lines,
 * `return result;`) pull unrelated code into alignment. On source code this reads much better
 * when blocks are moved or rewritten; the price is a slightly larger diff now and then, by
 * design. How rare a line must be is MAX_CHAIN (once on each side, as in patience diff: Git's
 * looser limit measured worse; see there).
 *
 * In each region (after trimming lines equal at both ends):
 *   1. Count how often each line occurs on each side. The candidates are the rarest lines that
 *      occur equally often on both (once each, at best), paired in order: the first occurrence
 *      on the left with the first on the right, and so on.
 *   2. Take the chain of those pairs that keeps both sides in order and has the most weight,
 *      each pair weighing as much as the run of equal lines around it, as anchors. (Patience
 *      diff takes the longest chain; weighing by runs keeps a single moved line from being
 *      chosen over the real correspondences around it.)
 *   3. Treat each gap between anchors as a new region.
 * A region whose shared lines are all too common (over MAX_CHAIN occurrences) goes to Myers,
 * which handles it exactly; one with no shared lines at all is all changed.
 *
 * Git splits a region at one match at a time and rebuilds its table for each side, which on a
 * file with evenly spread edits makes the work grow with the square of the file's length (a
 * million-line file with an edit every 500 lines would take billions of steps). Taking every
 * ordered match of the rarest lines in one pass splits a region into many small ones at once,
 * so each pass costs about n log n and few passes are needed.
 */

/**
 * Lines occurring more often than this on either side (in a region) are too common to anchor
 * on. Git allows up to 64 occurrences on the left; measured on 10,000 random edits of
 * repetitive text, anchoring only on lines that occur once on each side gave the smallest diff
 * in 96.6% of cases (never more than 76% larger), against 89.8% (up to 350% larger) when twice
 * was allowed, and worse beyond; on code-like text and on real files every setting gave the
 * same result. Regions without such lines go to Myers, which is exact.
 */
export const MAX_CHAIN = 1;

/**
 * Inputs up to this many lines (both sides together) are also diffed with Myers, and Myers'
 * result is used when the histogram one is clearly larger (SAFETY_MARGIN). Anchoring on rare
 * lines can't always tell a moved line from a real correspondence: in very repetitive text a
 * single moved line can lock a region out of alignment. On code the two agree or histogram is
 * smaller, so this rarely changes anything; on such text it bounds the damage. A diff of this
 * size takes milliseconds, so doing both is cheap; larger inputs skip it.
 */
export const SAFETY_LIMIT = 50_000;
/** Histogram's result is replaced when it changes more than this many times Myers' lines (plus a few). */
const SAFETY_MARGIN = 1.25;

export function histogramDiff(a: Int32Array, b: Int32Array): SequenceDiff {
  const h = histogramOnly(a, b);
  if (a.length + b.length > SAFETY_LIMIT) return h;
  const m = diffSequences(a, b);
  return changedCount(h) > changedCount(m) * SAFETY_MARGIN + 4 ? m : h;
}

const changedCount = (d: SequenceDiff) => {
  let n = 0;
  for (let i = 0; i < d.changedA.length; i++) n += d.changedA[i];
  for (let j = 0; j < d.changedB.length; j++) n += d.changedB[j];
  return n;
};

/** Histogram diff without the safety net (exported for tests). */
export function histogramOnly(a: Int32Array, b: Int32Array): SequenceDiff {
  const changedA = new Uint8Array(a.length);
  const changedB = new Uint8Array(b.length);
  let maxKey = -1;
  for (let i = 0; i < a.length; i++) if (a[i] > maxKey) maxKey = a[i];
  for (let i = 0; i < b.length; i++) if (b[i] > maxKey) maxKey = b[i];
  // Scratch tables indexed by line key, cleared after each region (only the keys it touched).
  const countA = new Int32Array(maxKey + 1);
  const countB = new Int32Array(maxKey + 1);
  /** Per key, how many of its right occurrences have been paired so far in this region. */
  const seenB = new Int32Array(maxKey + 1);
  /** Per key, the first left position in the region; `nextA` chains the rest in order. */
  const headA = new Int32Array(maxKey + 1).fill(-1);
  const nextA = new Int32Array(a.length);
  /** Per key, its number within the region being handed to Myers (-1: none yet). */
  const local = new Int32Array(maxKey + 1).fill(-1);

  // Regions still to do, as [aStart, aEnd, bStart, bEnd]: a stack, so depth can't overflow.
  const stack: number[] = [0, a.length, 0, b.length];
  while (stack.length) {
    let be = stack.pop()!;
    let bs = stack.pop()!;
    let ae = stack.pop()!;
    let as = stack.pop()!;

    // Lines equal at both ends are matched as they are.
    while (as < ae && bs < be && a[as] === b[bs]) {
      as++;
      bs++;
    }
    while (as < ae && bs < be && a[ae - 1] === b[be - 1]) {
      ae--;
      be--;
    }
    if (as === ae || bs === be) {
      for (let i = as; i < ae; i++) changedA[i] = 1;
      for (let j = bs; j < be; j++) changedB[j] = 1;
      continue;
    }

    for (let i = ae - 1; i >= as; i--) {
      const k = a[i];
      countA[k]++;
      nextA[i] = headA[k];
      headA[k] = i;
    }
    for (let j = bs; j < be; j++) countB[b[j]]++;

    // The rarest lines occurring equally often on both sides (once each, at best), which pair
    // up in order. A line once on the left but several times on the right isn't used here:
    // which occurrence it belongs to is a guess, and a wrong one drags everything around it out
    // of line. (Git weighs that guess by the run of equal lines around each candidate.)
    let rarest = Infinity;
    let shared = false;
    for (let j = bs; j < be; j++) {
      const k = b[j];
      const c = countA[k];
      if (c > 0) shared = true;
      if (c > 0 && c === countB[k] && c < rarest) rarest = c;
    }

    let anchors: Int32Array | null = null;
    if (rarest <= MAX_CHAIN) {
      // Every match of those lines, ordered by right position (and, for one right line
      // matching several left ones, by falling left position, so the chain uses one of them).
      const pi: number[] = [];
      const pj: number[] = [];
      for (let j = bs; j < be; j++) {
        const k = b[j];
        if (countA[k] !== rarest || countB[k] !== rarest) continue;
        // The n-th occurrence on the right pairs with the n-th on the left.
        let i = headA[k];
        for (let n = seenB[k]++; n > 0; n--) i = nextA[i];
        pi.push(i);
        pj.push(j);
      }
      // Weigh each pair by the run of equal lines around it: a line that moved on its own has
      // no matching neighbours, while real correspondences sit in runs (Git's histogram makes
      // the same distinction by preferring the longest run).
      // Each run is measured once: a match inside a run already measured on its diagonal
      // shares that run (otherwise a long run would be walked once per unique line in it).
      const weight: number[] = new Array(pi.length);
      const runs = new Map<number, [number, number, number]>(); // diagonal → [start, end, length]
      for (let k = 0; k < pi.length; k++) {
        const diagonal = pi[k] - pj[k];
        const known = runs.get(diagonal);
        if (known && pi[k] >= known[0] && pi[k] < known[1]) {
          weight[k] = known[2];
          continue;
        }
        let x = pi[k];
        let y = pj[k];
        while (x > as && y > bs && a[x - 1] === b[y - 1]) {
          x--;
          y--;
        }
        let ex = pi[k] + 1;
        let ey = pj[k] + 1;
        while (ex < ae && ey < be && a[ex] === b[ey]) {
          ex++;
          ey++;
        }
        weight[k] = ex - x;
        runs.set(diagonal, [x, ex, ex - x]);
      }
      anchors = heaviestIncreasing(pi, pj, weight, as, ae);
    }

    for (let i = as; i < ae; i++) {
      countA[a[i]] = 0;
      headA[a[i]] = -1;
    }
    for (let j = bs; j < be; j++) {
      countB[b[j]] = 0;
      seenB[b[j]] = 0;
    }

    if (!shared) {
      // No line in common: everything here changed (what Myers would find, without asking it).
      for (let i = as; i < ae; i++) changedA[i] = 1;
      for (let j = bs; j < be; j++) changedB[j] = 1;
      continue;
    }
    if (!anchors || anchors.length === 0) {
      // Shared lines, but all too common to anchor on: Myers does this region exactly. Lines
      // are renumbered from 0 first, as its tables are sized by the largest line number.
      let next = 0;
      const ra = new Int32Array(ae - as);
      const rb = new Int32Array(be - bs);
      for (let i = as; i < ae; i++) ra[i - as] = local[a[i]] === -1 ? (local[a[i]] = next++) : local[a[i]];
      for (let j = bs; j < be; j++) rb[j - bs] = local[b[j]] === -1 ? (local[b[j]] = next++) : local[b[j]];
      for (let i = as; i < ae; i++) local[a[i]] = -1;
      for (let j = bs; j < be; j++) local[b[j]] = -1;
      const sub = diffSequences(ra, rb);
      changedA.set(sub.changedA, as);
      changedB.set(sub.changedB, bs);
      continue;
    }
    // The gaps between anchors (the anchored lines themselves match).
    let pa = as;
    let pb = bs;
    for (let x = 0; x < anchors.length; x += 2) {
      stack.push(pa, anchors[x], pb, anchors[x + 1]);
      pa = anchors[x] + 1;
      pb = anchors[x + 1] + 1;
    }
    stack.push(pa, ae, pb, be);
  }
  return { changedA, changedB };
}

/**
 * The chain of matches (pi[k], pj[k]) with both positions strictly increasing and the largest
 * total weight, as flat [i, j, i, j, …] pairs in order. The matches arrive sorted by j (one per
 * j), so it's the heaviest strictly increasing run of i, found with a Fenwick tree of the best
 * chain ending below each left position (n log n). Of equally heavy chains, the one completed
 * first (earliest on the right) wins, as in Git, where a later candidate must be better.
 */
function heaviestIncreasing(pi: number[], pj: number[], weight: number[], lo: number, hi: number): Int32Array {
  const n = pi.length;
  if (n === 0) return new Int32Array(0);
  const size = hi - lo;
  // tree[x]: the heaviest chain ending at a left position in its range, as [weight, match].
  const treeW = new Float64Array(size + 1);
  const treeK = new Int32Array(size + 1).fill(-1);
  const best = new Float64Array(n);
  const prev = new Int32Array(n);
  let top = -1;
  for (let k = 0; k < n; k++) {
    const pos = pi[k] - lo; // 0-based within the region
    // The heaviest chain ending strictly left of pos.
    let w = 0;
    let from = -1;
    for (let x = pos; x > 0; x -= x & -x) {
      if (treeW[x] > w) {
        w = treeW[x];
        from = treeK[x];
      }
    }
    best[k] = w + weight[k];
    prev[k] = from;
    for (let x = pos + 1; x <= size; x += x & -x) {
      if (best[k] > treeW[x]) {
        treeW[x] = best[k];
        treeK[x] = k;
      }
    }
    if (top === -1 || best[k] > best[top]) top = k;
  }
  let len = 0;
  for (let k = top; k !== -1; k = prev[k]) len++;
  const out = new Int32Array(len * 2);
  for (let k = top, x = len - 1; k !== -1; k = prev[k], x--) {
    out[x * 2] = pi[k];
    out[x * 2 + 1] = pj[k];
  }
  return out;
}
