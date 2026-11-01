import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDirectory, locations } from '../../src/node/browse';

describe('listDirectory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delta-browse-'));
  mkdirSync(join(dir, 'zeta'));
  mkdirSync(join(dir, 'Alpha'));
  writeFileSync(join(dir, 'b.txt'), 'bb');
  writeFileSync(join(dir, 'a10.txt'), 'a');
  writeFileSync(join(dir, 'a2.txt'), 'a');
  writeFileSync(join(dir, '.hidden'), 'h');

  it('lists folders first, then files, in natural order, without hidden entries', async () => {
    const r = await listDirectory(dir);
    if (!r.ok) throw new Error(r.message);
    expect(r.entries.map((e) => e.name)).toEqual(['Alpha', 'zeta', 'a2.txt', 'a10.txt', 'b.txt']);
    expect(r.entries.find((e) => e.name === 'b.txt')).toMatchObject({ kind: 'file', size: 2, path: join(dir, 'b.txt') });
    expect(r.parent).toBe(join(dir, '..').replace(/\/$/, ''));
  });

  it('includes hidden entries when asked, and reports a missing folder', async () => {
    const r = await listDirectory(dir, true);
    expect(r.ok && r.entries.some((e) => e.name === '.hidden' && e.hidden)).toBe(true);
    expect(await listDirectory(join(dir, 'nope'))).toMatchObject({ ok: false });
  });

  it('has no parent at the filesystem root', async () => {
    const r = await listDirectory('/');
    expect(r.ok && r.parent).toBeNull();
  });
});

describe('locations', () => {
  it('starts with home and the root, without listing the startup disk twice', async () => {
    const list = await locations();
    expect(list[0]).toEqual({ name: 'Home', path: homedir(), kind: 'home' });
    expect(list[1].kind).toBe('root');
    if (process.platform === 'darwin') expect(list.some((l) => l.kind === 'volume' && l.name === 'Macintosh HD')).toBe(false);
    expect(list.some((l) => l.name.startsWith('.'))).toBe(false);
  });
});
