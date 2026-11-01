import type { CSSProperties, HTMLAttributes, MouseEventHandler, PointerEventHandler, ReactNode, Ref, TextareaHTMLAttributes } from 'react';
import type { IntraLineDiff, Range } from '../../../engine';
import { RowKind, type RowModel, type Side } from '../model/rowModel';
import { ordered, visualColumn, type Selection } from '../model/textEdit';
import { CELL_PADDING, clipRanges, columnSlice, LONG_LINE, ROW_HEIGHT, TAB_SIZE } from './layout';

export type { Side };

interface PaneProps {
  side: Side;
  lines: readonly string[];
  rows: RowModel;
  /** Visible row window, `[first, last)`. */
  first: number;
  last: number;
  /** Visible column window, `[firstCol, lastCol)`; only long lines are cut to it. */
  firstCol: number;
  lastCol: number;
  contentWidth: number;
  lineNumberWidth: number;
  charWidth: number;
  intraLine: (row: number) => IntraLineDiff | null;
  selection: Selection;
  /** Row the caret is on, or -1 when the document is empty. */
  caretRow: number;
  showCaret: boolean;
  /** Hint shown in an empty pane. */
  placeholder?: string;
  scrollRef: Ref<HTMLDivElement>;
  inputRef: Ref<HTMLTextAreaElement>;
  onScroll: () => void;
  /** Called on any user input that may scroll this pane (wheel, pointer, keyboard). */
  onInteract: () => void;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onContextMenu: MouseEventHandler<HTMLDivElement>;
  /** Lines with a manual alignment, marked in the line-number column. */
  anchoredLines: Set<number>;
  /** A line picked as the first half of an alignment, or -1. */
  pendingLine: number;
  /**
   * While a merge button is hovered: the rows of the change it acts on, and whether this pane
   * is the side copied from (`source`) or the side that would change (`target`).
   */
  mergePreview: { first: number; last: number; role: 'source' | 'target' } | null;
  inputHandlers: TextareaHTMLAttributes<HTMLTextAreaElement>;
}

/**
 * One side of the comparison. The scroll container holds a spacer sized to every row, but
 * only the rows in `[first, last)` are rendered, absolutely positioned within it. Keystrokes
 * go to a transparent textarea that follows the caret, which is also where IME popups appear.
 */
