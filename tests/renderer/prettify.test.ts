import { describe, expect, it } from 'vitest';
import { diffText } from '../../src/engine';
import { prettify } from '../../src/renderer/src/prettify';
import { formatJson } from '../../src/renderer/src/prettify/json';
import { kindOf, prettifyAvailability } from '../../src/renderer/src/prettify/kinds';
import { formatMarkup } from '../../src/renderer/src/prettify/markup';

const ok = (r: { ok: boolean; text?: string; message?: string }) => {
  if (!r.ok) throw new Error(`expected success, got: ${r.message}`);
  return r.text!;
};
/** Formatted versions of two texts compare with no differences. */
const sameOnceFormatted = (a: string, b: string) => diffText(a, b, { whitespace: 'exact', ignoreCase: false }).stats.changeBlocks === 0;

describe('JSON', () => {
  it('puts one value per line, keeping every token exactly as written', () => {
    expect(ok(formatJson('{"a":1.0,"b":[1e3,12345678901234567890,true,null],"c":{},"d":[],"e":"x\\"y"}'))).toBe(
      ['{', '  "a": 1.0,', '  "b": [', '    1e3,', '    12345678901234567890,', '    true,', '    null', '  ],', '  "c": {},', '  "d": [],', '  "e": "x\\"y"', '}', ''].join('\n'),
    );
  });

  it('keeps duplicate keys, comments and trailing commas (JSONC)', () => {
    const text = ok(formatJson('{"a":1,"a":2, // second\n/* block */"b":[1,],}'));
    expect(text).toBe(['{', '  "a": 1,', '  "a": 2,', '  // second', '  /* block */', '  "b": [', '    1,', '  ],', '}', ''].join('\n'));
  });

  it('formats minified and already-formatted copies identically', () => {
    const minified = '{"name":"delta","scripts":{"dev":"electron-vite dev","test":"vitest run"},"files":["a","b"]}';
    const formatted = '{\n    "name" : "delta",\n    "scripts" : {\n        "dev" : "electron-vite dev",\n        "test" : "vitest run"\n    },\n    "files" : [ "a", "b" ]\n}\n';
    expect(ok(formatJson(minified))).toBe(ok(formatJson(formatted)));
  });

  it.each([
    ['{"a":}', 'Unexpected "}" at line 1, column 6'],
    ['{"a" 1}', 'Unexpected "1" at line 1, column 6'],
    ['[1 2]', 'Unexpected "2" at line 1, column 4'],
    ['{"a":1', 'Missing "}" at the end at line 1, column 7'],
    ['{"a":"x', 'Unterminated string at line 1, column 6'],
    ['{\n  "a": tru\n}', 'Unexpected "t" at line 2, column 8'],
    ['', 'No JSON value found at line 1, column 1'],
    ['1 2', 'Unexpected "2" at line 1, column 3'],
  ])('reports %j as invalid: %s', (input, message) => {
    expect(formatJson(input)).toEqual({ ok: false, message });
  });
});

describe('XML and HTML', () => {
  it('puts one element per line, keeping tags and text exactly', () => {
    expect(ok(formatMarkup('<?xml version="1.0"?><root a="1"><name>  two  spaces </name><empty/><list><item>1</item></list><!-- c --></root>', false))).toBe(
      ['<?xml version="1.0"?>', '<root a="1">', '  <name>  two  spaces </name>', '  <empty/>', '  <list>', '    <item>1</item>', '  </list>', '  <!-- c -->', '</root>', ''].join('\n'),
    );
  });

  it('keeps attribute values with ">" in them, and CDATA', () => {
    expect(ok(formatMarkup('<a t="x > y"><![CDATA[<raw>]]></a>', false))).toBe('<a t="x > y">\n  <![CDATA[<raw>]]>\n</a>\n');
  });

  it('is strict about XML end tags', () => {
    expect(formatMarkup('<a><b></a>', false)).toEqual({ ok: false, message: 'Expected </b> but found </a> at line 1, column 7' });
    expect(formatMarkup('<a><b></b>', false)).toEqual({ ok: false, message: 'Missing </a> at the end at line 1, column 11' });
    expect(formatMarkup('<a', false)).toEqual({ ok: false, message: 'Unterminated tag at line 1, column 1' });
  });

  it('keeps HTML <pre>, <textarea>, <script> and <style> contents exactly', () => {
    const html = '<body><pre>  a\n    b </pre><script>if(a<b){x()}</script><style>p{margin:0}</style><textarea> t </textarea></body>';
    expect(ok(formatMarkup(html, true))).toBe(
      ['<body>', '  <pre>  a', '    b </pre>', '  <script>if(a<b){x()}</script>', '  <style>p{margin:0}</style>', '  <textarea> t </textarea>', '</body>', ''].join('\n'),
    );
  });

  it('handles HTML void elements, implied end tags and stray "<"', () => {
    expect(ok(formatMarkup('<ul><li>one<li>two</ul><p>a < b<br>c</p>', true))).toBe(
      ['<ul>', '  <li>', '    one', '  <li>', '    two', '</ul>', '<p>', '  a < b', '  <br>', '  c', '</p>', ''].join('\n'),
    );
  });

  it('formats minified and formatted copies identically', () => {
    expect(ok(formatMarkup('<svg><g><path d="M0 0"/></g></svg>', false))).toBe(ok(formatMarkup('<svg>\n    <g>\n        <path d="M0 0"/>\n    </g>\n</svg>\n', false)));
  });
});

