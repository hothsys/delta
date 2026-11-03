/** The formats Prettify understands. */
export type PrettyKind = 'json' | 'js' | 'ts' | 'css' | 'scss' | 'less' | 'xml' | 'html';

/** Kinds that can be compared with each other once formatted (a .js file against a .ts one, say). */
export type PrettyFamily = 'json' | 'script' | 'style' | 'markup';

const EXTENSIONS: Record<string, PrettyKind> = {
  json: 'json', jsonc: 'json', json5: 'json', map: 'json', geojson: 'json', webmanifest: 'json', har: 'json',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'ts',
  css: 'css', scss: 'scss', less: 'less',
  xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', wsdl: 'xml', rss: 'xml', atom: 'xml',
  xaml: 'xml', kml: 'xml', gpx: 'xml', resx: 'xml', csproj: 'xml', vbproj: 'xml', fsproj: 'xml', props: 'xml',
  targets: 'xml', nuspec: 'xml', xhtml: 'xml',
  html: 'html', htm: 'html',
};

const FAMILY: Record<PrettyKind, PrettyFamily> = {
  json: 'json',
  js: 'script',
  ts: 'script',
  css: 'style',
  scss: 'style',
  less: 'style',
  xml: 'markup',
  html: 'markup',
};

export const familyOf = (kind: PrettyKind) => FAMILY[kind];

export const KIND_NAMES: Record<PrettyKind, string> = {
  json: 'JSON',
  js: 'JavaScript',
  ts: 'TypeScript',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  xml: 'XML',
  html: 'HTML',
};

/**
 * What a file is, from its extension, or from how it starts when the extension says nothing
 * (none, `.txt`, `.log`…). Null when it isn't something Prettify handles.
 */
export function kindOf(path: string | undefined, text: string): PrettyKind | null {
  const name = path?.split(/[\\/]/).pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (EXTENSIONS[ext]) return EXTENSIONS[ext];
  const start = text.slice(0, 1000).replace(/^\ufeff/, '').trimStart();
  if (/^<\?xml\b/.test(start) || /^<svg\b/i.test(start)) return 'xml';
  if (/^<!doctype html\b/i.test(start) || /^<html\b/i.test(start)) return 'html';
  if (/^[{[]/.test(start)) return 'json';
  return null;
}

export type Availability =
  | { ok: true; kinds: { a: PrettyKind; b: PrettyKind } }
  | { ok: false; reason: string };

/** Whether two sides can be prettified: both recognised, and comparable once formatted. */
export function prettifyAvailability(a: { path?: string; text: string }, b: { path?: string; text: string }): Availability {
  // A side with no file yet (missing from one compared folder) follows the other side.
  const ka = kindOf(a.path, a.text);
  const kb = kindOf(b.path, b.text);
  if (!ka && !kb) return { ok: false, reason: 'Prettify works on JSON, JavaScript, TypeScript, CSS, SCSS, Less, XML and HTML files.' };
  if (!ka || !kb) {
    const known = (ka ?? kb)!;
    const unknownSide = ka ? 'right' : 'left';
    if ((ka ? b : a).text.trim() === '') return { ok: true, kinds: { a: known, b: known } };
    return { ok: false, reason: `The ${unknownSide} file isn't ${KIND_NAMES[known]} (or any type Prettify handles).` };
  }
  if (familyOf(ka) !== familyOf(kb)) return { ok: false, reason: `The files are different types (${KIND_NAMES[ka]} and ${KIND_NAMES[kb]}), so they can't be prettified for comparison.` };
  return { ok: true, kinds: { a: ka, b: kb } };
}
