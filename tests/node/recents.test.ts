import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describePath, MAX_RECENTS, RecentStore, volumeOf } from '../../src/node/recents';

describe('volumeOf', () => {
  it('recognises external drives on each platform', () => {
    expect(volumeOf('/Volumes/Backup/photos', 'darwin')).toEqual({ name: 'Backup', root: '/Volumes/Backup' });
    expect(volumeOf('/Users/me/photos', 'darwin')).toBeNull();
    expect(volumeOf('D:\\photos', 'win32', 'C:')).toEqual({ name: 'D:', root: 'D:\\' });
    expect(volumeOf('c:\\Users\\me', 'win32', 'C:')).toBeNull();
    expect(volumeOf('\\\\nas\\share\\photos', 'win32', 'C:')).toEqual({ name: '\\\\nas\\share', root: '\\\\nas\\share\\' });
    expect(volumeOf('/media/me/USB/photos', 'linux')).toEqual({ name: 'USB', root: '/media/me/USB' });
    expect(volumeOf('/run/media/me/USB', 'linux')).toEqual({ name: 'USB', root: '/run/media/me/USB' });
    expect(volumeOf('/mnt/data/x', 'linux')).toEqual({ name: 'data', root: '/mnt/data' });
    expect(volumeOf('/home/me', 'linux')).toBeNull();
  });
});

describe('describePath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delta-recents-'));
  writeFileSync(join(dir, 'a.txt'), 'a');

  it('reports available, missing and wrong-kind paths', async () => {
    expect(await describePath(join(dir, 'a.txt'), 'file')).toEqual({ path: join(dir, 'a.txt'), state: 'available' });
    expect((await describePath(join(dir, 'nope.txt'), 'file')).state).toBe('missing');
    expect((await describePath(dir, 'file')).state).toBe('missing');
    expect((await describePath(dir, 'dir')).state).toBe('available');
  });

  it('reports a path on a disconnected drive as unmounted', async () => {
    expect(await describePath('/Volumes/DeltaNoSuchDrive/x', 'dir', 'darwin')).toEqual({
      path: '/Volumes/DeltaNoSuchDrive/x',
      state: 'unmounted',
      volume: 'DeltaNoSuchDrive',
    });
  });
});

describe('RecentStore', () => {
  const base = mkdtempSync(join(tmpdir(), 'delta-store-'));
  const l = join(base, 'L');
  const r = join(base, 'R');
  mkdirSync(l);
  mkdirSync(r);

  it('keeps unique comparisons, newest first, moving repeats to the top', async () => {
    const store = new RecentStore(join(base, 'sub', 'recents.json'));
    await store.remember('folders', l, r, 1);
    await store.remember('files', join(l, 'a'), join(r, 'b'), 2);
    await store.remember('folders', l, r, 3);
    const list = await store.list();
    expect(list.map((x) => [x.kind, x.at])).toEqual([
      ['folders', 3],
      ['files', 2],
    ]);
    expect(list[0].left.state).toBe('available');
    expect(list[1].left.state).toBe('missing');
  });

  it(`keeps at most ${MAX_RECENTS}`, async () => {
    const store = new RecentStore(join(base, 'many.json'));
    for (let i = 0; i < MAX_RECENTS + 5; i++) await store.remember('files', `/a/${i}`, `/b/${i}`, i);
    const list = await store.list();
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0].left.path).toBe(`/a/${MAX_RECENTS + 4}`);
  });

  it('forgets a comparison and survives a corrupt file', async () => {
    const file = join(base, 'forget.json');
    const store = new RecentStore(file);
    await store.remember('folders', l, r);
    await store.forget('folders', l, r);
    expect(await store.list()).toEqual([]);
    writeFileSync(file, '{ not json');
    expect(await store.list()).toEqual([]);
  });
});