describe('JavaScript, TypeScript and CSS (Prettier)', () => {
  it('formats JavaScript, including regex literals and template strings', async () => {
    expect(ok(await prettify('function f(a,b){return a+b}const x=/re\\/g/.test(`t${1}`);', 'js'))).toBe('function f(a, b) {\n  return a + b;\n}\nconst x = /re\\/g/.test(`t${1}`);\n');
  });

  it('formats TypeScript, CSS, SCSS and Less', async () => {
    expect(ok(await prettify('let x:number=1;interface A{b:string}', 'ts'))).toBe('let x: number = 1;\ninterface A {\n  b: string;\n}\n');
    expect(ok(await prettify('a{color:red;margin:0}', 'css'))).toBe('a {\n  color: red;\n  margin: 0;\n}\n');
    expect(ok(await prettify('$c:red;a{b{color:$c}}', 'scss'))).toBe('$c: red;\na {\n  b {\n    color: $c;\n  }\n}\n');
    expect(ok(await prettify('@c:red;a{color:@c}', 'less'))).toBe('@c: red;\na {\n  color: @c;\n}\n');
  });

  it('makes a minified and a readable copy of the same code compare equal', async () => {
    const readable = 'export function add(a, b) {\n  return a + b;\n}\nexport const twice = (x) => add(x, x);\n';
    const minified = 'export function add(a,b){return a+b}export const twice=x=>add(x,x);';
    expect(sameOnceFormatted(ok(await prettify(readable, 'js')), ok(await prettify(minified, 'js')))).toBe(true);
    // Comments, and a blank line the author left, survive formatting (Prettier keeps them), so they still show.
    const commented = 'export function add(a, b) {\n  // sum\n  return a + b;\n}\nexport const twice = (x) => add(x, x);\n';
    expect(diffText(ok(await prettify(commented, 'js')), ok(await prettify(minified, 'js')), { whitespace: 'exact', ignoreCase: false }).stats.changeBlocks).toBe(1);
    expect(sameOnceFormatted(ok(await prettify('a{color:red}', 'css')), ok(await prettify('a {\n  color : red ;\n}', 'css')))).toBe(true);
  });

  it('is deterministic', async () => {
    const src = 'const a={b:[1,2,3],c:()=>{return 1}}';
    expect(await prettify(src, 'js')).toEqual(await prettify(src, 'js'));
  });

  it('reports a parse error with its position instead of throwing', async () => {
    expect(await prettify('function (', 'js')).toEqual({ ok: false, message: 'Unexpected token at line 1, column 10' });
    const css = await prettify('a{color:red', 'css');
    expect(css.ok).toBe(false);
  });
});

describe('prettify()', () => {
  it('leaves empty text alone and refuses very large input', async () => {
    expect(await prettify('  \n', 'json')).toEqual({ ok: true, text: '  \n' });
    expect(await prettify('x'.repeat(21 * 1024 * 1024), 'json')).toEqual({ ok: false, message: "it's over 20MB, too large to prettify" });
  });
});

describe('file types', () => {
  it('come from the extension, or from how the file starts', () => {
    expect(kindOf('/a/b.json', '')).toBe('json');
    expect(kindOf('C:\\x\\style.min.css', '')).toBe('css');
    expect(kindOf('app.tsx', '')).toBe('ts');
    expect(kindOf('icon.SVG', '')).toBe('xml');
    expect(kindOf('page.htm', '')).toBe('html');
    expect(kindOf('notes.txt', 'hello')).toBe(null);
    expect(kindOf('data', '  {"a":1}')).toBe('json');
    expect(kindOf('feed.txt', '\ufeff<?xml version="1.0"?><a/>')).toBe('xml');
    expect(kindOf(undefined, '<!DOCTYPE html><html></html>')).toBe('html');
  });

  it('allow comparable pairs only', () => {
    expect(prettifyAvailability({ path: 'a.js', text: '' }, { path: 'b.ts', text: '' })).toEqual({ ok: true, kinds: { a: 'js', b: 'ts' } });
    expect(prettifyAvailability({ path: 'a.json', text: '' }, { path: 'b.css', text: '' })).toMatchObject({ ok: false, reason: expect.stringContaining('JSON and CSS') });
    expect(prettifyAvailability({ path: 'a.txt', text: 'x' }, { path: 'b.txt', text: 'y' })).toMatchObject({ ok: false, reason: expect.stringContaining('Prettify works on') });
    expect(prettifyAvailability({ path: 'a.json', text: '{}' }, { path: 'b.txt', text: 'x' })).toMatchObject({ ok: false, reason: expect.stringContaining("right file isn't JSON") });
    // A side with no file yet takes the other side's type.
    expect(prettifyAvailability({ path: 'a.json', text: '{}' }, { path: undefined, text: '' })).toEqual({ ok: true, kinds: { a: 'json', b: 'json' } });
  });
});
