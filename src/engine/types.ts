/** Half-open range of indexes: `[start, end)`. */
export interface Range {
  start: number;
  end: number;
}

/**
 * How whitespace is treated when deciding whether two lines (or characters) match.
 * - `exact`: whitespace is significant.
 * - `trim`: leading and trailing whitespace is ignored.
 * - `collapse`: like `trim`, and runs of internal whitespace compare equal to a single space.
 * - `ignore`: all whitespace is ignored.
 */
export type WhitespaceMode = 'exact' | 'trim' | 'collapse' | 'ignore';

export interface CompareOptions {
  /** Default `'exact'`. */
  whitespace?: WhitespaceMode;
  /** Treat letters that differ only in case as equal. Default `false`. */
  ignoreCase?: boolean;
}

/** A user-forced alignment: line `a` (left, 0-based) must sit on the same row as line `b` (right). */
export interface Anchor {
  a: number;
  b: number;
}

export interface LineDiffOptions extends CompareOptions {
  /** Manual alignments. Out-of-range or crossing anchors are dropped; see `LineDiffResult.anchors`. */
  anchors?: readonly Anchor[];
  /** Always find a minimal diff, even when that is very expensive. Default `false`. */
  minimal?: boolean;
}

/**
 * - `equal`: lines are identical.
 * - `unimportant`: lines match under the active whitespace/case options but their raw text differs.
 * - `insert`: lines exist only on the right.
 * - `delete`: lines exist only on the left.
 * - `modify`: a changed region with lines on both sides; see `DiffBlock.pairs`.
 */
export type BlockKind = 'equal' | 'unimportant' | 'insert' | 'delete' | 'modify';

/** One display row inside a `modify` block. A `null` side means a filler (blank) row on that side. */
export interface LinePair {
  a: number | null;
  b: number | null;
  /**
   * With both sides present: `true` when the lines are similar (one is an edit of the other,
   * worth highlighting word by word); `false` when they only share a row by position, i.e.
   * the left line was replaced by an unrelated right line.
   */
  similar?: boolean;
}

export interface DiffBlock {
  kind: BlockKind;
  /** Lines of the left text covered by this block. Empty for `insert`. */
  a: Range;
  /** Lines of the right text covered by this block. Empty for `delete`. */
  b: Range;
  /** Present only on `modify` blocks: row-by-row line pairing, in order. */
  pairs?: LinePair[];
}

export interface DiffStats {
  equalLines: number;
  unimportantLines: number;
  /** Rows where a left line is paired with a similar, edited right line. */
  modifiedPairs: number;
  /** Right lines with no similar left partner (including replacements). */
  insertedLines: number;
  /** Left lines with no similar right partner (including replacements). */
  deletedLines: number;
  /** Number of `insert`, `delete` and `modify` blocks, i.e. navigable differences. */
  changeBlocks: number;
}

export interface LineDiffResult {
  /** Contiguous, in order, and covering every line of both texts exactly once. */
  blocks: DiffBlock[];
  stats: DiffStats;
  /** The anchors that were actually applied, sorted. */
  anchors: Anchor[];
}

/** Changed character ranges (UTF-16 offsets) within a pair of lines. */
export interface IntraLineDiff {
  a: Range[];
  b: Range[];
}
