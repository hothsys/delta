import { describe, expect, it } from 'vitest';
import {
  conventionsDiffer,
  encodingLabel,
  eolSummary,
  formatBytes,
  formatLines,
  formatSize,
  identicalNote,
  isAsciiText,
  savedEolCounts,
  type FileDetails,
} from '../../src/renderer/src/model/fileDetails';

const file = (over: Partial<FileDetails> = {}): FileDetails => ({ encoding: 'utf8', asciiOnly: true, size: 10, eolCounts: { lf: 3, crlf: 0, cr: 0 }, ...over });
const side = (details: FileDetails | null, trailingNewline = true, lines = 3) => ({ details, trailingNewline, lines });

describe('labels', () => {
  it('names encodings, with ASCII for 7-bit UTF-8', () => {
    expect(encodingLabel('utf8', true)).toBe('ASCII');
    expect(encodingLabel('utf8', false)).toBe('UTF-8');
    expect(encodingLabel('utf8-bom', false)).toBe('UTF-8 with BOM');
    expect(encodingLabel('utf16le', false)).toBe('UTF-16 LE');
    expect(encodingLabel('utf16be', false)).toBe('UTF-16 BE');
    expect(encodingLabel('latin1', false)).toBe('Latin-1');
  });

  it('formats sizes in B, KB, MB and GB', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(24 * 1024 + 300)).toBe('24 KB');
    expect(formatSize(3.25 * 1024 * 1024)).toBe('3.3 MB');
    expect(formatSize(75 * 1024 * 1024)).toBe('75 MB');
    expect(formatSize(2 * 1024 ** 3)).toBe('2 GB');
    expect(formatBytes(12345)).toBe('12,345 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatLines(1)).toBe('1 line');
    expect(formatLines(1234567)).toBe('1,234,567 lines');
  });

  it('describes line endings, with counts when mixed', () => {
    expect(eolSummary({ lf: 4, crlf: 0, cr: 0 })).toMatchObject({ kind: 'lf', label: 'LF' });
    expect(eolSummary({ lf: 0, crlf: 4, cr: 0 })).toMatchObject({ kind: 'crlf', label: 'CRLF' });
    expect(eolSummary({ lf: 0, crlf: 0, cr: 4 })).toMatchObject({ kind: 'cr', label: 'CR' });
    expect(eolSummary({ lf: 0, crlf: 0, cr: 0 })).toMatchObject({ kind: 'none', label: 'No line breaks' });
    const mixed = eolSummary({ lf: 3, crlf: 120, cr: 0 });
    expect(mixed).toMatchObject({ kind: 'mixed', label: 'Mixed (mostly CRLF)' });
    expect(mixed.title).toBe('CRLF: 120 lines, LF: 3 lines. Saving uses CRLF for every line.');
  });

  it('knows what a save writes', () => {
    expect(savedEolCounts(3, '\r\n', true)).toEqual({ lf: 0, crlf: 3, cr: 0 });
    expect(savedEolCounts(3, '\n', false)).toEqual({ lf: 2, crlf: 0, cr: 0 });
    expect(savedEolCounts(0, '\n', false)).toEqual({ lf: 0, crlf: 0, cr: 0 });
    expect(isAsciiText('plain')).toBe(true);
    expect(isAsciiText('naïve')).toBe(false);
  });
});

describe('what differs between the files', () => {
  it('compares encoding, line endings and the final newline', () => {
    expect(conventionsDiffer(side(file()), side(file()))).toEqual({ encoding: false, eol: false, newline: false });
    expect(conventionsDiffer(side(file()), side(file({ encoding: 'utf8-bom', asciiOnly: false, eolCounts: { lf: 0, crlf: 2, cr: 0 } }), false))).toEqual({
      encoding: true,
      eol: true,
      newline: true,
    });
  });

  it('treats ASCII and UTF-8 as the same encoding, and mixed endings as different from either', () => {
    expect(conventionsDiffer(side(file()), side(file({ asciiOnly: false }))).encoding).toBe(false);
    expect(conventionsDiffer(side(file()), side(file({ eolCounts: { lf: 2, crlf: 1, cr: 0 } }))).eol).toBe(true);
  });

  it('ignores line endings a file without line breaks can’t have, and sides with no file', () => {
    expect(conventionsDiffer(side(file({ eolCounts: { lf: 0, crlf: 0, cr: 0 } }), false, 1), side(file({ eolCounts: { lf: 0, crlf: 1, cr: 0 } }), false, 2)).eol).toBe(false);
    expect(conventionsDiffer(side(null, false, 0), side(file()))).toEqual({ encoding: false, eol: false, newline: false });
    expect(conventionsDiffer(side(file(), false, 0), side(file(), true, 3)).newline).toBe(false);
  });

  it('says what differs when the text is identical', () => {
    expect(identicalNote({ encoding: false, eol: false, newline: false })).toBeNull();
    expect(identicalNote({ encoding: false, eol: true, newline: false })).toBe('Identical text; line endings differ');
    expect(identicalNote({ encoding: true, eol: false, newline: false })).toBe('Identical text; encoding differs');
    expect(identicalNote({ encoding: false, eol: false, newline: true })).toBe('Identical text; final newline differs');
    expect(identicalNote({ encoding: true, eol: true, newline: false })).toBe('Identical text; encoding and line endings differ');
    expect(identicalNote({ encoding: true, eol: true, newline: true })).toBe('Identical text; encoding, line endings and final newline differ');
  });
});
