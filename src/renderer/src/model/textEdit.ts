/**
 * Document positions and edits. Every edit is expressed as a whole-line replacement
 * (`EditOp`), which keeps undo, merging and row-model patching uniform: typing a character
 * replaces one line with one line, Enter replaces one line with two, a merge replaces a block.
 */

export interface Pos {
  line: number;
  /** UTF-16 offset within the line. */
  col: number;
}

/** `anchor` is where the selection started, `head` where the caret is. Equal for a plain caret. */
export interface Selection {
  anchor: Pos;
  head: Pos;
}

/** Replace `removed.length` lines starting at `start` with `inserted`. */
export interface EditOp {
  start: number;
  removed: string[];
  inserted: string[];
}

export const cmpPos = (p: Pos, q: Pos): number => p.line - q.line || p.col - q.col;
export const caretAt = (p: Pos): Selection => ({ anchor: p, head: p });
export const isCaret = (s: Selection): boolean => cmpPos(s.anchor, s.head) === 0;

/** The selection's start and end in document order. */
export function ordered(s: Selection): [Pos, Pos] {
  return cmpPos(s.anchor, s.head) <= 0 ? [s.anchor, s.head] : [s.head, s.anchor];
}

/** Builds the edit that replaces the text between `from` and `to` with `text`, and where the caret ends up. */
export function replaceRange(lines: readonly string[], from: Pos, to: Pos, text: string): { op: EditOp; end: Pos } {
  const parts = text.split(/\r\n|\r|\n/);
  const empty = lines.length === 0;
  const prefix = empty ? '' : lines[from.line].slice(0, from.col);
  const suffix = empty ? '' : lines[to.line].slice(to.col);
  const inserted = parts.slice();
  inserted[0] = prefix + inserted[0];
  const lastLen = parts[parts.length - 1].length;
  inserted[inserted.length - 1] += suffix;
  const op: EditOp = {
    start: empty ? 0 : from.line,
    removed: empty ? [] : lines.slice(from.line, to.line + 1),
    inserted,
  };
  const endLine = op.start + parts.length - 1;
  const end = { line: endLine, col: parts.length === 1 ? prefix.length + lastLen : lastLen };
  return { op, end };
}

/** Applies `op` to `lines` in place. */
export function applyOp(lines: string[], op: EditOp): void {
  if (op.inserted.length < SPLICE_LIMIT) {
    lines.splice(op.start, op.removed.length, ...op.inserted);
    return;
  }
  // Spreading a huge array into splice() overflows the stack (around 120,000 items), so
  // big edits (merging or pasting a whole large file) rebuild the tail instead.
  const tail = lines.slice(op.start + op.removed.length);
  lines.length = op.start;
  for (const line of op.inserted) lines.push(line);
  for (const line of tail) lines.push(line);
}

/** Edits inserting at least this many lines avoid spreading them into one call. */
const SPLICE_LIMIT = 10_000;

export function invertOp(op: EditOp): EditOp {
  return { start: op.start, removed: op.inserted, inserted: op.removed };
}

/** A single op equivalent to `first` followed by `second`, when `second` rewrites exactly what `first` produced. */
export function composeOps(first: EditOp, second: EditOp): EditOp | null {
  if (second.start !== first.start || second.removed.length !== first.inserted.length) return null;
  for (let i = 0; i < second.removed.length; i++) if (second.removed[i] !== first.inserted[i]) return null;
  return { start: first.start, removed: first.removed, inserted: second.inserted };
}

export function textInRange(lines: readonly string[], from: Pos, to: Pos): string {
  if (lines.length === 0) return '';
  if (from.line === to.line) return lines[from.line].slice(from.col, to.col);
  const out = [lines[from.line].slice(from.col)];
  for (let l = from.line + 1; l < to.line; l++) out.push(lines[l]);
  out.push(lines[to.line].slice(0, to.col));
  return out.join('\n');
}

export function clampPos(lines: readonly string[], p: Pos): Pos {
  if (lines.length === 0) return { line: 0, col: 0 };
  const line = Math.min(Math.max(0, p.line), lines.length - 1);
  return { line, col: Math.min(Math.max(0, p.col), lines[line].length) };
}

/** Where a position ends up after someone else's edit (for example, a merge into this side). */
export function transformPos(p: Pos, op: EditOp): Pos {
  const oldEnd = op.start + op.removed.length;
  if (p.line < op.start) return p;
  if (p.line >= oldEnd) return { line: p.line + op.inserted.length - op.removed.length, col: p.col };
  return { line: op.start + Math.min(p.line - op.start, Math.max(0, op.inserted.length - 1)), col: p.col };
}

/** Display column of offset `col`, with tabs expanded to the next multiple of `tabSize`. */
export function visualColumn(text: string, col: number, tabSize: number): number {
  let v = 0;
  for (let i = 0; i < col && i < text.length; i++) v = text.charCodeAt(i) === 9 ? v + tabSize - (v % tabSize) : v + 1;
  return v;
}

/** Offset of the character boundary nearest to display column `visual`. */
export function colAtVisual(text: string, visual: number, tabSize: number): number {
  let v = 0;
  for (let i = 0; i < text.length; i++) {
    const next = text.charCodeAt(i) === 9 ? v + tabSize - (v % tabSize) : v + 1;
    if (visual < (v + next) / 2) return i;
    v = next;
  }
  return text.length;
}

const WORD = /[\p{L}\p{N}_]/u;
const SPACE = /\s/;

/** Start of the word (or punctuation run) before `col`, skipping whitespace first. */
export function wordLeft(text: string, col: number): number {
  let i = col;
  while (i > 0 && SPACE.test(text[i - 1])) i--;
  if (i === 0) return 0;
  const word = WORD.test(text[i - 1]);
  while (i > 0 && !SPACE.test(text[i - 1]) && WORD.test(text[i - 1]) === word) i--;
  return i;
}

/** End of the word (or punctuation run) after `col`, skipping whitespace first. */
export function wordRight(text: string, col: number): number {
  let i = col;
  while (i < text.length && SPACE.test(text[i])) i++;
  if (i === text.length) return i;
  const word = WORD.test(text[i]);
  while (i < text.length && !SPACE.test(text[i]) && WORD.test(text[i]) === word) i++;
  return i;
}

/** The word, whitespace run or punctuation run around `col`, for double-click selection. */
export function wordAt(text: string, col: number): [number, number] {
  if (text.length === 0) return [0, 0];
  const at = Math.min(col, text.length - 1);
  const cls = (ch: string) => (SPACE.test(ch) ? 0 : WORD.test(ch) ? 1 : 2);
  const c = cls(text[at]);
  let s = at;
  let e = at + 1;
  while (s > 0 && cls(text[s - 1]) === c) s--;
  while (e < text.length && cls(text[e]) === c) e++;
  return [s, e];
}
