export type PrettifyResult = { ok: true; text: string } | { ok: false; message: string };

/** A failure at a character offset, reported as "what at line L, column C". */
export function errorAt(text: string, offset: number, what: string): PrettifyResult {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { ok: false, message: `${what} at line ${line}, column ${offset - lineStart + 1}` };
}
