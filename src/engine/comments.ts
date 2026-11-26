/**
 * Comment syntax for one language, and the stateless single-line scan that
 * strips comments from a line before it is compared.
 *
 * v1 scope: full-line and trailing line comments, and block comments that start
 * and end on the same line. Multi-line block comments are out of scope: the scan
 * is stateless, so a line inside a block keeps its text and still counts as
 * important. The scan is a heuristic, not a parser: it tracks string literals
 * (single, double and template quotes, with backslash escapes) so a marker
 * inside a string is not treated as a comment, but it does not understand
 * regex literals or apostrophes in bare words, and it treats a whole template
 * literal as one string, so a marker inside a ${...} expression is not stripped
 * either. It errs toward keeping text, never toward stripping code.
 */

/** How comments look in one language. */
export interface CommentSyntax {
  /** Markers that start a comment running to the end of the line. */
  line?: readonly string[];
  /** Delimiter pairs for block comments that start and end on the same line. */
  block?: readonly (readonly [string, string])[];
}

const SLASH: CommentSyntax = { line: ["//"], block: [["/*", "*/"]] };
const HASH: CommentSyntax = { line: ["#"] };
const BLOCK_ONLY: CommentSyntax = { block: [["/*", "*/"]] };
const MARKUP: CommentSyntax = { block: [["<!--", "-->"]] };

/**
 * Comment syntax by file extension, without the dot. Plain `json` has no
 * comments at all; `jsonc` and `json5` do. Plain `css` has no `//` comments,
 * only block comments; `scss` and `less` have both.
 */
const BY_EXTENSION: Record<string, CommentSyntax> = {
  js: SLASH,
  mjs: SLASH,
  cjs: SLASH,
  jsx: SLASH,
  ts: SLASH,
  mts: SLASH,
  cts: SLASH,
  tsx: SLASH,
  scss: SLASH,
  less: SLASH,
  jsonc: SLASH,
  json5: SLASH,
  css: BLOCK_ONLY,
  py: HASH,
  rb: HASH,
  sh: HASH,
  bash: HASH,
  zsh: HASH,
  yaml: HASH,
  yml: HASH,
  toml: HASH,
  xml: MARKUP,
  svg: MARKUP,
  xsd: MARKUP,
  xsl: MARKUP,
  xslt: MARKUP,
  plist: MARKUP,
  wsdl: MARKUP,
  rss: MARKUP,
  atom: MARKUP,
  xaml: MARKUP,
  kml: MARKUP,
  gpx: MARKUP,
  resx: MARKUP,
  csproj: MARKUP,
  vbproj: MARKUP,
  fsproj: MARKUP,
  props: MARKUP,
  targets: MARKUP,
  nuspec: MARKUP,
  xhtml: MARKUP,
  html: MARKUP,
  htm: MARKUP,
};

/** The comment syntax for an extension, or `null` when it has none. */
export function commentSyntaxForExtension(extension: string): CommentSyntax | null {
  const ext = extension.replace(/^\./, "").toLowerCase();
  return BY_EXTENSION[ext] ?? null;
}

/**
 * Removes comments from one line under `syntax`. A line without a comment is
 * returned unchanged, so exact-whitespace comparison is unaffected. When a
 * comment is removed, trailing whitespace left behind by it is trimmed, so a
 * trailing-comment-only edit and a comment-only line compare equal to the same
 * line without the comment (a comment-only line strips to an empty key, which
 * deliberately collides with a genuinely blank line).
 */
export function stripComments(line: string, syntax: CommentSyntax | null): string {
  if (!syntax) return line;
  const lineMarkers = syntax.line ?? [];
  const blockPairs = syntax.block ?? [];
  if (lineMarkers.length === 0 && blockPairs.length === 0) return line;

  let out = "";
  let i = 0;
  let removed = false;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      // Copy the string literal verbatim, so a marker inside it is not a comment.
      const quote = ch;
      out += ch;
      i++;
      while (i < line.length) {
        const c = line[i];
        out += c;
        i++;
        if (c === "\\" && i < line.length) {
          out += line[i];
          i++;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    let isLineComment = false;
    for (const marker of lineMarkers) {
      if (line.startsWith(marker, i)) {
        isLineComment = true;
        break;
      }
    }
    if (isLineComment) {
      // A line comment runs to the end of the line.
      removed = true;
      break;
    }
    let block: readonly [string, string] | undefined;
    for (const pair of blockPairs) {
      if (line.startsWith(pair[0], i)) {
        block = pair;
        break;
      }
    }
    if (block !== undefined) {
      const end = line.indexOf(block[1], i + block[0].length);
      if (end === -1) {
        // The block does not close on this line: a multi-line block comment,
        // out of scope for v1. Leave the line unchanged.
        return line;
      }
      removed = true;
      i = end + block[1].length;
      continue;
    }
    out += ch;
    i++;
  }
  return removed ? out.trimEnd() : line;
}
