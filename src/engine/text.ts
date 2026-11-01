export type Eol = '\n' | '\r\n' | '\r';

export interface SplitText {
  /** Lines without their terminators. */
  lines: string[];
  /** Dominant line ending, `'mixed'` if more than one kind occurs, `'none'` if there are no line breaks. */
  eol: Eol | 'mixed' | 'none';
  /** Whether the text ends with a line terminator. */
  trailingNewline: boolean;
}

/** Splits text on `\n`, `\r\n` and lone `\r`, remembering enough to write it back unchanged. */
export function splitLines(text: string): SplitText {
  const lines: string[] = [];
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  let start = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      lines.push(text.slice(start, i));
      lf++;
      start = i + 1;
    } else if (c === 13) {
      lines.push(text.slice(start, i));
      if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else {
        cr++;
      }
      start = i + 1;
    }
  }
  const trailingNewline = n > 0 && start === n;
  if (start < n) lines.push(text.slice(start));

  const kinds = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  let eol: SplitText['eol'];
  if (kinds === 0) eol = 'none';
  else if (kinds > 1) eol = 'mixed';
  else eol = lf > 0 ? '\n' : crlf > 0 ? '\r\n' : '\r';

  return { lines, eol, trailingNewline };
}

/** Inverse of `splitLines` for a single line-ending style. */
export function joinLines(lines: readonly string[], eol: Eol, trailingNewline: boolean): string {
  const body = lines.join(eol);
  return trailingNewline && lines.length > 0 ? body + eol : body;
}
