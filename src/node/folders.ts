import type { Dirent } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, readlink, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  TIMESTAMP_TOLERANCE_MS,
  type CopyRequest,
  type CopyResult,
  type EntryInfo,
  type EntryStatus,
  type FolderCompareMode,
  type FolderCompareResult,
  type FolderNode,
  type FolderProgress,
} from '../shared/api';
import { BINARY_SNIFF_BYTES, errorMessage, looksBinary } from './files';

/** Never interesting in a comparison and often huge or noisy. */
const IGNORED_NAMES = new Set(['.git', '.DS_Store']);
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
  try {
    // The roots themselves may be links to folders (entries inside are never followed).
    const [l, r] = await Promise.all([rootInfo(leftRoot), rootInfo(rightRoot)]);
    if (l?.kind !== 'dir') return { ok: false, message: `${leftRoot} is not a folder.` };
    if (r?.kind !== 'dir') return { ok: false, message: `${rightRoot} is not a folder.` };
    const root = await compareDir(ctx, '', '', leftRoot, rightRoot, l, r);
    const elapsedMs = performance.now() - t0;
    // Always finish with the final totals, however recently the last throttled report went out.
    options.onProgress?.({ ...progress, current: '', elapsedMs });
    return { ok: true, root, leftRoot, rightRoot, elapsedMs };
  } catch (err) {
    if (err instanceof Cancelled) return { ok: false, cancelled: true, message: 'The comparison was cancelled.' };
    return { ok: false, message: errorMessage(err) };
  }
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

/**
 * Copies a file or folder from one tree to the same place in the other, replacing what is
 * there (a folder onto a folder merges: files only on the destination side are kept).
 * Symbolic links are copied as links, unchanged.
 */
export async function copyEntry(req: CopyRequest): Promise<CopyResult> {
  try {
    const srcRoot = req.from === 'left' ? req.leftRoot : req.rightRoot;
    const dstRoot = req.from === 'left' ? req.rightRoot : req.leftRoot;
    const src = inside(srcRoot, req.relPath);
    const dst = inside(dstRoot, req.relPath);
    await insideReally(dstRoot, dst);
    const [s, d] = await Promise.all([info(src), info(dst)]);
    if (!s) return { ok: false, message: `${req.relPath} no longer exists on the ${req.from}.` };
    // A file cannot overwrite a folder (or the reverse), and a link at the destination is
    // replaced, not written through. The renderer has confirmed the replacement.
    if (d && (d.kind !== s.kind || d.link !== undefined)) await rm(dst, { recursive: true, force: true });
    await mkdir(dirname(dst), { recursive: true });
    await cp(src, dst, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
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
