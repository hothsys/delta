import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from './files';
import type { ComparisonKind, PathState, RecentComparison, RecentSide } from '../shared/api';

/** How many unique comparisons are remembered. */
export const MAX_RECENTS = 20;

interface StoredRecent {
  kind: ComparisonKind;
  left: string;
  right: string;
  at: number;
}

const sameComparison = (x: StoredRecent, kind: ComparisonKind, left: string, right: string) =>
  x.kind === kind && x.left === left && x.right === right;

/** Recent comparisons kept as a small JSON file (in the app's user-data folder). */
export class RecentStore {
  constructor(private readonly file: string) {}

  /** Changes run one at a time, so overlapping updates can't lose each other's entries. */
  private queue: Promise<unknown> = Promise.resolve();
  private update(change: (list: StoredRecent[]) => StoredRecent[]): Promise<void> {
    const next = this.queue.then(async () => this.save(change(await this.load())));
    this.queue = next.catch(() => {});
    return next;
  }

  remember(kind: ComparisonKind, left: string, right: string, now = Date.now()): Promise<void> {
    return this.update((list) => [{ kind, left, right, at: now }, ...list.filter((x) => !sameComparison(x, kind, left, right))].slice(0, MAX_RECENTS));
  }

  forget(kind: ComparisonKind, left: string, right: string): Promise<void> {
    return this.update((list) => list.filter((x) => !sameComparison(x, kind, left, right)));
  }

  /** Newest first, with each side's availability checked now. */
  async list(): Promise<RecentComparison[]> {
    const want = (kind: ComparisonKind) => (kind === 'folders' ? 'dir' : 'file');
    return Promise.all(
      (await this.load()).map(async (x) => ({
        kind: x.kind,
        at: x.at,
        left: await describePath(x.left, want(x.kind)),
        right: await describePath(x.right, want(x.kind)),
      })),
    );
  }

  private async load(): Promise<StoredRecent[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(data)) return [];
      return data.filter(
        (x): x is StoredRecent =>
          !!x && (x.kind === 'files' || x.kind === 'folders') && typeof x.left === 'string' && typeof x.right === 'string',
      );
    } catch {
      return [];
    }
  }

  // Written whole and atomically (the desktop app and the browser version share this file, so
  // a half-written file would wipe the list), readable only by this user (it lists their paths).
  private async save(list: StoredRecent[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(list, null, 2), 0o600);
  }
}

/** Whether a path is usable now, and which external drive (if any) it lives on. */
export async function describePath(path: string, want: 'file' | 'dir', platform = process.platform): Promise<RecentSide> {
  const volume = volumeOf(path, platform);
  let state: PathState = 'available';
  if (volume && !(await exists(volume.root))) state = 'unmounted';
  else {
    const kind = await kindOf(path);
    if (kind !== want) state = 'missing';
  }
  return volume ? { path, state, volume: volume.name } : { path, state };
}

/**
 * The external drive or network share a path is on, or null for the system drive:
 * macOS `/Volumes/<name>`; Windows drive letters other than the system drive, and UNC shares;
 * Linux `/media/<user>/<name>`, `/run/media/<user>/<name>` and `/mnt/<name>`.
 */
export function volumeOf(
  path: string,
  platform: NodeJS.Platform = process.platform,
  systemDrive = process.env.SystemDrive ?? 'C:',
): { name: string; root: string } | null {
  if (platform === 'darwin') {
    const m = /^\/Volumes\/([^/]+)/.exec(path);
    return m ? { name: m[1], root: `/Volumes/${m[1]}` } : null;
  }
  if (platform === 'win32') {
    const unc = /^(\\\\[^\\]+\\[^\\]+)/.exec(path);
    if (unc) return { name: unc[1], root: unc[1] + '\\' };
    const drive = /^([A-Za-z]:)/.exec(path);
    if (drive && drive[1].toUpperCase() !== systemDrive.toUpperCase()) return { name: drive[1].toUpperCase(), root: `${drive[1]}\\` };
    return null;
  }
  const m = /^(\/(?:run\/)?media\/[^/]+\/([^/]+))/.exec(path) ?? /^(\/mnt\/([^/]+))/.exec(path);
  return m ? { name: m[2], root: m[1] } : null;
}

async function kindOf(path: string): Promise<'file' | 'dir' | null> {
  try {
    return (await stat(path)).isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await kindOf(path)) !== null;
}
