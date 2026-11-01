import type { CompareOptions } from './types';

export type KeyFn = (line: string) => string;

/**
 * Returns the function that maps a line to its comparison key under `options`,
 * or `null` when lines are compared verbatim.
 */
export function lineKeyFn(options: CompareOptions): KeyFn | null {
  let ws: KeyFn | null;
  switch (options.whitespace ?? 'exact') {
    case 'trim':
      ws = (s) => s.trim();
      break;
    case 'collapse':
      ws = (s) => s.trim().replace(/\s+/g, ' ');
      break;
    case 'ignore':
      ws = (s) => s.replace(/\s+/g, '');
      break;
    default:
      ws = null;
  }
  if (!options.ignoreCase) return ws;
  if (!ws) return (s) => s.toLowerCase();
  const f = ws;
  return (s) => f(s).toLowerCase();
}

/** Matches the characters `String.prototype.trim` and `\s` treat as whitespace. */
export function isWhitespace(code: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 128) return false;
  return /\s/.test(String.fromCharCode(code));
}
