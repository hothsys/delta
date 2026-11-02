import { lstat, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LineEnding, ReadResult, SaveRequest, SaveResult, TextEncoding } from '../shared/api';
import { log } from './log';

/** A NUL byte in the first this-many bytes (outside UTF-16) marks a file as binary. */
export const BINARY_SNIFF_BYTES = 8000;

export async function readTextFile(path: string): Promise<ReadResult> {
  const t0 = performance.now();
  try {
    const [buf, info] = await Promise.all([readFile(path), stat(path)]);
    const decoded = decode(buf);
    if (!decoded) {
      log.info('files', 'Not a text file', { path, bytes: info.size });
      return { ok: false, path, reason: 'binary', message: binaryMessage(path) };
    }
    log.debug('files', 'Read', { path, bytes: info.size, encoding: decoded.encoding, ms: Math.round(performance.now() - t0) });
    return {
      ok: true,
      file: {
        path,
        name: basename(path),
        text: decoded.text,
        encoding: decoded.encoding,
        eol: dominantEol(decoded.text),
        size: info.size,
        mtimeMs: info.mtimeMs,
      },
    };
  } catch (err) {
    log.warn('files', 'Could not read', { path, error: errorMessage(err) });
    return { ok: false, path, reason: 'error', message: errorMessage(err) };
  }
}

export async function writeTextFile(req: SaveRequest): Promise<SaveResult> {
  const t0 = performance.now();
  try {
    // Latin-1 cannot represent characters typed beyond U+00FF; fall back to UTF-8 rather than lose them.
    const encoding: TextEncoding = req.encoding === 'latin1' && /[^\u0000-\u00ff]/.test(req.text) ? 'utf8' : req.encoding;
    await writeFileAtomic(req.path, encode(req.text, encoding));
    const info = await stat(req.path);
    log.info('files', 'Saved', {
      path: req.path,
      bytes: info.size,
      encoding,
      converted: encoding !== req.encoding ? `${req.encoding} to ${encoding}` : undefined,
      ms: Math.round(performance.now() - t0),
    });
    return { ok: true, path: req.path, name: basename(req.path), mtimeMs: info.mtimeMs, size: info.size, encoding };
  } catch (err) {
    log.error('files', 'Could not save', { path: req.path, error: errorMessage(err) });
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * Writes a file so that a crash, power cut or full disk mid-write can't destroy the original:
 * the new content goes to a temporary file beside it, which then replaces it in one step,
 * keeping its permissions. A file that is a symbolic link or has other hard links is written
 * in place instead, so the link survives.
 */
export async function writeFileAtomic(path: string, data: Buffer | string, mode = 0o666): Promise<void> {
  const existing = await lstat(path).catch(() => null);
  if (existing && (existing.isSymbolicLink() || existing.nlink > 1)) return writeFile(path, data);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.delta-tmp`);
  try {
    await writeFile(tmp, data, { mode: existing ? existing.mode & 0o7777 : mode });
    const handle = await open(tmp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export const binaryMessage = (path: string) => `${basename(path)} is a binary file. Delta compares text files only.`;

/**
 * Whether bytes look like a binary file: a NUL byte near the start, unless a UTF-16 byte-order
 * mark says the NULs are part of text. Shared by file opening and folder scans so both agree.
 */
export function looksBinary(buf: Buffer): boolean {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return false;
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Decodes file bytes, or returns null for binary content. Exported for tests. */
export function decode(buf: Buffer): { text: string; encoding: TextEncoding } | null {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom' };
  }
  // An odd number of bytes isn't valid UTF-16, and saving would drop the last one: refuse it.
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  if (utf16 && buf.length % 2 === 1) return null;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: swapBytes(buf.subarray(2)).toString('utf16le'), encoding: 'utf16be' };
  }
  if (looksBinary(buf)) return null;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8' };
  } catch {
    // Not valid UTF-8: Latin-1 maps every byte to a character, so the bytes round-trip unchanged.
    return { text: buf.toString('latin1'), encoding: 'latin1' };
  }
}

/** Inverse of `decode`. Exported for tests. */
export function encode(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), swapBytes(Buffer.from(text, 'utf16le'))]);
    case 'latin1':
      return Buffer.from(text, 'latin1');
    default:
      return Buffer.from(text, 'utf8');
  }
}

/** The most frequent line ending in `text`; `\n` when there are none. Exported for tests. */
export function dominantEol(text: string): LineEnding {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) lf++;
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    }
  }
  if (crlf > lf && crlf >= cr) return '\r\n';
  if (cr > lf && cr > crlf) return '\r';
  return '\n';
}

function swapBytes(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i];
    out[i] = out[i + 1];
    out[i + 1] = t;
  }
  return out;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
