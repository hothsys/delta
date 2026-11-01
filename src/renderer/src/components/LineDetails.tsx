import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Range } from '../../../engine';
import { BAND_WIDTH, CELL_PADDING, clipRanges, columnSlice, LONG_LINE, TAB_SIZE } from './layout';

interface DetailLine {
  /** 1-based line number, or null when this side has no line on the row. */
  number: number | null;
  text: string;
  ranges: Range[];
  /** CSS class for the highlighted ranges. */
  highlight: string;
}

interface LineDetailsProps {
  left: DetailLine;
  right: DetailLine;
  charWidth: number;
  /** Changes when the shown row changes, to bring its first difference into view. */
  rowKey: string;
}

/**
 * The row at the caret, left above right, in one strip that scrolls sideways so long lines
 * can be read in full. Whitespace is made visible (· for a space, → for a tab, ¶ at the end
 * of the line) so spacing differences can be seen.
 */
export function LineDetails({ left, right, charWidth: cw, rowKey }: LineDetailsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const digits = String(Math.max(left.number ?? 0, right.number ?? 0, 1)).length;
  const numberWidth = Math.ceil(digits * cw) + 2 * CELL_PADDING;
  // Long lines are rendered only around the visible columns, as in the panes.
  const [hBand, setHBand] = useState(0);
  const [width, setWidth] = useState(0);

  // When the row changes, scroll so its first difference is visible (or back to the start).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firsts = [left, right].filter((l) => l.ranges.length).map((l) => visualCol(l.text, l.ranges[0].start));
    const col = firsts.length ? Math.min(...firsts) : 0;
    const x = col * cw;
    el.scrollLeft = x > el.clientWidth - numberWidth - 4 * cw ? Math.max(0, x - 8 * cw) : 0;
    setHBand(Math.floor(el.scrollLeft / BAND_WIDTH));
    setWidth(el.clientWidth);
  }, [rowKey]);
  const firstCol = Math.floor((Math.max(0, hBand - 1) * BAND_WIDTH) / cw);
  const lastCol = Math.ceil(((hBand + 2) * BAND_WIDTH + width) / cw);

  const line = (l: DetailLine, side: 'a' | 'b') => {
    let content: ReactNode;
    let style: CSSProperties | undefined;
    if (l.number === null) {
      content = <span className="detail-none">(no line on this side)</span>;
    } else if (l.text.length > LONG_LINE) {
      const s = columnSlice(l.text, firstCol, lastCol);
      content = visible(l.text.slice(s.start, s.end), clipRanges(l.ranges, s.start, s.end), l.highlight, s.end === l.text.length);
      // The full width keeps the strip's scroll range; the slice sits at its own column.
      style = { paddingLeft: CELL_PADDING + s.col * cw, minWidth: 2 * CELL_PADDING + (visualCol(l.text, l.text.length) + 1) * cw };
    } else {
      content = visible(l.text, l.ranges, l.highlight);
    }
    return (
      <div className={`detail-line detail-${side}`}>
        <span className="detail-ln" style={{ width: numberWidth }}>
          {l.number ?? ''}
        </span>
        <span className="detail-text" style={style}>
          {content}
        </span>
      </div>
    );
  };

  return (
    <div
      className="line-details"
      ref={scrollRef}
      aria-label="Line details"
      onScroll={(e) => {
        setHBand(Math.floor(e.currentTarget.scrollLeft / BAND_WIDTH));
        setWidth(e.currentTarget.clientWidth);
      }}
    >
      {line(left, 'a')}
      {line(right, 'b')}
    </div>
  );
}

function visualCol(text: string, col: number): number {
  let v = 0;
  for (let i = 0; i < col && i < text.length; i++) v = text.charCodeAt(i) === 9 ? v + TAB_SIZE - (v % TAB_SIZE) : v + 1;
  return v;
}

/** Renders text with highlighted ranges and visible whitespace markers. */
function visible(text: string, ranges: Range[], highlight: string, lineEnd = true): ReactNode[] {
  const out: ReactNode[] = [];
  let col = 0;
  let key = 0;
  // Turns a slice into nodes, replacing spaces and tabs with marker glyphs.
  const render = (slice: string): ReactNode[] => {
    const nodes: ReactNode[] = [];
    let plain = '';
    const flush = () => {
      if (plain) nodes.push(plain);
      plain = '';
    };
    for (const ch of slice) {
      if (ch === ' ') {
        flush();
        nodes.push(<span key={key++} className="ws">·</span>);
        col++;
      } else if (ch === '\t') {
        flush();
        const width = TAB_SIZE - (col % TAB_SIZE);
        nodes.push(<span key={key++} className="ws">{'→'.padEnd(width, ' ')}</span>);
        col += width;
      } else {
        plain += ch;
        col += ch.length;
      }
    }
    flush();
    return nodes;
  };
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) out.push(...render(text.slice(pos, r.start)));
    out.push(
      <span key={key++} className={highlight}>
        {render(text.slice(r.start, r.end))}
      </span>,
    );
    pos = r.end;
  }
  if (pos < text.length) out.push(...render(text.slice(pos)));
  if (lineEnd) out.push(<span key={key++} className="ws eol">¶</span>);
  return out;
}
