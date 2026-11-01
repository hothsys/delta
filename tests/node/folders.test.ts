import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { compareFolders, copyEntry, filesEqual } from '../../src/node/folders';
import type { FolderNode } from '../../src/shared/api';

function tree(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    if (rel.endsWith('/')) mkdirSync(p, { recursive: true });
    else writeFileSync(p, content);
  }
}

/** Flattens to `relPath: status` for compact assertions. */
function statuses(node: FolderNode, out: Record<string, string> = {}) {
  for (const c of node.children ?? []) {
    out[c.relPath] = c.status;
    statuses(c, out);
  }
  return out;
}

let left: string;
let right: string;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'delta-folders-'));
  left = join(base, 'L');
  right = join(base, 'R');
  tree(left, {
    'same.txt': 'same',
    'changed.txt': 'version one',
    'samesize.txt': 'abcd',
    'only-left.txt': 'x',
    'src/a.ts': 'export const a = 1;',
    'src/b.ts': 'export const b = 2;',
    'docs/readme.md': 'hello',
    'swap': 'i am a file',
    '.git/HEAD': 'ignored',
  });
  tree(right, {
    'same.txt': 'same',
    'changed.txt': 'version two!',
    'samesize.txt': 'abce',
    'only-right.txt': 'y',
    'src/a.ts': 'export const a = 1;',
    'src/b.ts': 'export const b = 3;',
    'docs/readme.md': 'hello',
    'swap/inner.txt': 'now a folder',
  });
});

describe('compareFolders', () => {
  it('classifies every entry and rolls folder status up', async () => {
    const r = await compareFolders(left, right);
    if (!r.ok) throw new Error(r.message);
    expect(statuses(r.root)).toEqual({
      docs: 'same',
      'docs/readme.md': 'same',
      src: 'different',
      'src/a.ts': 'same',
      'src/b.ts': 'different',
      swap: 'kind-mismatch',
      'swap/inner.txt': 'right-only',
      'changed.txt': 'different',
      'only-left.txt': 'left-only',
      'only-right.txt': 'right-only',
      'same.txt': 'same',
      'samesize.txt': 'different',
    });
    expect(r.root.status).toBe('different');
    // Folders first, then files, alphabetically.
    expect(r.root.children!.map((c) => c.name)).toEqual([
      'docs',
      'src',
      'swap',
      'changed.txt',
      'only-left.txt',
      'only-right.txt',
      'same.txt',
      'samesize.txt',
    ]);
  });

  it('marks binary files, but not UTF-16 text', async () => {
    writeFileSync(join(left, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));
    writeFileSync(join(left, 'utf16.txt'), Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]));
    const r = await compareFolders(left, right);
    if (!r.ok) throw new Error(r.message);
    const byName = (n: string) => r.root.children!.find((c) => c.name === n)!;
    expect(byName('image.png').left?.binary).toBe(true);
    expect(byName('utf16.txt').left?.binary).toBe(false);
    expect(byName('same.txt').left?.binary).toBe(false);
  });

  it('reports a missing root', async () => {
    expect(await compareFolders(join(left, 'nope'), right)).toMatchObject({ ok: false });
  });
});

