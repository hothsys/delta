import { unwatchFile, watchFile, type Stats } from 'node:fs';

/** How often watched files are polled. Polling, unlike fs.watch, survives editors that save by replacing the file. */
const POLL_MS = 1000;

/**
 * Whoever wants to hear about outside changes: an Electron window, or a browser's event
 * stream. Kept generic so both hosts share this module.
 */
export interface ChangeSubscriber {
  send(path: string): void;
  closed(): boolean;
  onClose(listener: () => void): void;
}

const watchers = new Map<string, { listener: (curr: Stats, prev: Stats) => void; owners: Set<ChangeSubscriber> }>();
const byOwner = new Map<ChangeSubscriber, Set<string>>();
/** Modification times of our own writes, so saving does not report the file as changed elsewhere. */
const ownWrites = new Map<string, number>();

export function noteOwnWrite(path: string, mtimeMs: number): void {
  ownWrites.set(path, mtimeMs);
}

/** Replaces the set of files `owner` wants change notifications for. */
export function setWatched(owner: ChangeSubscriber, paths: string[]): void {
  const next = new Set(paths);
  const prev = byOwner.get(owner);
  for (const p of prev ?? []) if (!next.has(p)) release(owner, p);
  for (const p of next) if (!prev?.has(p)) acquire(owner, p);
  byOwner.set(owner, next);
  if (!prev) owner.onClose(() => stopWatching(owner));
}

/** Drops every watch held by `owner` (when its window or stream goes away). */
export function stopWatching(owner: ChangeSubscriber): void {
  for (const p of byOwner.get(owner) ?? []) release(owner, p);
  byOwner.delete(owner);
}

function acquire(owner: ChangeSubscriber, path: string): void {
  let w = watchers.get(path);
  if (!w) {
    const listener = (curr: Stats, prev: Stats) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      if (ownWrites.get(path) === curr.mtimeMs) return;
      for (const o of watchers.get(path)?.owners ?? []) if (!o.closed()) o.send(path);
    };
    w = { listener, owners: new Set() };
    watchers.set(path, w);
    watchFile(path, { interval: POLL_MS, persistent: false }, listener);
  }
  w.owners.add(owner);
}

function release(owner: ChangeSubscriber, path: string): void {
  const w = watchers.get(path);
  if (!w) return;
  w.owners.delete(owner);
  if (w.owners.size === 0) {
    unwatchFile(path, w.listener);
    watchers.delete(path);
  }
}
