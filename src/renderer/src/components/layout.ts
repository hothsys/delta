/** Height of one display row in CSS pixels. Rows are fixed-height so row <-> pixel maths stays exact. */
export const ROW_HEIGHT = 20;
export const FONT = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const TAB_SIZE = 4;
/**
 * Rows are rendered in bands of this many. The panes only re-render when scrolling enters a
 * new band (every BAND_ROWS * ROW_HEIGHT pixels), not on every scroll event, and a band of
 * margin is kept above and below the viewport so fast scrolling never shows blank rows.
 */
export const BAND_ROWS = 40;
/**
 * Lines longer than this many characters (minified code, data dumps) are rendered only around
 * the visible columns: browsers take seconds to lay out, hit-test and paint a single text run
 * of hundreds of thousands of characters, even though only a screenful is ever visible.
 */
export const LONG_LINE = 2000;
/** Long lines are re-rendered when horizontal scrolling enters a new band this many pixels wide. */
export const BAND_WIDTH = 4000;
/** Horizontal padding around line numbers and around text, in CSS pixels. */
export const CELL_PADDING = 8;
/** Width of the centre column that links changes across the panes. */
export const GUTTER_WIDTH = 56;
/** Width of the overview map on the far right. */
export const OVERVIEW_WIDTH = 22;

let cachedCharWidth = 0;

/** Advance width of one monospace character in `FONT`. */
export function charWidth(): number {
  if (cachedCharWidth) return cachedCharWidth;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return 8;
  ctx.font = FONT;
  cachedCharWidth = ctx.measureText('M'.repeat(100)).width / 100;
  return cachedCharWidth;
}

/**
 * The characters of `text` covering visual columns `[fromCol, toCol)`, as `[start, end)`, and
 * the visual column `col` where `start` falls. The slice always starts on a tab stop, so tabs
 * inside it line up exactly as they would in the whole line.
 */
export function columnSlice(text: string, fromCol: number, toCol: number): { start: number; end: number; col: number } {
  let v = 0;
  let i = 0;
  // Never start between the two halves of a surrogate pair (an emoji, say).
  while (i < text.length && (v < fromCol || v % TAB_SIZE !== 0 || isLowSurrogate(text, i))) {
    v = text.charCodeAt(i) === 9 ? v + TAB_SIZE - (v % TAB_SIZE) : v + 1;
    i++;
  }
  const start = i;
  const col = v;
  while (i < text.length && v < toCol) {
    v = text.charCodeAt(i) === 9 ? v + TAB_SIZE - (v % TAB_SIZE) : v + 1;
    i++;
  }
  if (isLowSurrogate(text, i)) i++; // nor end between them
  return { start, end: i, col };
}

/** `ranges` (character offsets) clipped to `[start, end)` and made relative to `start`. */
export function clipRanges<R extends { start: number; end: number }>(ranges: readonly R[] | undefined, start: number, end: number): R[] {
  if (!ranges) return [];
  const out: R[] = [];
  for (const r of ranges) {
    if (r.end <= start || r.start >= end) continue;
    out.push({ ...r, start: Math.max(r.start, start) - start, end: Math.min(r.end, end) - start });
  }
  return out;
}

const isLowSurrogate = (text: string, i: number) => {
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};
