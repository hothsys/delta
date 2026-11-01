import { describe, expect, it } from 'vitest';
import { joinLines, splitLines } from '../../src/engine';

describe('splitLines', () => {
  it('handles empty text', () => {
    expect(splitLines('')).toEqual({ lines: [], eol: 'none', trailingNewline: false });
  });

  it('handles text without a line break', () => {
    expect(splitLines('abc')).toEqual({ lines: ['abc'], eol: 'none', trailingNewline: false });
  });

  it.each([
    ['\n', 'a\nb\n'],
    ['\r\n', 'a\r\nb\r\n'],
    ['\r', 'a\rb\r'],
  ] as const)('detects %j line endings', (eol, text) => {
    expect(splitLines(text)).toEqual({ lines: ['a', 'b'], eol, trailingNewline: true });
  });

  it('reports mixed line endings', () => {
    expect(splitLines('a\nb\r\nc')).toEqual({ lines: ['a', 'b', 'c'], eol: 'mixed', trailingNewline: false });
  });

  it('keeps empty lines', () => {
    expect(splitLines('\n\nx\n').lines).toEqual(['', '', 'x']);
  });
});

describe('joinLines', () => {
  it.each(['a\nb\n', 'a\nb', '\n', 'x', ''])('round-trips %j', (text) => {
    const s = splitLines(text);
    expect(joinLines(s.lines, '\n', s.trailingNewline)).toBe(text);
  });

  it('writes the requested line ending', () => {
    expect(joinLines(['a', 'b'], '\r\n', true)).toBe('a\r\nb\r\n');
  });
});
