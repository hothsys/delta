import { Interner, internAll } from './intern';
import { diffSequences, marksToHunks, type Hunk } from './myers';
import { lineKeyFn, type KeyFn } from './normalize';
import { pairLines } from './pairing';
import type { Anchor, BlockKind, DiffBlock, DiffStats, LineDiffOptions, LineDiffResult, LinePair } from './types';

/**
 * Line-by-line diff of two texts (already split into lines).
 *
 * Manual anchors split both texts into independent segments, each diffed on its own; the
 * anchored lines themselves always share a row. Within a segment, Myers finds the changed
 * hunks, which are then slid to more readable positions and classified into blocks.
 */
export function diffLines(a: readonly string[], b: readonly string[], options: LineDiffOptions = {}): LineDiffResult {
  const keyFn = lineKeyFn(options);
  const interner = new Interner();
  const aKeys = internAll(a, interner, keyFn);
  const bKeys = internAll(b, interner, keyFn);
  const anchors = effectiveAnchors(options.anchors ?? [], a.length, b.length);
  const out = new BlockBuilder(a, b, keyFn);

  const segment = (aStart: number, aEnd: number, bStart: number, bEnd: number) => {
    const sa = aKeys.subarray(aStart, aEnd);
    const sb = bKeys.subarray(bStart, bEnd);
    const { changedA, changedB } = diffSequences(sa, sb, { minimal: options.minimal });
    const hunks = slideHunks(
      marksToHunks(changedA, changedB),
      sa,
      sb,
      (i) => isBlank(a[aStart + i]),
      (i) => isBlank(b[bStart + i]),
    );
    let i = 0;
    let j = 0;
    for (const h of hunks) {
      out.matched(aStart + i, bStart + j, h.aStart - i);
      out.changed(aStart + h.aStart, aStart + h.aEnd, bStart + h.bStart, bStart + h.bEnd);
      i = h.aEnd;
      j = h.bEnd;
    }
    out.matched(aStart + i, bStart + j, aEnd - aStart - i);
  };

  let aPos = 0;
  let bPos = 0;
  for (const { a: ai, b: bi } of anchors) {
    segment(aPos, ai, bPos, bi);
    if (aKeys[ai] === bKeys[bi]) out.matched(ai, bi, 1);
    else out.changed(ai, ai + 1, bi, bi + 1);
    aPos = ai + 1;
    bPos = bi + 1;
  }
  segment(aPos, a.length, bPos, b.length);

  return { blocks: out.blocks, stats: out.stats(), anchors };
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/**
 * Sorts anchors and drops any that are out of range or would cross an earlier one
 * (alignment must keep both sides in order).
 */
function effectiveAnchors(anchors: readonly Anchor[], n: number, m: number): Anchor[] {
  const sorted = anchors
    .filter(({ a, b }) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a < n && b >= 0 && b < m)
    .slice()
    .sort((x, y) => x.a - y.a || x.b - y.b);
  const kept: Anchor[] = [];
  for (const anc of sorted) {
    const last = kept[kept.length - 1];
    if (!last || (anc.a > last.a && anc.b > last.b)) kept.push({ a: anc.a, b: anc.b });
  }
  return kept;
}

/**
 * A pure insertion or deletion can often be shifted up or down without changing the diff's
 * size; for example, inserting a function after another function is equally valid with the
 * inserted block starting at the blank separator line. Prefer the position whose last line is
 * blank (so the block reads as a self-contained unit), otherwise the lowest position, and
 * merge hunks that end up touching.
 */
function slideHunks(
  hunks: Hunk[],
  aKeys: Int32Array,
  bKeys: Int32Array,
  aBlank: (i: number) => boolean,
  bBlank: (i: number) => boolean,
): Hunk[] {
  for (let h = 0; h < hunks.length; h++) {
    const cur = hunks[h];
    const isInsert = cur.aStart === cur.aEnd;
    const isDelete = cur.bStart === cur.bEnd;
    if (isInsert === isDelete) continue;

    const keys = isInsert ? bKeys : aKeys;
    const blank = isInsert ? bBlank : aBlank;
    const start = isInsert ? cur.bStart : cur.aStart;
    const len = isInsert ? cur.bEnd - cur.bStart : cur.aEnd - cur.aStart;
    const prev = hunks[h - 1];
    const next = hunks[h + 1];
    const floor = prev ? (isInsert ? prev.bEnd : prev.aEnd) : 0;
    const ceiling = next ? (isInsert ? next.bStart : next.aStart) : keys.length;

    let lo = start;
    while (lo > floor && keys[lo - 1] === keys[lo + len - 1]) lo--;
    let hi = start;
    while (hi + len < ceiling && keys[hi] === keys[hi + len]) hi++;
    if (lo === hi) continue;

    let pos = hi;
    while (pos >= lo && !blank(pos + len - 1)) pos--;
    if (pos < lo) pos = hi;

    const delta = pos - start;
    cur.aStart += delta;
    cur.aEnd += delta;
    cur.bStart += delta;
    cur.bEnd += delta;
  }

  const merged: Hunk[] = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    if (last && last.aEnd === h.aStart && last.bEnd === h.bStart) {
      last.aEnd = h.aEnd;
      last.bEnd = h.bEnd;
    } else {
      merged.push(h);
    }
  }
  return merged;
}

