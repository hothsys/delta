import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, stat, symlink, utimes } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  TIMESTAMP_TOLERANCE_MS,
  type CopyProgress,
  type CopyRequest,
  type CopyResult,
  type EntryInfo,
  type EntryStatus,
  type FolderCompareMode,
  type FolderCompareResult,
  type FolderEntriesResult,
  type FolderNode,
  type FolderProgress,
} from '../shared/api';
import { BINARY_SNIFF_BYTES, errorMessage, looksBinary } from './files';
import { log } from './log';

/** Never interesting in a comparison and often huge or noisy. */
export const IGNORED_NAMES = new Set(['.git', '.DS_Store']);
const CHUNK_BYTES = 64 * 1024;
/** File comparisons in flight at once. */
const MAX_PARALLEL_COMPARES = 16;

export interface CompareOptions {
  /** Aborting stops the comparison promptly (between folders, files and read chunks). */
  signal?: AbortSignal;
  /** Called with live counters, at most every PROGRESS_INTERVAL_MS. */
  onProgress?: (progress: FolderProgress) => void;
}

/** How often progress is reported. */
const PROGRESS_INTERVAL_MS = 150;

class Cancelled extends Error {}

interface Stat extends EntryInfo {
  /** Same device and inode means literally the same file; empty where that can't be trusted. */
  id: string;
  /** For a symbolic link, where it points: links are compared by target, not followed. */
  link?: string;
}

interface Context {
  mode: FolderCompareMode;
  signal?: AbortSignal;
  progress: FolderProgress;
  report: () => void;
}

export async function compareFolders(
  leftRoot: string,
  rightRoot: string,
  mode: FolderCompareMode = 'contents',
  options: CompareOptions = {},
): Promise<FolderCompareResult> {
  const t0 = performance.now();
  const progress: FolderProgress = { entries: 0, filesCompared: 0, bytesRead: 0, current: '', elapsedMs: 0 };
  let lastReport = 0;
  const ctx: Context = {
    mode,
    signal: options.signal,
    progress,
    report: () => {
      const now = performance.now();
      if (!options.onProgress || now - lastReport < PROGRESS_INTERVAL_MS) return;
      lastReport = now;
      options.onProgress({ ...progress, elapsedMs: now - t0 });
    },
  };
  log.info('folders', 'Comparing folders', { left: leftRoot, right: rightRoot, mode });
  const totals = () => ({ entries: progress.entries, files: progress.filesCompared, bytesRead: progress.bytesRead, ms: Math.round(performance.now() - t0) });
  try {
    // The roots themselves may be links to folders (entries inside are never followed).
    const [l, r] = await Promise.all([rootInfo(leftRoot), rootInfo(rightRoot)]);
    const notFolder = (path: string): FolderCompareResult => {
      log.warn('folders', 'Not a folder', { path });
      return { ok: false, message: `${path} is not a folder.` };
    };
    if (l?.kind !== 'dir') return notFolder(leftRoot);
    if (r?.kind !== 'dir') return notFolder(rightRoot);
    const root = await compareDir(ctx, '', '', leftRoot, rightRoot, l, r);
    const elapsedMs = performance.now() - t0;
    // Always finish with the final totals, however recently the last throttled report went out.
    options.onProgress?.({ ...progress, current: '', elapsedMs });
    const unreadable = unreadableEntries(root);
    log.info('folders', 'Folder comparison finished', { status: root.status, ...totals(), unreadable: unreadable.length || undefined });
    for (const node of unreadable.slice(0, MAX_LOGGED_ERRORS)) log.warn('folders', "Couldn't read", { relPath: node.relPath || '.', error: node.error });
    if (unreadable.length > MAX_LOGGED_ERRORS) log.warn('folders', `…and ${unreadable.length - MAX_LOGGED_ERRORS} more that couldn't be read`);
    return { ok: true, root, leftRoot, rightRoot, elapsedMs };
  } catch (err) {
    if (err instanceof Cancelled) {
      log.info('folders', 'Folder comparison cancelled', totals());
      return { ok: false, cancelled: true, message: 'The comparison was cancelled.' };
    }
    log.error('folders', 'Folder comparison failed', totals(), err);
    return { ok: false, message: errorMessage(err) };
  }
}

