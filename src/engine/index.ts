import { diffLines } from "./lineDiff";
import { type SplitText, splitLines } from "./text";
import type { LineDiffOptions, LineDiffResult } from "./types";

export {
  type CommentSyntax,
  commentSyntaxForExtension,
  stripComments,
} from "./comments";
export { diffChars } from "./intraLine";
export { diffLines } from "./lineDiff";
export { type Eol, joinLines, type SplitText, splitLines } from "./text";
export type * from "./types";

export interface TextDiffResult extends LineDiffResult {
  left: SplitText;
  right: SplitText;
}

/** Convenience entry point: split both texts into lines and diff them. */
export function diffText(
  left: string,
  right: string,
  options: LineDiffOptions = {},
): TextDiffResult {
  const l = splitLines(left);
  const r = splitLines(right);
  return { ...diffLines(l.lines, r.lines, options), left: l, right: r };
}
