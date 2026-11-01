import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareFolders, copyEntry } from '../../src/node/folders';
import type { FolderNode } from '../../src/shared/api';

const base = mkdtempSync(join(tmpdir(), 'delta-folders-reg-'));
const dir = (...p: string[]) => {
  const d = join(base, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};
const child = (root: FolderNode, name: string) => root.children!.find((c) => c.name === name)!;
const locked: string[] = [];
afterAll(() => locked.forEach((p) => chmodSync(p, 0o755)));

// Bugs found in review, kept fixed.
describe('folder comparison regressions', () => {
  it('never reports an unreadable folder as the same', async () => {
    const [l, r] = [dir('u', 'L', 'sub'), dir('u', 'R', 'sub')];
    writeFileSync(join(l, 'x'), '1');
    writeFileSync(join(r, 'x'), '1');
    chmodSync(l, 0o000);
    chmodSync(r, 0o000);
    locked.push(l, r);
    const res = await compareFolders(join(base, 'u', 'L'), join(base, 'u', 'R'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sub = child(res.root, 'sub');
    expect(sub.status).toBe('different');
    expect(sub.error).toBeTruthy();
    expect(res.root.status).toBe('different');
  });

  it('marks an unreadable file instead of failing the whole comparison', async () => {
    const [l, r] = [dir('f', 'L'), dir('f', 'R')];
    writeFileSync(join(l, 'a.txt'), 'same size');
    writeFileSync(join(r, 'a.txt'), 'same size');
    writeFileSync(join(l, 'ok.txt'), 'fine');
    writeFileSync(join(r, 'ok.txt'), 'fine');
    chmodSync(join(r, 'a.txt'), 0o000);
    locked.push(join(r, 'a.txt'));
    const res = await compareFolders(l, r);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(child(res.root, 'a.txt')).toMatchObject({ status: 'different' });
    expect(child(res.root, 'a.txt').error).toBeTruthy();
    expect(child(res.root, 'ok.txt').status).toBe('same');
  });

  it('compares symbolic links by where they point', async () => {
    const [l, r] = [dir('s', 'L'), dir('s', 'R')];
    dir('s', 'x');
    dir('s', 'y');
    symlinkSync(join(base, 's', 'x'), join(l, 'link'));
    symlinkSync(join(base, 's', 'y'), join(r, 'link'));
    symlinkSync('target.txt', join(l, 'rel'));
    symlinkSync('target.txt', join(r, 'rel'));
    const res = await compareFolders(l, r);
    expect(res.ok && child(res.root, 'link').status).toBe('different');
    expect(res.ok && child(res.root, 'rel').status).toBe('same');
  });

  it('refuses to copy through a link that leads outside the destination', async () => {
    const [l, r] = [dir('e', 'L', 'd'), dir('e', 'R')];
    const outside = dir('e', 'outside');
    writeFileSync(join(l, 'f'), 'secret');
    symlinkSync(outside, join(r, 'd'));
    const res = await copyEntry({ leftRoot: join(base, 'e', 'L'), rightRoot: r, relPath: 'd/f', from: 'left' });
    expect(res.ok).toBe(false);
    expect(existsSync(join(outside, 'f'))).toBe(false);
  });

  it('copies a symbolic link as the same link', async () => {
    const [l, r] = [dir('c', 'L'), dir('c', 'R')];
    writeFileSync(join(l, 'real'), 'x');
    symlinkSync('real', join(l, 'link'));
    expect(await copyEntry({ leftRoot: l, rightRoot: r, relPath: 'link', from: 'left' })).toEqual({ ok: true });
    expect(readlinkSync(join(r, 'link'))).toBe('real');
  });
});