/** Unreadable entries logged one by one after a scan; past this, only how many more. */
const MAX_LOGGED_ERRORS = 50;

/**
 * Re-compares only the given entries (relative paths, using `/`), for updating a comparison
 * after outside changes instead of scanning everything again. A folder is compared with
 * everything inside it. An entry gone from both sides comes back as `node: null`.
 */
export async function compareEntries(
  leftRoot: string,
  rightRoot: string,
  relPaths: string[],
  mode: FolderCompareMode = 'contents',
): Promise<FolderEntriesResult> {
  const t0 = performance.now();
  const ctx: Context = { mode, progress: { entries: 0, filesCompared: 0, bytesRead: 0, current: '', elapsedMs: 0 }, report: () => {} };
  try {
    const updates = await Promise.all(
      relPaths.map(async (relPath) => {
        const parts = relPath.split('/').filter(Boolean);
        if (parts.length === 0) throw new Error('A compared folder itself can only be scanned again in full.');
        const clean = parts.join('/');
        const lPath = inside(leftRoot, clean);
        const rPath = inside(rightRoot, clean);
        const [l, r] = await Promise.all([info(lPath), info(rPath)]);
        if (!l && !r) return { relPath: clean, node: null };
        return { relPath: clean, node: await compareEntry(ctx, parts[parts.length - 1], clean, l ? lPath : null, r ? rPath : null, l, r) };
      }),
    );
    log.debug('folders', 'Re-compared changed entries', { entries: relPaths.length, mode, ms: Math.round(performance.now() - t0) });
    return { ok: true, updates };
  } catch (err) {
    log.warn('folders', 'Could not re-compare changed entries', { entries: relPaths.length, error: errorMessage(err) });
    return { ok: false, message: errorMessage(err) };
  }
}

/** Entries that couldn't be read, anywhere in the tree. */
function unreadableEntries(node: FolderNode, found: FolderNode[] = []): FolderNode[] {
  if (node.error) found.push(node);
  for (const c of node.children ?? []) unreadableEntries(c, found);
  return found;
}

function checkCancelled(ctx: Context): void {
  if (ctx.signal?.aborted) throw new Cancelled();
}

async function compareDir(
  ctx: Context,
  name: string,
  relPath: string,
  leftAbs: string | null,
  rightAbs: string | null,
  left?: Stat,
  right?: Stat,
): Promise<FolderNode> {
  checkCancelled(ctx);
  ctx.progress.current = relPath;
  const [lList, rList] = await Promise.all([list(leftAbs), list(rightAbs)]);
  const lEntries = lList.entries;
  const rEntries = rList.entries;
  const error = lList.error ?? rList.error;
  ctx.progress.entries += lEntries.size + rEntries.size;
  ctx.report();
  const names = [...new Set([...lEntries.keys(), ...rEntries.keys()])];
  const children = await Promise.all(
    names.map(async (n) => {
      const li = lEntries.get(n);
      const ri = rEntries.get(n);
      const childRel = relPath ? `${relPath}/${n}` : n;
      const lPath = li && leftAbs ? join(leftAbs, n) : null;
      const rPath = ri && rightAbs ? join(rightAbs, n) : null;
      return compareEntry(ctx, n, childRel, lPath, rPath, li, ri);
    }),
  );
  children.sort(byKindThenName);

  let status: EntryStatus;
  if (!left) status = 'right-only';
  else if (!right) status = 'left-only';
  // An unreadable folder can't be called the same, whatever (little) could be listed.
  else status = !error && children.every((c) => c.status === 'same') ? 'same' : 'different';
  return { name, relPath, left: publicInfo(left), right: publicInfo(right), status, children, ...(error && { error }) };
}