/** Appends blocks in order, coalescing neighbours of the same kind. */
class BlockBuilder {
  readonly blocks: DiffBlock[] = [];

  constructor(
    private readonly a: readonly string[],
    private readonly b: readonly string[],
    private readonly keyFn: KeyFn | null,
  ) {}

  /** `len` lines that match under the comparison options, starting at `aStart`/`bStart`. */
  matched(aStart: number, bStart: number, len: number): void {
    if (len <= 0) return;
    if (!this.keyFn) {
      this.push('equal', aStart, aStart + len, bStart, bStart + len);
      return;
    }
    for (let k = 0; k < len; ) {
      const kind: BlockKind = this.a[aStart + k] === this.b[bStart + k] ? 'equal' : 'unimportant';
      let e = k + 1;
      while (e < len && (this.a[aStart + e] === this.b[bStart + e]) === (kind === 'equal')) e++;
      this.push(kind, aStart + k, aStart + e, bStart + k, bStart + e);
      k = e;
    }
  }

  changed(aStart: number, aEnd: number, bStart: number, bEnd: number): void {
    if (aStart === aEnd && bStart === bEnd) return;
    if (aStart === aEnd) {
      this.push('insert', aStart, aEnd, bStart, bEnd);
    } else if (bStart === bEnd) {
      this.push('delete', aStart, aEnd, bStart, bEnd);
    } else {
      const key = (lines: readonly string[], i: number) => (this.keyFn ? this.keyFn(lines[i]) : lines[i]);
      const aKeyStrs = Array.from({ length: aEnd - aStart }, (_, k) => key(this.a, aStart + k));
      const bKeyStrs = Array.from({ length: bEnd - bStart }, (_, k) => key(this.b, bStart + k));
      this.push('modify', aStart, aEnd, bStart, bEnd, pairLines(aKeyStrs, bKeyStrs, aStart, bStart));
    }
  }

  stats(): DiffStats {
    const s: DiffStats = {
      equalLines: 0,
      unimportantLines: 0,
      modifiedPairs: 0,
      insertedLines: 0,
      deletedLines: 0,
      changeBlocks: 0,
    };
    for (const blk of this.blocks) {
      const aLen = blk.a.end - blk.a.start;
      const bLen = blk.b.end - blk.b.start;
      switch (blk.kind) {
        case 'equal':
          s.equalLines += aLen;
          break;
        case 'unimportant':
          s.unimportantLines += aLen;
          break;
        case 'insert':
          s.insertedLines += bLen;
          s.changeBlocks++;
          break;
        case 'delete':
          s.deletedLines += aLen;
          s.changeBlocks++;
          break;
        case 'modify':
          for (const p of blk.pairs!) {
            if (p.a !== null && p.b !== null && p.similar) s.modifiedPairs++;
            else {
              // A replacement (dissimilar lines sharing a row) is a deletion plus an insertion.
              if (p.a !== null) s.deletedLines++;
              if (p.b !== null) s.insertedLines++;
            }
          }
          s.changeBlocks++;
          break;
      }
    }
    return s;
  }

  private push(kind: BlockKind, aStart: number, aEnd: number, bStart: number, bEnd: number, pairs?: LinePair[]): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.kind === kind) {
      last.a.end = aEnd;
      last.b.end = bEnd;
      // A loop, not push(...pairs): spreading a huge array into a call overflows the stack.
      if (pairs) for (const p of pairs) last.pairs!.push(p);
      return;
    }
    const block: DiffBlock = { kind, a: { start: aStart, end: aEnd }, b: { start: bStart, end: bEnd } };
    if (pairs) block.pairs = pairs;
    this.blocks.push(block);
  }
}
