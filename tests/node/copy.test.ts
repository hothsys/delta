import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyEntry } from '../../src/node/folders';
import type { CopyProgress } from '../../src/shared/api';

function roots() {
  const base = mkdtempSync(join(tmpdir(), 'delta-copy-'));
  const left = join(base, 'L');
  const right = join(base, 'R');
  mkdirSync(left);
  mkdirSync(right);
  return { base, left, right };
}
/** `count` small files spread over folders, plus a couple of larger ones. */
function bigTree(root: string, count: number) {
  for (let i = 0; i < count; i++) {
    const dir = join(root, `d${i % 40}`, `s${i % 3}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${i}.txt`), `file ${i}\n`.repeat(50));
  }
  writeFileSync(join(root, 'large.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
}
const noStaging = (dir: string) => readdirSync(dir).filter((n) => n.includes('.delta-')).length === 0;

describe('copying (parallel, staged, cancellable)', () => {
  it('reports progress with totals, ending at all files and bytes', async () => {
    const { left, right } = roots();
    bigTree(join(left, 'pack'), 300);
    const seen: CopyProgress[] = [];
    expect(await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'pack', from: 'left' }, { onProgress: (p) => seen.push(p) })).toEqual({ ok: true });
    const last = seen[seen.length - 1];
    expect(last.totalFiles).toBe(301);
    expect(last.files).toBe(301);
    expect(last.bytes).toBe(last.totalBytes);
    expect(last.totalBytes).toBeGreaterThan(3 * 1024 * 1024);
    expect(readdirSync(join(right, 'pack')).length).toBe(41);
    expect(noStaging(right)).toBe(true);
  });

  it('cancelling leaves the destination exactly as it was, and nothing behind', async () => {
    const { left, right } = roots();
    bigTree(join(left, 'pack'), 2000);
    mkdirSync(join(right, 'pack'));
    writeFileSync(join(right, 'pack', 'keep.txt'), 'original');
    const controller = new AbortController();
    const r = await copyEntry(
      { leftRoot: left, rightRoot: right, relPath: 'pack', from: 'left' },
      { signal: controller.signal, onProgress: (p) => p.files > 50 && controller.abort() },
    );
    expect(r).toMatchObject({ ok: false, cancelled: true });
    expect(readdirSync(join(right, 'pack'))).toEqual(['keep.txt']);
    expect(readFileSync(join(right, 'pack', 'keep.txt'), 'utf8')).toBe('original');
    expect(noStaging(right)).toBe(true);
  });

  it('keeps modified times and permissions, including a read-only folder', async () => {
    if (process.platform === 'win32') return;
    const { left, right } = roots();
    const when = new Date('2024-05-06T07:08:09Z');
    mkdirSync(join(left, 'ro', 'inner'), { recursive: true });
    writeFileSync(join(left, 'ro', 'inner', 'script.sh'), '#!/bin/sh\n');
    chmodSync(join(left, 'ro', 'inner', 'script.sh'), 0o755);
    utimesSync(join(left, 'ro', 'inner', 'script.sh'), when, when);
    utimesSync(join(left, 'ro', 'inner'), when, when);
    chmodSync(join(left, 'ro'), 0o555);
    try {
      expect(await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'ro', from: 'left' })).toEqual({ ok: true });
    } finally {
      chmodSync(join(left, 'ro'), 0o755);
    }
    expect(statSync(join(right, 'ro')).mode & 0o777).toBe(0o555);
    expect(statSync(join(right, 'ro', 'inner', 'script.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(right, 'ro', 'inner', 'script.sh')).mtimeMs).toBe(when.getTime());
    expect(statSync(join(right, 'ro', 'inner')).mtimeMs).toBe(when.getTime());
    chmodSync(join(right, 'ro'), 0o755);
  });

  it('replaces a link at the destination instead of writing through it', async () => {
    const { base, left, right } = roots();
    writeFileSync(join(base, 'elsewhere.txt'), 'must not change');
    writeFileSync(join(left, 'cfg.txt'), 'new contents');
    symlinkSync(join(base, 'elsewhere.txt'), join(right, 'cfg.txt'));
    expect(await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'cfg.txt', from: 'left' })).toEqual({ ok: true });
    expect(lstatSync(join(right, 'cfg.txt')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(right, 'cfg.txt'), 'utf8')).toBe('new contents');
    expect(readFileSync(join(base, 'elsewhere.txt'), 'utf8')).toBe('must not change');
  });

  it('copies a single file over an existing one in one step', async () => {
    const { left, right } = roots();
    writeFileSync(join(left, 'a.txt'), 'new');
    writeFileSync(join(right, 'a.txt'), 'old');
    expect(await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'a.txt', from: 'left' })).toEqual({ ok: true });
    expect(readFileSync(join(right, 'a.txt'), 'utf8')).toBe('new');
    expect(noStaging(right)).toBe(true);
  });

  it('copies a tree of many small files faster than one file at a time', async () => {
    const { left, right, base } = roots();
    bigTree(join(left, 'many'), 2000);
    // Warm the cache so both runs read the same way.
    cpSync(join(left, 'many'), join(base, 'warm'), { recursive: true });
    let t = performance.now();
    await cp(join(left, 'many'), join(base, 'sequential'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    const sequential = performance.now() - t;
    t = performance.now();
    expect(await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'many', from: 'left' })).toEqual({ ok: true });
    const parallel = performance.now() - t;
    expect(existsSync(join(right, 'many', 'd39', 's2'))).toBe(true);
    // Typically 3 to 5 times faster; only assert it isn't slower, so a busy machine can't fail it.
    expect(parallel).toBeLessThan(sequential);
  }, 60000);
});
