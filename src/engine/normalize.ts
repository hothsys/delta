import { commentSyntaxForExtension, stripComments } from "./comments";
import type { LineDiffOptions } from "./types";

export type KeyFn = (line: string) => string;

/**
 * Returns the function that maps a line to its comparison key under `options`,
 * or `null` when lines are compared verbatim. The stages compose in one order:
 * comment stripping first, then the whitespace key, then case folding.
 */
export function lineKeyFn(options: LineDiffOptions): KeyFn | null {
  let strip: KeyFn | null = null;
  if (options.ignoreComments) {
    const syntax = commentSyntaxForExtension(options.extension ?? "");
    if (syntax) strip = (s) => stripComments(s, syntax);
  }
  let ws: KeyFn | null;
  switch (options.whitespace ?? "exact") {
    case "trim":
      ws = (s) => s.trim();
      break;
    case "collapse":
      ws = (s) => s.trim().replace(/\s+/g, " ");
      break;
    case "ignore":
      ws = (s) => s.replace(/\s+/g, "");
      break;
    default:
      ws = null;
  }
  const key = strip ? (ws ? (s: string) => ws(strip(s)) : strip) : ws;
  if (!options.ignoreCase) return key;
  if (!key) return (s) => s.toLowerCase();
  const f = key;
  return (s) => f(s).toLowerCase();
}

/** Matches the characters `String.prototype.trim` and `\s` treat as whitespace. */
export function isWhitespace(code: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 128) return false;
  return /\s/.test(String.fromCharCode(code));
}
