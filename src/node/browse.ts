import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import type { DirEntry, DirectoryListing, Location } from '../shared/api';
import { errorMessage } from './files';
import { log } from './log';

/** A folder's entries (folders first, then files, by name). Hidden entries only when asked for. */
export async function listDirectory(path: string, showHidden = false): Promise<DirectoryListing> {
  const dir = resolve(path);
  try {
    const names = await readdir(dir);
    const entries = (
      await Promise.all(
        names
          .filter((n) => showHidden || !n.startsWith('.'))
          .map(async (name): Promise<DirEntry | null> => {
            const full = join(dir, name);
            try {
              // Follows symlinks, so a link to a folder can be opened like a folder.
              const s = await stat(full);
              return {
                name,
                path: full,
                kind: s.isDirectory() ? 'dir' : 'file',
                size: s.isDirectory() ? 0 : s.size,
                mtimeMs: s.mtimeMs,
                hidden: name.startsWith('.'),
              };
            } catch {
              return null; // broken link or no permission: skip it
            }
          }),
      )
    ).filter((e): e is DirEntry => e !== null);
    entries.sort(
      (a, b) =>
        (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
    );
    const parent = dirname(dir);
    log.debug('browse', 'Listed', { path: dir, entries: entries.length, hidden: showHidden });
    return { ok: true, path: dir, parent: parent === dir ? null : parent, entries };
  } catch (err) {
    log.warn('browse', 'Could not list', { path: dir, error: errorMessage(err) });
    return { ok: false, path: dir, message: errorMessage(err) };
  }
}

/** Starting points for browsing: home, the filesystem root, and mounted drives and shares. */
export async function locations(platform: NodeJS.Platform = process.platform): Promise<Location[]> {
  const home = homedir();
  const out: Location[] = [{ name: 'Home', path: home, kind: 'home' }];
  const isDir = async (p: string) => {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  };
  const children = async (p: string) => {
    try {
      return (await readdir(p)).map((n) => join(p, n));
    } catch {
      return [];
    }
  };

  if (platform === 'win32') {
    const system = (process.env.SystemDrive ?? 'C:').toUpperCase();
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`;
      if (!(await isDir(root))) continue;
      out.push({ name: `${letter}:`, path: root, kind: `${letter}:` === system ? 'root' : 'volume' });
    }
    return out;
  }

  out.push({ name: platform === 'darwin' ? 'Computer' : 'Root', path: parse(home).root || '/', kind: 'root' });
  const candidates =
    platform === 'darwin'
      ? await children('/Volumes')
      : [
          ...(await Promise.all([`/media/${process.env.USER ?? ''}`, `/run/media/${process.env.USER ?? ''}`].map(children))).flat(),
          ...(await children('/mnt')),
        ];
  for (const p of candidates) {
    // Hidden entries (e.g. ones security software keeps in /Volumes) aren't drives people use.
    if ((p.split('/').pop() ?? '').startsWith('.')) continue;
    if (!(await isDir(p))) continue;
    // macOS lists the startup disk in /Volumes as a link to "/"; it's already shown as Computer.
    if (platform === 'darwin' && (await realpath(p).catch(() => p)) === '/') continue;
    out.push({ name: p.split('/').pop() ?? p, path: p, kind: 'volume' });
  }
  return out;
}
