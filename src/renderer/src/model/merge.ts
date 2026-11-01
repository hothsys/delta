import type { DiffBlock } from '../../../engine';
import type { Side } from './rowModel';
import type { EditOp } from './textEdit';

/**
 * The edit that makes `to`'s side of `block` identical to `from`'s side. Copying an
 * insertion's empty side deletes the lines on the other side, as in any merge tool.
 */
export function mergeOp(block: DiffBlock, from: Side, fromLines: readonly string[], toLines: readonly string[]): EditOp {
  const src = from === 'a' ? block.a : block.b;
  const dst = from === 'a' ? block.b : block.a;
  return {
    start: dst.start,
    removed: toLines.slice(dst.start, dst.end),
    inserted: fromLines.slice(src.start, src.end),
  };
}

/** What a merge button does, in words, with the lines involved ("left lines 18–20"). */
export function mergeTitle(block: DiffBlock, from: Side): string {
  const src = from === 'a' ? block.a : block.b;
  const dst = from === 'a' ? block.b : block.a;
  const srcName = from === 'a' ? 'left' : 'right';
  const dstName = from === 'a' ? 'right' : 'left';
  const lines = (side: string, r: { start: number; end: number }) =>
    r.end - r.start === 1 ? `${side} line ${r.start + 1}` : `${side} lines ${r.start + 1}–${r.end}`;
  if (src.end === src.start) return `Remove ${lines(dstName, dst)}`;
  if (dst.end === dst.start) return `Copy ${lines(srcName, src)} to the ${dstName}`;
  return `Copy ${lines(srcName, src)} to the ${dstName}, replacing ${lines(dstName, dst)}`;
}
