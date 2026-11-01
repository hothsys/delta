import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decode, writeTextFile } from '../../src/node/files';
import { RecentStore } from '../../src/node/recents';

const base = mkdtempSync(join(tmpdir(), 'delta-files-reg-'));

// Bugs found in review, kept fixed.
describe('saving and recents regressions', () => {
  it('saves by replacing the file in one step, keeping its permissions and leaving no temp file', async () => {
    const f = join(base, 'a.sh');
    writeFileSync(f, 'old\n');
    chmodSync(f, 0o750);
    expect(await writeTextFile({ path: f, text: 'new\n', encoding: 'utf8' })).toMatchObject({ ok: true });
    expect(readFileSync(f, 'utf8')).toBe('new\n');
    expect(statSync(f).mode & 0o777).toBe(0o750);
    expect(readdirSync(base).filter((n) => n.includes('delta-tmp'))).toEqual([]);
  });

  it('writes through a symbolic link without replacing the link', async () => {
    const target = join(base, 'target.txt');
    const link = join(base, 'link.txt');
    writeFileSync(target, 'old\n');
    symlinkSync(target, link);
    await writeTextFile({ path: link, text: 'new\n', encoding: 'utf8' });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
  });

  it('refuses an odd-length UTF-16 file rather than drop its last byte on save', () => {
    expect(decode(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42]))).toBeNull();
  });

  it('keeps every entry when recents are updated at the same time, in a private file', async () => {
    const file = join(base, 'recents.json');
    const store = new RecentStore(file);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.remember('files', `/l${i}`, `/r${i}`, i)));
    expect((await store.list()).length).toBe(10);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
