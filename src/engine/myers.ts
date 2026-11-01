/**
 * Myers' O(ND) difference algorithm, linear-space variant.
 *
 * E. Myers, "An O(ND) Difference Algorithm and Its Variations", Algorithmica 1 (1986).
 * The middle-snake search and the "too expensive" cut-off follow GNU diff's `analyze.c`.
 *
 * Sequences are arrays of non-negative integer keys (see `Interner`), so the hot loops
 * compare numbers and never touch strings.
 */

export interface MyersOptions {
  /** Find a minimal edit script even when it is expensive. Default `false`. */
  minimal?: boolean;
}

/** Per-element change marks: `changedA[i] === 1` means `a[i]` is not part of the common subsequence. */
export interface SequenceDiff {
  changedA: Uint8Array;
  changedB: Uint8Array;
}

/** A maximal changed region. Either side may be empty, but not both. */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

const INT_MAX = 0x7fffffff;

export function diffSequences(a: Int32Array, b: Int32Array, options: MyersOptions = {}): SequenceDiff {
  const changedA = new Uint8Array(a.length);
  const changedB = new Uint8Array(b.length);

  // An element that never occurs in the other sequence cannot be in any common subsequence,
  // so it is removed before running Myers. This keeps the result exact while making
  // heavily rewritten inputs (where most changed elements are unique) nearly free.
  let maxKey = -1;
  for (let i = 0; i < a.length; i++) if (a[i] > maxKey) maxKey = a[i];
  for (let i = 0; i < b.length; i++) if (b[i] > maxKey) maxKey = b[i];
  const inA = new Uint8Array(maxKey + 1);
  const inB = new Uint8Array(maxKey + 1);
  for (let i = 0; i < a.length; i++) inA[a[i]] = 1;
  for (let i = 0; i < b.length; i++) inB[b[i]] = 1;

  const [ra, mapA] = keepWhere(a, inB, changedA);
  const [rb, mapB] = keepWhere(b, inA, changedB);

  const rChangedA = new Uint8Array(ra.length);
  const rChangedB = new Uint8Array(rb.length);
  compare(ra, rb, rChangedA, rChangedB, options.minimal ?? false);

  for (let i = 0; i < ra.length; i++) if (rChangedA[i]) changedA[mapA[i]] = 1;
  for (let i = 0; i < rb.length; i++) if (rChangedB[i]) changedB[mapB[i]] = 1;
  return { changedA, changedB };
}

/** Keeps elements whose key is present in `allowed`; marks the rest as changed. */
function keepWhere(seq: Int32Array, allowed: Uint8Array, changed: Uint8Array): [Int32Array, Int32Array] {
  const kept = new Int32Array(seq.length);
  const map = new Int32Array(seq.length);
  let n = 0;
  for (let i = 0; i < seq.length; i++) {
    if (allowed[seq[i]]) {
      kept[n] = seq[i];
      map[n] = i;
      n++;
    } else {
      changed[i] = 1;
    }
  }
  return [kept.subarray(0, n), map.subarray(0, n)];
}

/** Collapses change marks into maximal hunks. */
export function marksToHunks(changedA: Uint8Array, changedB: Uint8Array): Hunk[] {
  const hunks: Hunk[] = [];
  const n = changedA.length;
  const m = changedB.length;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && !changedA[i] && !changedB[j]) {
      i++;
      j++;
      continue;
    }
    const aStart = i;
    const bStart = j;
    while (i < n && changedA[i]) i++;
    while (j < m && changedB[j]) j++;
    if (i === aStart && j === bStart) {
      throw new Error('Inconsistent change marks: unchanged element counts differ');
    }
    hunks.push({ aStart, aEnd: i, bStart, bEnd: j });
  }
  return hunks;
}

function compare(a: Int32Array, b: Int32Array, ca: Uint8Array, cb: Uint8Array, minimal: boolean): void {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    ca.fill(1);
    cb.fill(1);
    return;
  }

  // Diagonals k = x - y range over [-m - 1, n + 1]; `off` shifts them to array indexes.
  const fd = new Int32Array(n + m + 3);
  const bd = new Int32Array(n + m + 3);
  const off = m + 1;
  const tooExpensive = minimal ? INT_MAX : costLimit(n + m + 3);
  const mid = new Int32Array(2);

  // Explicit stack instead of recursion so pathological inputs cannot overflow the call stack.
  const stack: number[] = [0, n, 0, m];
  while (stack.length > 0) {
    let ylim = stack.pop()!;
    let yoff = stack.pop()!;
    let xlim = stack.pop()!;
    let xoff = stack.pop()!;

    while (xoff < xlim && yoff < ylim && a[xoff] === b[yoff]) {
      xoff++;
      yoff++;
    }
    while (xoff < xlim && yoff < ylim && a[xlim - 1] === b[ylim - 1]) {
      xlim--;
      ylim--;
    }

    if (xoff === xlim) {
      cb.fill(1, yoff, ylim);
      continue;
    }
    if (yoff === ylim) {
      ca.fill(1, xoff, xlim);
      continue;
    }

    middleSnake(a, b, xoff, xlim, yoff, ylim, fd, bd, off, tooExpensive, mid);
    const xmid = mid[0];
    const ymid = mid[1];

    // A split must shrink the problem; otherwise give up on this region rather than loop forever.
    const degenerate =
      (xmid === xoff && ymid === yoff) ||
      (xmid === xlim && ymid === ylim) ||
      xmid < xoff || xmid > xlim || ymid < yoff || ymid > ylim;
    if (degenerate) {
      ca.fill(1, xoff, xlim);
      cb.fill(1, yoff, ylim);
      continue;
    }

    stack.push(xmid, xlim, ymid, ylim);
    stack.push(xoff, xmid, yoff, ymid);
  }
}

