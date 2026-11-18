import { statSync, watch, type FSWatcher } from 'node:fs';
import type { FolderChange } from '../shared/api';
import { errorMessage } from './files';
import { IGNORED_NAMES } from './folders';
import { log } from './log';

/**
 * Whoever wants to hear about outside changes in a folder comparison: an Electron window, or
 * a browser tab's event stream (as for file watching in `watch.ts`).
 */
export interface FolderChangeSubscriber {
  send(change: FolderChange): void;
  closed(): boolean;
  onClose(listener: () => void): void;
}

/** Send a batch once changes have stopped for this long… */
const QUIET_MS = 700;
/** …or at least this often while they keep coming (a long build). */
const MAX_WAIT_MS = 3000;
/** More changed paths than this in one batch: the comparison is scanned again instead. */
export const MAX_BATCH_PATHS = 2000;
/** While a compared folder is missing, how often to look for it coming back. */
export const MISSING_ROOT_POLL_MS = 1000;

/**
 * Which folder is at `path` (device and inode, following a link), or null when there's no
 * folder there. Replacing a folder (deleting it and copying another in, or Finder's Replace)
 * gives a new identity even under the same name.
 */
function folderIdentity(path: string): string | null {
  try {
    const s = statSync(path);
    return s.isDirectory() ? `${s.dev}:${s.ino}` : null;
  } catch {
    return null;
  }
}

const active = new Map<FolderChangeSubscriber, () => void>();
const closeHooked = new WeakSet<FolderChangeSubscriber>();

/**
 * Watches the compared roots for outside changes (an editor saving, `git checkout`, a build),
 * replacing whatever `owner` watched before; `null` stops. Uses the system's recursive watching
 * (FSEvents on macOS, ReadDirectoryChangesW on Windows, inotify on Linux). Changed paths are
 * collected and sent in batches. A root that is deleted, replaced or put back asks for a full
 * rescan (`overflow`), and one that's missing (even from the start) is looked for until it
 * returns. Returns null when watching started, or why it couldn't (a network share, the Linux
 * limit on watched folders…); the caller falls back to rescanning.
 */
export function watchFolders(owner: FolderChangeSubscriber, roots: string[] | null): string | null {
  active.get(owner)?.();
  active.delete(owner);
  if (!roots) return null;

  const pending = new Set<string>();
  let overflow = false;
  let timer: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let firstAt = 0;
  let stopped = false;
  /** Per root: the folder being watched (`id` null while there's none at that path) and its watcher. */
  const watched = [...new Set(roots)].map((path) => ({ path, id: folderIdentity(path), watcher: null as FSWatcher | null }));
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(poll);
    for (const r of watched) r.watcher?.close();
  };

  const schedule = () => {
    const now = Date.now();
    if (!firstAt) firstAt = now;
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(QUIET_MS, firstAt + MAX_WAIT_MS - now)));
  };

  /**
   * A root deleted, replaced or put back is reported as one change to the root itself (as its
   * own name), with nothing about what's inside: a folder moved or copied in as a whole brings
   * its contents silently. So each batch first checks that every root is still the folder
   * being watched; if not, the comparison is scanned again in full, the new folder is watched
   * (a watch on a deleted folder stays on it on some systems), and a missing one is looked for
   * until it's back.
   */
  const checkRoots = () => {
    let changed = false;
    for (const r of watched) {
      const id = folderIdentity(r.path);
      if (id === r.id) continue;
      changed = true;
      log.info('watch', id === null ? 'A compared folder is gone' : 'A compared folder was replaced or is back', { root: r.path });
      r.watcher?.close();
      r.watcher = null;
      r.id = id;
      if (id === null) continue;
      try {
        startWatcher(r);
      } catch (err) {
        failed(r.path, err);
        return true;
      }
    }
    const missing = watched.some((r) => r.id === null);
    if (missing && !poll) {
      poll = setInterval(() => {
        if (watched.some((r) => r.id !== folderIdentity(r.path))) schedule();
      }, MISSING_ROOT_POLL_MS);
      poll.unref();
    } else if (!missing && poll) {
      clearInterval(poll);
      poll = undefined;
    }
    return changed;
  };

  const flush = () => {
    timer = undefined;
    firstAt = 0;
    if (stopped || owner.closed()) return;
    if (checkRoots()) overflow = true;
    if (stopped) return; // a new watcher failed and stopped everything
    if (!overflow && pending.size === 0) return;
    const change: FolderChange = overflow ? { overflow: true } : { paths: [...pending] };
    log.debug('watch', 'Folder changes', overflow ? { overflow: true } : { paths: pending.size });
    pending.clear();
    overflow = false;
    owner.send(change);
  };

  const noted = (filename: string | null) => {
    if (filename === null) overflow = true; // the system couldn't say what changed
    else {
      const parts = filename.split(/[\\/]/).filter(Boolean);
      if (parts.length === 0 || parts.some((p) => IGNORED_NAMES.has(p) || isDeltaScratch(p))) return;
      pending.add(parts.join('/'));
      if (pending.size > MAX_BATCH_PATHS) overflow = true;
    }
    schedule();
  };

  const failed = (root: string, err: unknown) => {
    stop();
    if (active.get(owner) === stop) active.delete(owner);
    log.warn('watch', 'Folder watching stopped', { root, error: errorMessage(err) });
    if (!owner.closed()) owner.send({ error: errorMessage(err) });
  };

  /** Throws if the system won't watch the folder; later errors stop watching altogether. */
  function startWatcher(r: (typeof watched)[number]) {
    const w = watch(r.path, { recursive: true, persistent: false }, (_event, filename) => noted(filename === null ? null : String(filename)));
    w.on('error', (err) => {
      if (r.watcher !== w) return;
      // The folder itself went away (some systems report that as an error): wait for it.
      if (folderIdentity(r.path) === null) {
        w.close();
        r.watcher = null;
        schedule();
      } else failed(r.path, err);
    });
    r.watcher = w;
  }

  try {
    for (const r of watched) if (r.id !== null) startWatcher(r);
  } catch (err) {
    stop();
    log.warn('watch', 'Could not watch folders', { roots: roots.join(' | '), error: errorMessage(err) });
    return errorMessage(err);
  }
  // A root missing from the start (deleted while its last scan ran) is looked for until it's back.
  checkRoots();
  active.set(owner, stop);
  if (!closeHooked.has(owner)) {
    closeHooked.add(owner);
    owner.onClose(() => {
      active.get(owner)?.();
      active.delete(owner);
    });
  }
  log.info('watch', 'Watching folders for outside changes', { roots: roots.join(' | ') });
  return null;
}

/**
 * Delta's own short-lived names: a copy being staged or the folder it replaces
 * (`.name.delta-copy-…`, `.name.delta-old-…`), and a file being saved (`.name.….delta-tmp`).
 * They come and go in the middle of Delta's own work and are never worth an update.
 */
export const isDeltaScratch = (name: string) => name.startsWith('.') && (/\.delta-(copy|old)-\d+-\d+$/.test(name) || name.endsWith('.delta-tmp'));

/** How many owners are watching folders (tests). */
export const folderWatchCount = () => active.size;