async function compareEntry(
  ctx: Context,
  name: string,
  relPath: string,
  leftAbs: string | null,
  rightAbs: string | null,
  left?: Stat,
  right?: Stat,
): Promise<FolderNode> {
  const isDir = (left ?? right)!.kind === 'dir';
  if (left && right && left.kind !== right.kind) {
    // Show what is inside whichever side is a folder.
    const dir =
      left.kind === 'dir'
        ? await compareDir(ctx, name, relPath, leftAbs, null, left)
        : await compareDir(ctx, name, relPath, null, rightAbs, undefined, right);
    return { ...dir, left: publicInfo(left), right: publicInfo(right), status: 'kind-mismatch' };
  }
  if (isDir) return compareDir(ctx, name, relPath, leftAbs, rightAbs, left, right);

  checkCancelled(ctx);
  const l = publicInfo(left);
  const r = publicInfo(right);
  let status: EntryStatus;
  let error: string | undefined;
  if (!left) status = 'right-only';
  else if (!right) status = 'left-only';
  else {
    try {
      status = (await sameFile(ctx, leftAbs!, rightAbs!, left, right, l!, r!)) ? 'same' : 'different';
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      // One unreadable (or vanished) file is that entry's problem, not the whole comparison's.
      status = 'different';
      error = errorMessage(err);
    }
    ctx.progress.filesCompared++;
    ctx.report();
  }
  // Only Contents mode opens files, so only it can tell which ones are binary. Files on one
  // side (and pairs whose sizes differ) are checked here; equal-sized pairs got it from the
  // comparison's first read.
  if (ctx.mode === 'contents') {
    if (l && l.binary === undefined) l.binary = await sniffBinary(ctx, leftAbs!, left!.size);
    if (r && r.binary === undefined) r.binary = await sniffBinary(ctx, rightAbs!, right!.size);
  }
  return { name, relPath, left: l, right: r, status, ...(error && { error }) };
}

/** The entry as sent to the interface (without the internal file identity). */
function publicInfo(s: Stat | undefined): EntryInfo | undefined {
  if (!s) return undefined;
  const { id: _id, link: _link, ...rest } = s;
  return rest;
}

/** Folders (on either side, so file/folder mismatches too) before files, then by name. */
const byKindThenName = (a: FolderNode, b: FolderNode) => {
  const ad = a.children ? 0 : 1;
  const bd = b.children ? 0 : 1;
  return ad - bd || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
};

/**
 * Whether two files present on both sides count as the same under the context's mode. In
 * Contents mode it also records whether each file is binary when it reads them anyway.
 */
async function sameFile(ctx: Context, a: string, b: string, sa: Stat, sb: Stat, ia: EntryInfo, ib: EntryInfo): Promise<boolean> {
  // Symbolic links are the same when they point to the same place.
  if (sa.link !== undefined || sb.link !== undefined) return sa.link === sb.link;
  const sameTime = Math.abs(sa.mtimeMs - sb.mtimeMs) <= TIMESTAMP_TOLERANCE_MS;
  if (ctx.mode === 'date') return sameTime;
  if (ctx.mode === 'size-date') return sameTime && sa.size === sb.size;
  if (sa.size !== sb.size) return false;
  if (sa.id && sa.id === sb.id) {
    // Literally the same file (e.g. a folder compared with itself, or hard links): no need to read it.
    const binary = await sniffBinary(ctx, a, sa.size);
    ia.binary = binary;
    ib.binary = binary;
    return true;
  }
  const result = await contentsEqual(ctx, a, b, sa.size);
  ia.binary = result.binaryA;
  ib.binary = result.binaryB;
  return result.equal;
}

/**
 * Entries of a folder (none for a missing one; for an unreadable one, none plus the error).
 * Symbolic links are listed as entries and never followed (that risks cycles).
 */
async function list(abs: string | null): Promise<{ entries: Map<string, Stat>; error?: string }> {
  const entries = new Map<string, Stat>();
  if (!abs) return { entries };
  let dirents: Dirent[];
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch (err) {
    return { entries, error: errorMessage(err) };
  }
  await Promise.all(
    dirents.map(async (d) => {
      if (IGNORED_NAMES.has(d.name)) return;
      const i = await info(join(abs, d.name));
      if (i) entries.set(d.name, i);
    }),
  );
  return { entries };
}

async function rootInfo(abs: string): Promise<Stat | undefined> {
  try {
    const s = await stat(abs);
    return { kind: s.isDirectory() ? 'dir' : 'file', size: 0, mtimeMs: s.mtimeMs, id: '' };
  } catch {
    return undefined;
  }
}

/**
 * An entry as compared: folders and files, with symbolic links as files recording their
 * target (never followed). File identity is left out where it can't be trusted: Windows file
 * ids lose precision as numbers, and some network filesystems report 0 for every file.
 */
