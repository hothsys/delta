import { watch, type FSWatcher } from 'node:fs';
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

const active = new Map<FolderChangeSubscriber, () => void>();
const closeHooked = new WeakSet<FolderChangeSubscriber>();

/**
 * Watches the compared roots for outside changes (an editor saving, `git checkout`, a build),
 * replacing whatever `owner` watched before; `null` stops. Uses the system's recursive watching
 * (FSEvents on macOS, ReadDirectoryChangesW on Windows, inotify on Linux). Changed paths are
 * collected and sent in batches. Returns null when watching started, or why it couldn't
 * (a network share, the Linux limit on watched folders…); the caller falls back to rescanning.
 */
export function watchFolders(owner: FolderChangeSubscriber, roots: string[] | null): string | null {
  active.get(owner)?.();
  active.delete(owner);
  if (!roots) return null;

  const pending = new Set<string>();
  let overflow = false;
  let timer: NodeJS.Timeout | undefined;
  let firstAt = 0;
  const watchers: FSWatcher[] = [];
  const stop = () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };

  const flush = () => {
    timer = undefined;
    firstAt = 0;
    if (owner.closed()) return;
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
      if (parts.length === 0 || parts.some((p) => IGNORED_NAMES.has(p))) return;
      pending.add(parts.join('/'));
      if (pending.size > MAX_BATCH_PATHS) overflow = true;
    }
    const now = Date.now();
    if (!firstAt) firstAt = now;
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(QUIET_MS, firstAt + MAX_WAIT_MS - now)));
  };

  try {
    for (const root of new Set(roots)) {
      const w = watch(root, { recursive: true, persistent: false }, (_event, filename) => noted(filename === null ? null : String(filename)));
      w.on('error', (err) => {
        stop();
        if (active.get(owner) === stop) active.delete(owner);
        log.warn('watch', 'Folder watching stopped', { root, error: errorMessage(err) });
        if (!owner.closed()) owner.send({ error: errorMessage(err) });
      });
      watchers.push(w);
    }
  } catch (err) {
    stop();
    log.warn('watch', 'Could not watch folders', { roots: roots.join(' | '), error: errorMessage(err) });
    return errorMessage(err);
  }
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

/** How many owners are watching folders (tests). */
export const folderWatchCount = () => active.size;
