import type { Anchor } from '../../../engine';
import type { Side } from './rowModel';
import type { EditOp } from './textEdit';

/**
 * Keeps manual alignments attached to their lines through an edit on one side. Lines after
 * the edit shift. A line inside the replaced range follows its text when the edit left it
 * unchanged at the start or end of the range (Enter at the start of an aligned line moves
 * the alignment down with it); otherwise it keeps its anchor if the edit still has a line at
 * that position (typing on an anchored line keeps it) and loses it if not.
 * Returns the same array when nothing changed.
 */
export function transformAnchors(anchors: Anchor[], side: Side, op: EditOp): Anchor[] {
  const key = side;
  const end = op.start + op.removed.length;
  const { removed, inserted } = op;
  // Lines the edit left as they were at its start and at its end.
  let head = 0;
  while (head < removed.length && head < inserted.length && removed[head] === inserted[head]) head++;
  let tail = 0;
  while (
    tail < removed.length - head &&
    tail < inserted.length - head &&
    removed[removed.length - 1 - tail] === inserted[inserted.length - 1 - tail]
  )
    tail++;
  let changed = false;
  const out: Anchor[] = [];
  for (const anc of anchors) {
    const line = anc[key];
    let next = line;
    const k = line - op.start;
    if (line >= end) next = line + inserted.length - removed.length;
    else if (line >= op.start && k >= head && k >= removed.length - tail) next = op.start + inserted.length - (removed.length - k);
    else if (line >= op.start && k >= inserted.length) {
      changed = true;
      continue;
    }
    if (next !== line) changed = true;
    out.push({ ...anc, [key]: next });
  }
  return changed ? out : anchors;
}

/**
 * Adds an alignment, replacing any that share a line with it or would cross it (alignments
 * must keep both sides in order). The result is sorted.
 */
export function addAnchor(anchors: Anchor[], a: number, b: number): Anchor[] {
  const kept = anchors.filter((x) => (x.a < a && x.b < b) || (x.a > a && x.b > b));
  return [...kept, { a, b }].sort((x, y) => x.a - y.a);
}

export function removeAnchor(anchors: Anchor[], side: Side, line: number): Anchor[] {
  return anchors.filter((x) => x[side] !== line);
}