async function info(abs: string): Promise<Stat | undefined> {
  try {
    const s = await lstat(abs);
    if (s.isSymbolicLink()) return { kind: 'file', size: 0, mtimeMs: s.mtimeMs, id: '', link: await readlink(abs) };
    return {
      kind: s.isDirectory() ? 'dir' : 'file',
      size: s.isDirectory() ? 0 : s.size,
      mtimeMs: s.mtimeMs,
      id: process.platform === 'win32' || s.ino === 0 ? '' : `${s.dev}:${s.ino}`,
    };
  } catch {
    return undefined;
  }
}

// A small semaphore so huge trees do not open thousands of files at once.
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL_COMPARES) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Reads the start of a file to decide whether it is binary (unreadable files count as binary). */
async function sniffBinary(ctx: Context, path: string, size: number): Promise<boolean> {
  if (size === 0) return false;
  return limited(async () => {
    checkCancelled(ctx);
    try {
      const f = await open(path, 'r');
      try {
        const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
        const { bytesRead } = await f.read(buf, 0, BINARY_SNIFF_BYTES, 0);
        ctx.progress.bytesRead += bytesRead;
        return looksBinary(buf.subarray(0, bytesRead));
      } finally {
        await f.close();
      }
    } catch {
      return true;
    }
  });
}

/**
 * Byte-for-byte comparison of two equal-sized files, streamed in chunks and stopping at the
 * first difference. The first chunk also tells whether each file is binary.
 */
async function contentsEqual(ctx: Context, a: string, b: string, size: number): Promise<{ equal: boolean; binaryA: boolean; binaryB: boolean }> {
  if (size === 0) return { equal: true, binaryA: false, binaryB: false };
  return limited(async () => {
    checkCancelled(ctx);
    // One after the other, so a failure opening the second can't leak the first.
    const fa = await open(a, 'r');
    let fb;
    try {
      fb = await open(b, 'r');
    } catch (err) {
      await fa.close();
      throw err;
    }
    try {
      const ba = Buffer.alloc(CHUNK_BYTES);
      const bb = Buffer.alloc(CHUNK_BYTES);
      let binaryA = false;
      let binaryB = false;
      for (let pos = 0; pos < size; ) {
        checkCancelled(ctx);
        const [ra, rb] = await Promise.all([fa.read(ba, 0, CHUNK_BYTES, pos), fb.read(bb, 0, CHUNK_BYTES, pos)]);
        ctx.progress.bytesRead += ra.bytesRead + rb.bytesRead;
        if (pos === 0) {
          binaryA = looksBinary(ba.subarray(0, ra.bytesRead));
          binaryB = looksBinary(bb.subarray(0, rb.bytesRead));
        }
        if (ra.bytesRead !== rb.bytesRead) return { equal: false, binaryA, binaryB };
        if (ra.bytesRead === 0) break;
        if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return { equal: false, binaryA, binaryB };
        pos += ra.bytesRead;
        if (size > CHUNK_BYTES * 16) ctx.report();
      }
      return { equal: true, binaryA, binaryB };
    } finally {
      await Promise.all([fa.close(), fb.close()]);
    }
  });
}

/** Byte-for-byte comparison of two files; different sizes short-circuit. Exported for tests. */
export async function filesEqual(a: string, b: string, sizeA: number, sizeB: number): Promise<boolean> {
  if (sizeA !== sizeB) return false;
  const ctx: Context = { mode: 'contents', progress: { entries: 0, filesCompared: 0, bytesRead: 0, current: '', elapsedMs: 0 }, report: () => {} };
  return (await contentsEqual(ctx, a, b, sizeA)).equal;
}

/** File copies in flight at once: enough to keep the I/O threads and the disk busy with many small files. */
const COPY_PARALLEL = 16;

export interface CopyOptions {
  /** Aborting stops the copy and removes what was copied so far; the destination is left as it was. */
  signal?: AbortSignal;
  /** Called with live counters, at most every PROGRESS_INTERVAL_MS. */
  onProgress?: (progress: CopyProgress) => void;
}

