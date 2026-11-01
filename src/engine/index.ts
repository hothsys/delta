import { diffLines } from './lineDiff';
import { splitLines, type SplitText } from './text';
import type { LineDiffOptions, LineDiffResult } from './types';

export { diffLines } from './lineDiff';
export { diffChars } from './intraLine';
export { splitLines, joinLines, type Eol, type SplitText } from './text';
export type * from './types';

export interface TextDiffResult extends LineDiffResult {
  left: SplitText;
  right: SplitText;
}

/** Convenience entry point: split both texts into lines and diff them. */
export function diffText(left: string, right: string, options: LineDiffOptions = {}): TextDiffResult {
  const l = splitLines(left);
  const r = splitLines(right);
  return { ...diffLines(l.lines, r.lines, options), left: l, right: r };
}