describe('compare modes', () => {
  const at = (p: string, seconds: number) => utimesSync(p, seconds, seconds);
  const statusOf = async (mode: 'contents' | 'size-date' | 'date', name: string) => {
    const r = await compareFolders(left, right, mode);
    if (!r.ok) throw new Error(r.message);
    return r.root.children!.find((c) => c.name === name)!.status;
  };

  it('size-date trusts metadata: same size and time count as the same even if the bytes differ', async () => {
    // samesize.txt: same size, different content.
    at(join(left, 'samesize.txt'), 1_700_000_000);
    at(join(right, 'samesize.txt'), 1_700_000_001); // within the 2-second tolerance
    expect(await statusOf('contents', 'samesize.txt')).toBe('different');
    expect(await statusOf('size-date', 'samesize.txt')).toBe('same');
    expect(await statusOf('date', 'samesize.txt')).toBe('same');
  });

  it('uses a 2-second tolerance for modified times, and size-date also checks size', async () => {
    // changed.txt: different sizes.
    at(join(left, 'changed.txt'), 1_700_000_000);
    at(join(right, 'changed.txt'), 1_700_000_000);
    expect(await statusOf('date', 'changed.txt')).toBe('same');
    expect(await statusOf('size-date', 'changed.txt')).toBe('different');
    at(join(right, 'changed.txt'), 1_700_000_005);
    expect(await statusOf('date', 'changed.txt')).toBe('different');
  });

  it('only checks for binary files when comparing by contents', async () => {
    writeFileSync(join(left, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const fast = await compareFolders(left, right, 'date');
    if (!fast.ok) throw new Error(fast.message);
    expect(fast.root.children!.find((c) => c.name === 'image.png')!.left?.binary).toBeUndefined();
  });
});

describe('progress, cancellation and the same-file shortcut', () => {
  it('recognises a folder compared with itself without reading file contents', async () => {
    writeFileSync(join(left, 'large.bin'), Buffer.alloc(64 * 1024 * 1024, 3));
    let final = { bytesRead: -1, filesCompared: 0 };
    const r = await compareFolders(left, left, 'contents', { onProgress: (p) => (final = p) });
    if (!r.ok) throw new Error(r.message);
    expect(r.root.status).toBe('same');
    expect(final.filesCompared).toBeGreaterThan(5);
    // Only the 8KB binary checks run, one per file: nowhere near the 128MB a full comparison reads.
    expect(final.bytesRead).toBeLessThan(200 * 1024);
  });

  it('still reads both copies in full when the files are separate', async () => {
    writeFileSync(join(left, 'copy.bin'), Buffer.alloc(4 * 1024 * 1024, 5));
    writeFileSync(join(right, 'copy.bin'), Buffer.alloc(4 * 1024 * 1024, 5));
    let final = { bytesRead: 0 };
    const r = await compareFolders(left, right, 'contents', { onProgress: (p) => (final = p) });
    if (!r.ok) throw new Error(r.message);
    expect(r.root.children!.find((c) => c.name === 'copy.bin')!.status).toBe('same');
    expect(final.bytesRead).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  });

  it('reports progress with entry and file counts', async () => {
    writeFileSync(join(left, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
    writeFileSync(join(right, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
    const seen: { last?: { entries: number; filesCompared: number; bytesRead: number } } = {};
    const r = await compareFolders(left, right, 'contents', { onProgress: (p) => (seen.last = p) });
    expect(r.ok).toBe(true);
    // The final report carries the totals: both 3MB copies read in full.
    expect(seen.last?.entries).toBeGreaterThan(10);
    expect(seen.last?.filesCompared).toBeGreaterThan(5);
    expect(seen.last?.bytesRead).toBeGreaterThanOrEqual(6 * 1024 * 1024);
  });

  it('stops promptly when cancelled, even part-way through a large file', async () => {
    writeFileSync(join(left, 'huge.bin'), Buffer.alloc(64 * 1024 * 1024, 7));
    writeFileSync(join(right, 'huge.bin'), Buffer.alloc(64 * 1024 * 1024, 7));
    const controller = new AbortController();
    const t0 = performance.now();
    const pending = compareFolders(left, right, 'contents', { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, cancelled: true });
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('detects binary files through the combined read of equal-sized pairs', async () => {
    writeFileSync(join(left, 'pair.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    writeFileSync(join(right, 'pair.bin'), Buffer.from([0x00, 0x01, 0x02, 0x04]));
    const r = await compareFolders(left, right, 'contents');
    if (!r.ok) throw new Error(r.message);
    const node = r.root.children!.find((c) => c.name === 'pair.bin')!;
    expect(node).toMatchObject({ status: 'different', left: { binary: true }, right: { binary: true } });
    expect(r.root.children!.find((c) => c.name === 'same.txt')!.left?.binary).toBe(false);
  });
});

describe('filesEqual', () => {
  it('compares contents across chunk boundaries', async () => {
    const big = 'x'.repeat(200_000);
    writeFileSync(join(left, 'big1'), big);
    writeFileSync(join(left, 'big2'), big);
    writeFileSync(join(left, 'big3'), big.slice(0, -1) + 'y');
    expect(await filesEqual(join(left, 'big1'), join(left, 'big2'), 200_000, 200_000)).toBe(true);
    expect(await filesEqual(join(left, 'big1'), join(left, 'big3'), 200_000, 200_000)).toBe(false);
  });
});

describe('copyEntry', () => {
  it('copies files and folders in either direction, creating parents', async () => {
    expect(await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'src/b.ts', from: 'left' })).toEqual({ ok: true });
    expect(readFileSync(join(right, 'src/b.ts'), 'utf8')).toBe('export const b = 2;');

    expect(await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'only-right.txt', from: 'right' })).toEqual({ ok: true });
    expect(readFileSync(join(left, 'only-right.txt'), 'utf8')).toBe('y');

    tree(left, { 'new/deep/file.txt': 'deep' });
    expect(await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'new', from: 'left' })).toEqual({ ok: true });
    expect(readFileSync(join(right, 'new/deep/file.txt'), 'utf8')).toBe('deep');
  });

  it('replaces a folder with a file when the kinds differ', async () => {
    expect(await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'swap', from: 'left' })).toEqual({ ok: true });
    expect(readFileSync(join(right, 'swap'), 'utf8')).toBe('i am a file');
  });

  it('refuses paths that escape the roots', async () => {
    const r = await copyEntry({ leftRoot: left, rightRoot: right, relPath: '../L/same.txt', from: 'left' });
    expect(r).toMatchObject({ ok: false });
  });
});