/**
 * Copies a file or folder from one tree to the same place in the other, replacing what is
 * there. A folder copied onto a folder replaces it: afterwards the destination matches the
 * source exactly, so files and folders only on the destination side are gone (the renderer
 * has confirmed that, naming them). Symbolic links are copied as links, unchanged.
 *
 * Nothing at the destination is touched until the copy is complete: everything is copied to a
 * hidden name beside it first, then swapped in. Cancelling, a failure partway or a full disk
 * leave the destination exactly as it was. Files are copied up to COPY_PARALLEL at a time, as
 * copy-on-write clones where the filesystem supports them (APFS, Btrfs, XFS).
 */
export async function copyEntry(req: CopyRequest, options: CopyOptions = {}): Promise<CopyResult> {
  const t0 = performance.now();
  let staging: string | undefined;
  let plan: CopyPlan | undefined;
  try {
    // The roots themselves are never copied: replacing one would reach outside it.
    if (req.relPath.split('/').filter(Boolean).length === 0) return { ok: false, message: 'Choose a file or folder inside the compared folders.' };
    const srcRoot = req.from === 'left' ? req.leftRoot : req.rightRoot;
    const dstRoot = req.from === 'left' ? req.rightRoot : req.leftRoot;
    const src = inside(srcRoot, req.relPath);
    const dst = inside(dstRoot, req.relPath);
    await insideReally(dstRoot, dst);
    const [s, d] = await Promise.all([lstat(src).catch(() => null), lstat(dst).catch(() => null)]);
    if (!s) return { ok: false, message: `${req.relPath} no longer exists on the ${req.from}.` };
    plan = await planCopy(src, s, options.signal);
    await mkdir(dirname(dst), { recursive: true });
    staging = join(dirname(dst), `.${basename(dst)}.delta-copy-${process.pid}-${Date.now()}`);
    await runCopy(plan, staging, req.relPath, t0, options);
    await swapIn(staging, dst, d);
    staging = undefined;
    log.info('folders', 'Copied', { from: src, to: dst, kind: s.isDirectory() ? 'dir' : 'file', replaced: !!d, files: plan.files.length, bytes: plan.bytes, ms: Math.round(performance.now() - t0) });
    return { ok: true };
  } catch (err) {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (err instanceof Cancelled) {
      log.info('folders', 'Copy cancelled', { relPath: req.relPath, from: req.from, ms: Math.round(performance.now() - t0) });
      return { ok: false, cancelled: true, message: 'The copy was cancelled; nothing was changed.' };
    }
    const code = (err as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOSPC'
        ? `There isn't enough free space on the ${req.from === 'left' ? 'right' : 'left'} drive for the copy${plan ? ` (it needs about ${formatBytes(plan.bytes)})` : ''}. Nothing was changed.`
        : errorMessage(err);
    log.error('folders', 'Could not copy', { relPath: req.relPath, from: req.from, leftRoot: req.leftRoot, rightRoot: req.rightRoot, error: errorMessage(err) });
    return { ok: false, message };
  }
}

interface CopyPlan {
  /** Folders to create, relative to the copy's root ('' is the root), parents first. */
  dirs: { rel: string; mode: number; atime: Date; mtime: Date }[];
  /** Files and symbolic links to copy, relative to the copy's root ('' when copying one file). */
  files: { rel: string; size: number; link: boolean; atime: Date; mtime: Date }[];
  bytes: number;
  src: string;
}

/** Everything a copy will make, found before it starts, so progress can be shown as "x of y". */
async function planCopy(src: string, top: Stats, signal?: AbortSignal): Promise<CopyPlan> {
  const plan: CopyPlan = { dirs: [], files: [], bytes: 0, src };
  const visit = async (abs: string, rel: string, st: Stats): Promise<void> => {
    if (signal?.aborted) throw new Cancelled();
    if (st.isSymbolicLink()) plan.files.push({ rel, size: 0, link: true, atime: st.atime, mtime: st.mtime });
    else if (st.isFile()) {
      plan.files.push({ rel, size: st.size, link: false, atime: st.atime, mtime: st.mtime });
      plan.bytes += st.size;
    } else if (st.isDirectory()) {
      plan.dirs.push({ rel, mode: st.mode & 0o7777, atime: st.atime, mtime: st.mtime });
      const names = await readdir(abs);
      const stats = await Promise.all(names.map((n) => lstat(join(abs, n))));
      for (let i = 0; i < names.length; i++) await visit(join(abs, names[i]), rel ? `${rel}/${names[i]}` : names[i], stats[i]);
    } else throw new Error(`${abs} can't be copied: it's a device, socket or pipe, not a file or folder.`);
  };
  await visit(src, '', top);
  return plan;
}

/** Makes the copy at `dest` (which must not exist): folders, then files in parallel, then folder times. */
async function runCopy(plan: CopyPlan, dest: string, relPath: string, t0: number, options: CopyOptions): Promise<void> {
  const { signal, onProgress } = options;
  const at = (rel: string) => (rel ? join(dest, ...rel.split('/')) : dest);
  const progress: CopyProgress = { files: 0, totalFiles: plan.files.length, bytes: 0, totalBytes: plan.bytes, current: relPath, elapsedMs: 0 };
  let lastReport = 0;
  const report = (force = false) => {
    const now = performance.now();
    if (!onProgress || (!force && now - lastReport < PROGRESS_INTERVAL_MS)) return;
    lastReport = now;
    onProgress({ ...progress, elapsedMs: now - t0 });
  };
  const check = () => {
    if (signal?.aborted) throw new Cancelled();
  };

  // Folders first, parents before children (the plan lists them that way).
  for (const d of plan.dirs) {
    check();
    await mkdir(at(d.rel));
  }

  // Files and links, several at a time. The first failure stops new copies from starting.
  let failure: unknown;
  let next = 0;
  const worker = async () => {
    while (next < plan.files.length && failure === undefined) {
      const f = plan.files[next++];
      try {
        check();
        const from = f.rel ? join(plan.src, ...f.rel.split('/')) : plan.src;
        const to = at(f.rel);
        if (f.link) await symlink(await readlink(from), to);
        else {
          await copyFile(from, to, fsConstants.COPYFILE_FICLONE);
          await utimes(to, f.atime, f.mtime);
        }
        progress.files++;
        progress.bytes += f.size;
        progress.current = f.rel ? `${relPath}/${f.rel}` : relPath;
        report();
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COPY_PARALLEL, plan.files.length) }, worker));
  if (failure !== undefined) throw failure;

  // Folder times and permissions last: adding entries changes a folder's time, and a read-only
  // folder must stay writable until its contents are in.
  for (let i = plan.dirs.length - 1; i >= 0; i--) {
    check();
    const d = plan.dirs[i];
    await chmod(at(d.rel), d.mode);
    await utimes(at(d.rel), d.atime, d.mtime);
  }
  report(true);
}