export function Pane(props: PaneProps) {
  const { side, lines, rows, first, last, lineNumberWidth, charWidth: cw, selection } = props;
  const index = side === 'a' ? rows.a : rows.b;
  const textLeft = lineNumberWidth + CELL_PADDING;
  const [selStart, selEnd] = ordered(selection);
  const hasSelection = selStart.line !== selEnd.line || selStart.col !== selEnd.col;

  const rendered: ReactNode[] = [];
  for (let r = first; r < last; r++) {
    const line = index[r];
    const kind = rows.kind[r] as RowKind;
    let text: ReactNode = null;
    let textStyle: CSSProperties | undefined;
    let selBox: ReactNode = null;
    if (line >= 0) {
      const content = lines[line];
      const ranges = kind === RowKind.Modified || kind === RowKind.Unimportant ? props.intraLine(r)?.[side] : undefined;
      // In a modified row, words removed from the left are red and words added on the right green.
      const changeClass = kind === RowKind.Unimportant ? 'chg-minor' : side === 'a' ? 'chg-del' : 'chg-ins';
      if (content.length > LONG_LINE) {
        // Only the columns around the viewport, shifted to where they belong.
        const s = columnSlice(content, props.firstCol, props.lastCol);
        text = highlight(content.slice(s.start, s.end), clipRanges(ranges, s.start, s.end), changeClass);
        textStyle = { paddingLeft: CELL_PADDING + s.col * cw };
      } else {
        text = highlight(content, ranges, changeClass);
      }
      if (hasSelection && line >= selStart.line && line <= selEnd.line) {
        const from = line === selStart.line ? visualColumn(content, selStart.col, TAB_SIZE) : 0;
        const to =
          line === selEnd.line ? visualColumn(content, selEnd.col, TAB_SIZE) : visualColumn(content, content.length, TAB_SIZE);
        // A selected line break shows as a sliver past the end of the line.
        const extra = line < selEnd.line ? cw / 2 : 0;
        selBox = <div className="sel" style={{ left: textLeft + from * cw, width: (to - from) * cw + extra }} />;
      }
    }
    const doomed = props.mergePreview?.role === 'target' && line >= 0 && r >= props.mergePreview.first && r < props.mergePreview.last;
    rendered.push(
      <div key={r} className={`row ${rowClass(kind, side)}${doomed ? ' merge-doomed' : ''}`} style={{ top: r * ROW_HEIGHT }}>
        {selBox}
        <span
          className={`ln${line >= 0 && props.anchoredLines.has(line) ? ' anchored' : ''}${line >= 0 && line === props.pendingLine ? ' pending' : ''}`}
          style={{ width: lineNumberWidth }}
        >
          {line >= 0 ? line + 1 : ''}
        </span>
        <span className="txt" style={textStyle}>
          {text}
        </span>
      </div>,
    );
  }

  const head = selection.head;
  const caretTop = Math.max(0, props.caretRow) * ROW_HEIGHT;
  const caretLeft = textLeft + visualColumn(lines[head.line] ?? '', head.col, TAB_SIZE) * cw;
  const paneHandlers: HTMLAttributes<HTMLDivElement> = {
    onScroll: props.onScroll,
    onWheel: props.onInteract,
    onKeyDown: props.onInteract,
    onFocus: props.onInteract,
    onPointerDown: (e) => {
      props.onInteract();
      props.onPointerDown(e);
    },
    onPointerMove: props.onPointerMove,
    onPointerUp: props.onPointerUp,
    onPointerCancel: props.onPointerUp,
    onContextMenu: props.onContextMenu,
  };

  return (
    <div className={`pane pane-${side}`} ref={props.scrollRef} {...paneHandlers}>
      <div className="pane-content" style={{ height: rows.count * ROW_HEIGHT, width: props.contentWidth }}>
        {rendered}
        {props.mergePreview && (
          <div
            className={`merge-preview merge-preview-${props.mergePreview.role}`}
            style={{
              top: props.mergePreview.first * ROW_HEIGHT,
              height: (props.mergePreview.last - props.mergePreview.first) * ROW_HEIGHT,
              left: lineNumberWidth,
            }}
          />
        )}
        {props.placeholder && <div className="placeholder">{props.placeholder}</div>}
        {props.showCaret && (
          // Keyed on position so the blink restarts, keeping the caret visible while it moves.
          <div key={`${head.line}:${head.col}`} className="caret" style={{ top: caretTop, left: caretLeft }} />
        )}
        <textarea
          ref={props.inputRef}
          className="input-proxy"
          style={{ top: caretTop, left: caretLeft }}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={side === 'a' ? 'Left text' : 'Right text'}
          {...props.inputHandlers}
        />
      </div>
    </div>
  );
}

function rowClass(kind: RowKind, side: Side): string {
  switch (kind) {
    case RowKind.Unimportant:
      return 'minor';
    case RowKind.Modified:
      return 'mod';
    case RowKind.Inserted:
      return side === 'b' ? 'ins' : 'filler';
    case RowKind.Deleted:
      return side === 'a' ? 'del' : 'filler';
    case RowKind.Replaced:
      return side === 'a' ? 'del' : 'ins';
    default:
      return '';
  }
}

function highlight(text: string, ranges: Range[] | undefined, className: string): ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.start > pos) parts.push(text.slice(pos, r.start));
    parts.push(
      <span key={i} className={className}>
        {text.slice(r.start, r.end)}
      </span>,
    );
    pos = r.end;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return parts;
}