/**
 * Number of edit steps after which the middle-snake search settles for a good-enough split.
 * Roughly the square root of the problem size, but never below 4096 (as in GNU diff).
 */
function costLimit(diagonals: number): number {
  let limit = 1;
  for (let d = diagonals; d !== 0; d >>>= 2) limit <<= 1;
  return Math.max(4096, limit);
}

/**
 * Finds the midpoint of a shortest edit path for `a[xoff..xlim)` vs `b[yoff..ylim)` by running
 * the forward and backward searches simultaneously until they overlap. Writes it to `out`.
 */
function middleSnake(
  a: Int32Array,
  b: Int32Array,
  xoff: number,
  xlim: number,
  yoff: number,
  ylim: number,
  fd: Int32Array,
  bd: Int32Array,
  off: number,
  tooExpensive: number,
  out: Int32Array,
): void {
  const dmin = xoff - ylim;
  const dmax = xlim - yoff;
  const fmid = xoff - yoff;
  const bmid = xlim - ylim;
  let fmin = fmid;
  let fmax = fmid;
  let bmin = bmid;
  let bmax = bmid;
  const odd = ((fmid - bmid) & 1) !== 0;

  fd[off + fmid] = xoff;
  bd[off + bmid] = xlim;

  for (let c = 1; ; c++) {
    // Extend the forward search by one edit step on each diagonal.
    if (fmin > dmin) fd[off + --fmin - 1] = -1;
    else ++fmin;
    if (fmax < dmax) fd[off + ++fmax + 1] = -1;
    else --fmax;
    for (let d = fmax; d >= fmin; d -= 2) {
      const tlo = fd[off + d - 1];
      const thi = fd[off + d + 1];
      let x = tlo < thi ? thi : tlo + 1;
      let y = x - d;
      while (x < xlim && y < ylim && a[x] === b[y]) {
        x++;
        y++;
      }
      fd[off + d] = x;
      if (odd && bmin <= d && d <= bmax && bd[off + d] <= x) {
        out[0] = x;
        out[1] = y;
        return;
      }
    }

    // Extend the backward search likewise.
    if (bmin > dmin) bd[off + --bmin - 1] = INT_MAX;
    else ++bmin;
    if (bmax < dmax) bd[off + ++bmax + 1] = INT_MAX;
    else --bmax;
    for (let d = bmax; d >= bmin; d -= 2) {
      const tlo = bd[off + d - 1];
      const thi = bd[off + d + 1];
      let x = tlo < thi ? tlo : thi - 1;
      let y = x - d;
      while (x > xoff && y > yoff && a[x - 1] === b[y - 1]) {
        x--;
        y--;
      }
      bd[off + d] = x;
      if (!odd && fmin <= d && d <= fmax && x <= fd[off + d]) {
        out[0] = x;
        out[1] = y;
        return;
      }
    }

    if (c >= tooExpensive) {
      // Give up on minimality: split at whichever search frontier has made the most progress.
      let fxybest = -1;
      let fxbest = xoff;
      for (let d = fmax; d >= fmin; d -= 2) {
        let x = Math.min(fd[off + d], xlim);
        let y = x - d;
        if (y > ylim) {
          x = ylim + d;
          y = ylim;
        }
        if (x + y > fxybest) {
          fxybest = x + y;
          fxbest = x;
        }
      }
      let bxybest = INT_MAX;
      let bxbest = xlim;
      for (let d = bmax; d >= bmin; d -= 2) {
        let x = Math.max(xoff, bd[off + d]);
        let y = x - d;
        if (y < yoff) {
          x = yoff + d;
          y = yoff;
        }
        if (x + y < bxybest) {
          bxybest = x + y;
          bxbest = x;
        }
      }
      if (xlim + ylim - bxybest < fxybest - (xoff + yoff)) {
        out[0] = fxbest;
        out[1] = fxybest - fxbest;
      } else {
        out[0] = bxbest;
        out[1] = bxybest - bxbest;
      }
      return;
    }
  }
}
