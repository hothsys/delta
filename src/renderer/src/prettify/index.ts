import { formatJson } from './json';
import type { PrettyKind } from './kinds';
import { formatMarkup } from './markup';
import type { PrettifyResult } from './result';

export type { PrettifyResult } from './result';

/** Larger inputs aren't prettified: formatting would take too long and use too much memory. */
export const MAX_PRETTIFY_BYTES = 20 * 1024 * 1024;

/**
 * The settings every file is formatted with. Both sides always use the same ones, so the
 * formatting itself never shows up as a difference.
 */
const PRETTIER_OPTIONS = { printWidth: 100, tabWidth: 2, useTabs: false, endOfLine: 'lf' } as const;

/**
 * Formats `text` as `kind` for a read-only comparison. JSON, XML and HTML use Delta's own
 * formatters (fast, and they never change a token); JavaScript, TypeScript and the CSS family
 * use Prettier, loaded on first use. Never throws: a file that doesn't parse gives
 * `{ ok: false, message }` with the position.
 */
export async function prettify(text: string, kind: PrettyKind): Promise<PrettifyResult> {
  if (text.trim() === '') return { ok: true, text };
  if (text.length > MAX_PRETTIFY_BYTES) return { ok: false, message: `it's over ${MAX_PRETTIFY_BYTES / 1024 / 1024}MB, too large to prettify` };
  try {
    switch (kind) {
      case 'json':
        return formatJson(text);
      case 'xml':
        return formatMarkup(text, false);
      case 'html':
        return formatMarkup(text, true);
      default:
        return await withPrettier(text, kind);
    }
  } catch (err) {
    return { ok: false, message: describe(err) };
  }
}

async function withPrettier(text: string, kind: 'js' | 'ts' | 'css' | 'scss' | 'less'): Promise<PrettifyResult> {
  const prettier = await import('prettier/standalone');
  let plugins;
  let parser: string;
  if (kind === 'js' || kind === 'ts') {
    const [estree, lang] = await Promise.all([
      import('prettier/plugins/estree'),
      kind === 'js' ? import('prettier/plugins/babel') : import('prettier/plugins/typescript'),
    ]);
    plugins = [estree, lang];
    parser = kind === 'js' ? 'babel' : 'typescript';
  } else {
    plugins = [await import('prettier/plugins/postcss')];
    parser = kind;
  }
  // `plugins` holds module namespaces, which is what Prettier's standalone build takes.
  return { ok: true, text: await prettier.format(text, { ...PRETTIER_OPTIONS, parser, plugins: plugins as never[] }) };
}

/** Prettier's errors carry a position and a code frame; keep the first line and the position. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const first = err.message.split('\n')[0].replace(/\s*\(\d+:\d+\)\s*$/, '');
  const loc = (err as Error & { loc?: { start?: { line: number; column: number } } }).loc?.start;
  return loc ? `${first} at line ${loc.line}, column ${loc.column}` : first;
}
