import { Interner } from './intern';
import { diffSequences, marksToHunks, type Hunk } from './myers';
import { isWhitespace } from './normalize';
import type { CompareOptions, IntraLineDiff, Range, WhitespaceMode } from './types';

/** Letters, digits and underscores form words; anything else is a token on its own. */
const WORD = /[\p{L}\p{N}_]/u;

interface Tokens {
  keys: Int32Array;
  /** UTF-16 offset where each token starts. */
  starts: Int32Array;
  /** UTF-16 offset just past each token. */
  ends: Int32Array;
}

/**
 * Word-level differences between two lines, for highlighting inside a modified row.
 *
 * Words and punctuation marks decide what lines up; whitespace never does. Matching single
 * letters would split words ("unmoun|ted" vs "ejec|ted"), and letting spaces and commas count
 * as matches would let them outvote real words. Spacing is compared separately, between
 * words that matched, so re-indentation or doubled spaces still show (unless the options say
 * to ignore that kind of whitespace). Short unchanged filler between larger changes is
 * absorbed into them, so highlights read as whole phrases rather than confetti. Intended to
 * be called lazily, only for rows that are on screen.
 */
export function diffChars(a: string, b: string, options: CompareOptions = {}): IntraLineDiff {
  const ws = options.whitespace ?? 'exact';
  const ignoreCase = options.ignoreCase ?? false;
  const interner = new Interner();
  // With all whitespace ignored, "a b" must equal "ab", so compare characters; highlights are
  // widened to whole words afterwards.
  const byChar = ws === 'ignore';
  const ta = tokenize(a, byChar, ignoreCase, interner);
  const tb = tokenize(b, byChar, ignoreCase, interner);

  // Very long lines (minified code) would make the word-level search take seconds or minutes;
  // highlight what lies between their common start and end instead.
  if (ta.keys.length + tb.keys.length > MAX_TOKENS) {
    const middle = changedMiddle(ta, tb);
    // Every word matches, yet the lines differ: only spacing changed. Show it character by character.
    if (!middle.a.length && !middle.b.length && ws === 'exact' && a !== b) return changedChars(a, b);
    return middle;
  }
  const { changedA, changedB } = diffSequences(ta.keys, tb.keys, { minimal: true });
  const hunks = absorbShortEqualities(marksToHunks(changedA, changedB), (from, to) => isFiller(a, ta, from, to));

  const ra: Range[] = [];
  const rb: Range[] = [];
  for (const h of hunks) {
    if (h.aEnd > h.aStart) ra.push(tidy(a, ta.starts[h.aStart], ta.ends[h.aEnd - 1], byChar));
    if (h.bEnd > h.bStart) rb.push(tidy(b, tb.starts[h.bStart], tb.ends[h.bEnd - 1], byChar));
  }
  if (!byChar) spacingChanges(a, b, ta, tb, changedA, changedB, ws, ra, rb);
  const result = { a: merged(ra), b: merged(rb) };
  // Lines that share only scattered punctuation or tiny words were rewritten, not edited;
  // picking out those fragments would be noise, so the whole of each line is highlighted.
  return rewritten(a, b, result.a) ? { a: wholeLine(a), b: wholeLine(b) } : result;
}

/**
 * Above this many tokens (words, punctuation marks) on the two lines together, word-level
 * matching is skipped. Its cost grows with length times the number of differences: about
 * 100ms at this size, but 40 seconds for a pair of 500,000-character minified lines.
 */
export const MAX_TOKENS = 10_000;