/** Puts the finished copy in place of `dst`, putting the original back if that fails. */
async function swapIn(staging: string, dst: string, existing: Stats | null): Promise<void> {
  if (!existing) return rename(staging, dst);
  // A file (or link) replacing a file (or link): one step, so there's no moment without it.
  const stagedIsDir = (await lstat(staging)).isDirectory();
  if (!stagedIsDir && !existing.isDirectory()) return rename(staging, dst);
  const old = join(dirname(dst), `.${basename(dst)}.delta-old-${process.pid}-${Date.now()}`);
  await rename(dst, old);
  try {
    await rename(staging, dst);
  } catch (err) {
    // Put the original back (Windows refuses to rename a folder something has open).
    await rename(old, dst);
    throw err;
  }
  await rm(old, { recursive: true, force: true });
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Resolves `relPath` under `root`, refusing anything that would escape it. */
function inside(root: string, relPath: string): string {
  const base = resolve(root);
  const full = resolve(base, ...relPath.split('/'));
  if (!within(base, full)) throw new Error(`Refusing to touch a path outside ${root}.`);
  return full;
}

/** Whether `full` is `base` or inside it (also right for roots like "/", "E:\\" and shares). */
function within(base: string, full: string): boolean {
  const rel = relative(base, full);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Refuses a destination whose real location (with symbolic links resolved) is outside the
 * destination root: a link inside the tree (say `config -> ~/.ssh`) must not redirect a copy.
 */
async function insideReally(root: string, path: string): Promise<void> {
  const realRoot = await realpath(root);
  // The deepest part of the path that exists decides where a write would really land.
  let existing = dirname(path);
  for (;;) {
    try {
      const real = await realpath(existing);
      if (!within(realRoot, real)) throw new Error(`Refusing to copy through a link that leads outside ${root}.`);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const up = dirname(existing);
      if (up === existing) return;
      existing = up;
    }
  }
}
