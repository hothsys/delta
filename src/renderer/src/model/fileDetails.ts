import type { EolCounts, LineEnding, TextEncoding } from '../../../shared/api';

/** What the status line under a pane shows about its file, as last read or saved. */
export interface FileDetails {
  encoding: TextEncoding;
  /** UTF-8 that is all 7-bit characters. */
  asciiOnly: boolean;
  /** Bytes on disk. */
  size: number;
  eolCounts: EolCounts;
}

export function encodingLabel(encoding: TextEncoding, asciiOnly: boolean): string {
  switch (encoding) {
    case 'utf8':
      return asciiOnly ? 'ASCII' : 'UTF-8';
    case 'utf8-bom':
      return 'UTF-8 with BOM';
    case 'utf16le':
      return 'UTF-16 LE';
    case 'utf16be':
      return 'UTF-16 BE';
    case 'latin1':
      return 'Latin-1';
  }
}

/** `0 B`, `812 B`, `1.5 KB`, `24 KB`, `3.2 MB` (1 KB = 1024 bytes, as Finder and Explorer count). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`;
}

export const formatBytes = (bytes: number) => `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`;

/** Line endings: which kind (`mixed` when more than one), a label and a tooltip with the counts. */
export function eolSummary(c: EolCounts): { kind: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none'; label: string; title: string } {
  const present = (['crlf', 'lf', 'cr'] as const).filter((k) => c[k] > 0);
  const name = { lf: 'LF', crlf: 'CRLF', cr: 'CR' } as const;
  const lines = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'line' : 'lines'}`;
  if (present.length === 0) return { kind: 'none', label: 'No line breaks', title: 'The file is a single line with no line break.' };
  if (present.length === 1) {
    const k = present[0];
    return { kind: k, label: name[k], title: `Every line ends with ${name[k]}${k === 'lf' ? ' (Unix, macOS)' : k === 'crlf' ? ' (Windows)' : ' (classic Mac OS)'}.` };
  }
  const mostly = present.reduce((a, b) => (c[b] > c[a] ? b : a));
  return {
    kind: 'mixed',
    label: `Mixed (mostly ${name[mostly]})`,
    title: `${present.map((k) => `${name[k]}: ${lines(c[k])}`).join(', ')}. Saving uses ${name[mostly]} for every line.`,
  };
}

export function formatLines(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'line' : 'lines'}`;
}

/** The line-break counts of text written with one ending: what a saved file has. */
export function savedEolCounts(lineCount: number, eol: LineEnding, trailingNewline: boolean): EolCounts {
  const breaks = Math.max(0, trailingNewline ? lineCount : lineCount - 1);
  return { lf: eol === '\n' ? breaks : 0, crlf: eol === '\r\n' ? breaks : 0, cr: eol === '\r' ? breaks : 0 };
}

export const isAsciiText = (text: string) => !/[^\u0000-\u007f]/.test(text);

/**
 * Which file conventions differ between the two sides, so they can be pointed out even when
 * every line matches. Sizes and line counts aren't included: they differ whenever the text does.
 * Line endings count as different only when both files have line breaks (a one-line file has
 * no convention to compare).
 */
export function conventionsDiffer(
  a: { details: FileDetails | null; trailingNewline: boolean; lines: number },
  b: { details: FileDetails | null; trailingNewline: boolean; lines: number },
): { encoding: boolean; eol: boolean; newline: boolean } {
  if (!a.details || !b.details) return { encoding: false, eol: false, newline: false };
  const ea = eolSummary(a.details.eolCounts).kind;
  const eb = eolSummary(b.details.eolCounts).kind;
  return {
    encoding: a.details.encoding !== b.details.encoding,
    eol: ea !== 'none' && eb !== 'none' && ea !== eb,
    newline: a.lines > 0 && b.lines > 0 && a.trailingNewline !== b.trailingNewline,
  };
}

/** For an "Identical" comparison: what still differs, e.g. "Identical text; line endings differ". */
export function identicalNote(d: { encoding: boolean; eol: boolean; newline: boolean }): string | null {
  const parts = [d.encoding && 'encoding', d.eol && 'line endings', d.newline && 'final newline'].filter((p): p is string => !!p);
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Identical text; ${list} differ${parts.length === 1 && parts[0] !== 'line endings' ? 's' : ''}`;
}
