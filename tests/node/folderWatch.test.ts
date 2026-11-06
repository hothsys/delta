import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareEntries, copyEntry } from '../../src/node/folders';
import { folderWatchCount, MAX_BATCH_PATHS, watchFolders, type FolderChangeSubscriber } from '../../src/node/folderWatch';
import type { FolderChange } from '../../src/shared/api';

function roots() {
  const base = mkdtempSync(join(tmpdir(), 'delta-fwatch-'));
  const left = join(base, 'L');
  const right = join(base, 'R');
  for (const d of [left, right, join(left, 'sub'), join(right, 'sub')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(left, 'a.txt'), 'a');
  writeFileSync(join(right, 'a.txt'), 'a');
  writeFileSync(join(left, 'sub/b.txt'), 'b');
  writeFileSync(join(right, 'sub/b.txt'), 'b');
  return { left, right };
}

/** A subscriber collecting batches, like a window or a tab's event stream. */
function subscriber() {
  const batches: FolderChange[] = [];
  let close = () => {};
  const s: FolderChangeSubscriber = {
    send: (c) => batches.push(c),
    closed: () => false,
    onClose: (l) => (close = l),
  };
  const paths = () => new Set(batches.flatMap((b) => ('paths' in b ? b.paths : [])));
  return { s, batches, paths, close: () => close() };
}

const until = async (test: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!test() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return test();
};

const opened: FolderChangeSubscriber[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) watchFolders(s, null);
});

describe('compareEntries', () => {
  it('re-compares just the given entries, after edits, creations and deletions on either side', async () => {
    const { left, right } = roots();
    writeFileSync(join(right, 'a.txt'), 'changed');
    writeFileSync(join(left, 'sub/new.txt'), 'n');
    rmSync(join(right, 'sub/b.txt'));
    const r = await compareEntries(left, right, ['a.txt', 'sub/new.txt', 'sub/b.txt', 'missing.txt'], 'contents');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = Object.fromEntries(r.updates.map((u) => [u.relPath, u.node?.status ?? null]));
    expect(by).toEqual({ 'a.txt': 'different', 'sub/new.txt': 'left-only', 'sub/b.txt': 'left-only', 'missing.txt': null });
  });

  it('compares a folder with everything in it', async () => {
    const { left, right } = roots();
    writeFileSync(join(right, 'sub/b.txt'), 'other');
    const r = await compareEntries(left, right, ['sub'], 'contents');
    expect(r.ok && r.updates[0].node).toMatchObject({ status: 'different', children: [{ name: 'b.txt', status: 'different' }] });
  });

  it('refuses the roots themselves and paths outside them', async () => {
    const { left, right } = roots();
    expect((await compareEntries(left, right, [''], 'contents')).ok).toBe(false);
    expect((await compareEntries(left, right, ['../x'], 'contents')).ok).toBe(false);
  });
});

describe('watchFolders', () => {
  it('reports outside changes in either root, batched, as paths relative to the roots', async () => {
    const { left, right } = roots();
    const sub = subscriber();
    opened.push(sub.s);
    expect(watchFolders(sub.s, [left, right])).toBeNull();
    await new Promise((r) => setTimeout(r, 200)); // let the system's watch settle
    writeFileSync(join(right, 'a.txt'), 'edited elsewhere');
    writeFileSync(join(left, 'sub/new.txt'), 'created');
    renameSync(join(right, 'sub/b.txt'), join(right, 'sub/renamed.txt'));
    expect(await until(() => ['a.txt', 'sub/new.txt', 'sub/b.txt', 'sub/renamed.txt'].every((p) => sub.paths().has(p)))).toBe(true);
    // Several changes close together arrive as few batches, not one per event.
    expect(sub.batches.length).toBeLessThanOrEqual(3);
  });

  it('ignores .git and .DS_Store, as the comparison does', async () => {
    const { left, right } = roots();
    mkdirSync(join(left, '.git'));
    const sub = subscriber();
    opened.push(sub.s);
    watchFolders(sub.s, [left, right]);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(left, '.git/HEAD'), 'ref');
    writeFileSync(join(left, '.DS_Store'), 'x');
    writeFileSync(join(left, 'a.txt'), 'real change');
    expect(await until(() => sub.paths().has('a.txt'))).toBe(true);
    expect([...sub.paths()].some((p) => p.includes('.git') || p.includes('.DS_Store'))).toBe(false);
  });

  it('turns a burst of thousands of changes into one "too many" batch', async () => {
    const { left, right } = roots();
    const sub = subscriber();
    opened.push(sub.s);
    watchFolders(sub.s, [left, right]);
    await new Promise((r) => setTimeout(r, 200));
    mkdirSync(join(left, 'many'));
    for (let i = 0; i <= MAX_BATCH_PATHS + 50; i++) writeFileSync(join(left, 'many', `f${i}.txt`), 'x');
    expect(await until(() => sub.batches.some((b) => 'overflow' in b), 10000)).toBe(true);
  });

  it('sees Delta’s own copies too (the update is the same as a rescan would find)', async () => {
    const { left, right } = roots();
    writeFileSync(join(left, 'only-left.txt'), 'x');
    const sub = subscriber();
    opened.push(sub.s);
    watchFolders(sub.s, [left, right]);
    await new Promise((r) => setTimeout(r, 200));
    await copyEntry({ leftRoot: left, rightRoot: right, relPath: 'only-left.txt', from: 'left' });
    expect(await until(() => sub.paths().has('only-left.txt'))).toBe(true);
  });

  it('stops when asked, when replaced, and when its window or tab goes away', () => {
    const { left, right } = roots();
    const a = subscriber();
    const b = subscriber();
    const before = folderWatchCount();
    watchFolders(a.s, [left, right]);
    watchFolders(a.s, [left, right]); // replacing: still one watch for this owner
    watchFolders(b.s, [left]);
    expect(folderWatchCount()).toBe(before + 2);
    watchFolders(a.s, null);
    expect(folderWatchCount()).toBe(before + 1);
    b.close();
    expect(folderWatchCount()).toBe(before);
  });

  it('says why when a folder cannot be watched', () => {
    const sub = subscriber();
    expect(watchFolders(sub.s, [join(tmpdir(), 'delta-no-such-folder-' + Date.now())])).toMatch(/no such file|ENOENT/i);
  });
});