/** One highlight per side, covering everything between the lines' common first and last tokens. */
function changedMiddle(ta: Tokens, tb: Tokens): IntraLineDiff {
  const n = ta.keys.length;
  const m = tb.keys.length;
  let pre = 0;
  while (pre < n && pre < m && ta.keys[pre] === tb.keys[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && ta.keys[n - 1 - suf] === tb.keys[m - 1 - suf]) suf++;
  const range = (t: Tokens, end: number): Range[] => (end > pre ? [{ start: t.starts[pre], end: t.ends[end - 1] }] : []);
  return { a: range(ta, n - suf), b: range(tb, m - suf) };
}

/** One highlight per side, covering everything between the lines' common first and last characters. */
function changedChars(a: string, b: string): IntraLineDiff {
  let pre = 0;
  while (pre < a.length && pre < b.length && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  const range = (len: number): Range[] => (len - suf > pre ? [{ start: pre, end: len - suf }] : []);
  return { a: range(a.length), b: range(b.length) };
}

/** A word of three or more letters left unchanged means the lines are related. */
const SHARED_WORD = /[\p{L}\p{N}_]{3,}/u;

/**
 * True when what the two lines still have in common is trivial: no word of three or more
 * letters, and under half of the shorter line's non-space text.
 */
function rewritten(a: string, b: string, changedInA: Range[]): boolean {
  let unchanged = '';
  let pos = 0;
  for (const r of changedInA) {
    unchanged += a.slice(pos, r.start) + ' ';
    pos = r.end;
  }
  unchanged += a.slice(pos);
  if (SHARED_WORD.test(unchanged)) return false;
  const solid = (t: string) => t.replace(/\s+/g, '').length;
  return solid(unchanged) < 0.5 * Math.min(solid(a), solid(b));
}

/** The line without its leading and trailing whitespace, as a single range (none if blank). */
function wholeLine(text: string): Range[] {
  let s = 0;
  let e = text.length;
  while (s < e && isWhitespace(text.charCodeAt(s))) s++;
  while (e > s && isWhitespace(text.charCodeAt(e - 1))) e--;
  return s < e ? [{ start: s, end: e }] : [];
}

/**
 * Adds highlights for whitespace that differs between matched words: the gap between two
 * words that matched on both sides, and (when whitespace is fully significant) the leading
 * and trailing whitespace around matched first and last words.
 */
function spacingChanges(
  a: string,
  b: string,
  ta: Tokens,
  tb: Tokens,
  changedA: Uint8Array,
  changedB: Uint8Array,
  ws: WhitespaceMode,
  ra: Range[],
  rb: Range[],
): void {
  const differs = (x: string, y: string) => (ws === 'collapse' ? (x === '') !== (y === '') : x !== y);
  const mark = (xs: Range, ys: Range) => {
    if (!differs(a.slice(xs.start, xs.end), b.slice(ys.start, ys.end))) return;
    if (xs.end > xs.start) ra.push(xs);
    if (ys.end > ys.start) rb.push(ys);
  };
  if (ta.keys.length === 0 && tb.keys.length === 0) {
    if (ws === 'exact') mark({ start: 0, end: a.length }, { start: 0, end: b.length });
    return;
  }
  // Matched tokens pair up in order.
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < changedA.length && j < changedB.length; ) {
    if (changedA[i]) i++;
    else if (changedB[j]) j++;
    else pairs.push([i++, j++]);
  }
  for (let k = 0; k + 1 < pairs.length; k++) {
    const [i, j] = pairs[k];
    const [i2, j2] = pairs[k + 1];
    if (i2 !== i + 1 || j2 !== j + 1) continue;
    mark({ start: ta.ends[i], end: ta.starts[i2] }, { start: tb.ends[j], end: tb.starts[j2] });
  }
  if (ws !== 'exact' || pairs.length === 0) return;
  const [fi, fj] = pairs[0];
  if (fi === 0 && fj === 0) mark({ start: 0, end: ta.starts[0] }, { start: 0, end: tb.starts[0] });
  const [li, lj] = pairs[pairs.length - 1];
  if (li === ta.keys.length - 1 && lj === tb.keys.length - 1) {
    mark({ start: ta.ends[li], end: a.length }, { start: tb.ends[lj], end: b.length });
  }
}

/** Sorts ranges and merges overlapping or touching ones. */
function merged(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of ranges.sort((x, y) => x.start - y.start)) {
    const prev = out[out.length - 1];
    if (prev && r.start <= prev.end) prev.end = Math.max(prev.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Trims whitespace off both ends of a highlight and optionally widens it to whole words. */
function tidy(text: string, start: number, end: number, toWords: boolean): Range {
  let s = start;
  let e = end;
  while (s < e && isWhitespace(text.charCodeAt(s))) s++;
  while (e > s && isWhitespace(text.charCodeAt(e - 1))) e--;
  if (toWords) {
    while (s > 0 && WORD.test(text[s - 1]) && WORD.test(text[s])) s--;
    while (e < text.length && WORD.test(text[e]) && WORD.test(text[e - 1])) e++;
  }
  return { start: s, end: e };
}

/** Words (or single characters when `byChar`) and punctuation marks; whitespace is skipped. */
function tokenize(s: string, byChar: boolean, ignoreCase: boolean, interner: Interner): Tokens {
  const keys: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (isWhitespace(c)) {
      i++;
      continue;
    }
    let end = i + 1;
    if (!byChar && WORD.test(s[i])) {
      while (end < s.length && WORD.test(s[end])) end++;
    } else if (c >= 0xd800 && c <= 0xdbff && end < s.length) {
      // Keep surrogate pairs together so a highlight never splits an astral character.
      const next = s.charCodeAt(end);
      if (next >= 0xdc00 && next <= 0xdfff) end++;
    }
    const text = s.slice(i, end);
    keys.push(interner.id(ignoreCase ? text.toLowerCase() : text));
    starts.push(i);
    ends.push(end);
    i = end;
  }
  return { keys: Int32Array.from(keys), starts: Int32Array.from(starts), ends: Int32Array.from(ends) };
}

/**
 * Merges neighbouring hunks when the unchanged gap between them (in tokens) is no longer than
 * the changes on either side of it, so `across a directory,` highlights as one edit rather
 * than separate words. Only gaps of filler (punctuation, words of one or two letters) are
 * merged: a real word that is on both sides stays unhighlighted.
 */
function absorbShortEqualities(hunks: Hunk[], isFillerGap: (fromToken: number, toToken: number) => boolean): Hunk[] {
  const out: Hunk[] = [];
  const size = (h: Hunk) => Math.max(h.aEnd - h.aStart, h.bEnd - h.bStart);
  for (const h of hunks) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = h.aStart - prev.aEnd;
      if (gap <= size(prev) && gap <= size(h) && isFillerGap(prev.aEnd, h.aStart)) {
        prev.aEnd = h.aEnd;
        prev.bEnd = h.bEnd;
        continue;
      }
    }
    out.push({ ...h });
  }
  return out;
}

/** Longest word that can be merged into a neighbouring highlight ("a", "to", "of"). */
const MAX_FILLER_WORD = 2;

/** True if tokens `[from, to)` of `text` contain no word longer than `MAX_FILLER_WORD`. */
function isFiller(text: string, tokens: Tokens, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const start = tokens.starts[i];
    const end = tokens.ends[i];
    if (end - start > MAX_FILLER_WORD && WORD.test(text[start])) return false;
  }
  return true;
}
