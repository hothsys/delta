import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decode, dominantEol, encode, readTextFile, writeTextFile } from '../../src/node/files';
import type { TextEncoding } from '../../src/shared/api';

describe('decode / encode', () => {
  it.each<[TextEncoding, string]>([
    ['utf8', 'héllo wörld ✓\n'],
    ['utf8-bom', 'with bom\r\n'],
    ['utf16le', 'little ✓'],
    ['utf16be', 'big ✓'],
  ])('round-trips %s', (encoding, text) => {
    const bytes = encode(text, encoding);
    expect(decode(bytes)).toEqual({ text, encoding });
    expect(encode(decode(bytes)!.text, encoding).equals(bytes)).toBe(true);
  });

  it('falls back to Latin-1 for invalid UTF-8 and keeps the bytes intact', () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    const d = decode(bytes)!;
    expect(d).toEqual({ text: 'café\n', encoding: 'latin1' });
    expect(encode(d.text, 'latin1').equals(bytes)).toBe(true);
  });

  it('treats NUL bytes as binary', () => {
    expect(decode(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBeNull();
  });
});

describe('dominantEol', () => {
  it('picks the most common line ending', () => {
    expect(dominantEol('a\nb\nc')).toBe('\n');
    expect(dominantEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(dominantEol('a\rb\r')).toBe('\r');
    expect(dominantEol('no breaks')).toBe('\n');
  });
});

describe('reading and writing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delta-'));

  it('reads text with metadata and refuses binary files', async () => {
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'one\r\ntwo\r\n');
    const r = await readTextFile(p);
    expect(r.ok && r.file).toMatchObject({ name: 'a.txt', text: 'one\r\ntwo\r\n', encoding: 'utf8', eol: '\r\n', size: 10 });

    const bin = join(dir, 'b.bin');
    writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
    expect(await readTextFile(bin)).toMatchObject({ ok: false, reason: 'binary' });
    expect(await readTextFile(join(dir, 'missing.txt'))).toMatchObject({ ok: false, reason: 'error' });
  });

  it('writes in the original encoding, switching Latin-1 to UTF-8 only when needed', async () => {
    const p = join(dir, 'c.txt');
    const r1 = await writeTextFile({ path: p, text: 'bom ✓\n', encoding: 'utf8-bom' });
    expect(r1).toMatchObject({ ok: true, encoding: 'utf8-bom' });
    expect(readFileSync(p).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    expect(await writeTextFile({ path: p, text: 'café', encoding: 'latin1' })).toMatchObject({ encoding: 'latin1' });
    expect(readFileSync(p)).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await writeTextFile({ path: p, text: 'café ✓', encoding: 'latin1' })).toMatchObject({ encoding: 'utf8' });
    expect(readFileSync(p, 'utf8')).toBe('café ✓');
  });
});
