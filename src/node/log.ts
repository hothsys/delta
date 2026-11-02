import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_LEVELS, type LogEntry, type LogFields, type LogLevel, type LogLevelSource } from '../shared/api';

/**
 * Delta's log: one file per host (`desktop.log` or `web.log`) in a logs folder, readable only
 * by the user. Each entry is one line, so the file reads well and greps well:
 *
 *   2026-11-01T16:04:05.123-05:00 INFO  files    Saved  path="/a b/c.txt" bytes=1204 ms=3
 *
 * Errors carry their stack on the indented lines after. When the file passes `maxBytes` it
 * becomes `.1` (the older `.1` becomes `.2`, and so on), keeping `keep` old files at most.
 *
 * Writes are synchronous: entries are few (user actions, not keystrokes), and nothing written
 * before a crash is lost. Until `initLog` runs (in unit tests, say) logging does nothing.
 *
 * Never log file contents or edited text; paths, sizes, counts and timings only.
 */

export interface LogOptions {
  dir: string;
  /** File name inside `dir`, e.g. `web.log`. */
  name: string;
  level: LogLevel;
  /** Rotate once the file would pass this size. */
  maxBytes?: number;
  /** Rotated files to keep (`name.1` … `name.N`). */
  keep?: number;
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP = 3;
/** Longest message and field value written; anything longer is cut, so one entry can't flood the file. */
const MAX_TEXT = 2000;

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

interface State {
  file: string;
  level: LogLevel;
  maxBytes: number;
  keep: number;
  size: number;
}

let state: State | null = null;

export function initLog(options: LogOptions): void {
  mkdirSync(options.dir, { recursive: true });
  const file = join(options.dir, options.name);
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    // A first run: the file is created on the first entry.
  }
  state = {
    file,
    level: options.level,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    keep: options.keep ?? DEFAULT_KEEP,
    size,
  };
}

/** Stops logging (tests). */
export function closeLog(): void {
  state = null;
}

export const logFile = (): string | null => state?.file ?? null;
export const logLevel = (): LogLevel => state?.level ?? 'info';

export function setLogLevel(level: LogLevel): void {
  if (state) state.level = level;
}

export const isLogLevel = (v: unknown): v is LogLevel => typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);

/** Whether an entry at `level` would be written. */
export const logs = (level: LogLevel): boolean => !!state && RANK[level] <= RANK[state.level];

export function write(level: LogLevel, area: string, message: string, fields?: LogFields | Error, err?: unknown): void {
  if (!state || !logs(level)) return;
  if (fields instanceof Error) [fields, err] = [undefined, fields];
  const line = formatEntry(new Date(), level, area, message, fields, err);
  const bytes = Buffer.byteLength(line);
  try {
    if (state.size > 0 && state.size + bytes > state.maxBytes) rotate(state);
    appendFileSync(state.file, line, { mode: 0o600 });
    if (state.size === 0) chmodSync(state.file, 0o600); // the mode only applies when appending creates it
    state.size += bytes;
  } catch {
    // A full disk or a folder that went away must never break Delta; the entry is dropped.
  }
}

export const log = {
  error: (area: string, message: string, fields?: LogFields | Error, err?: unknown) => write('error', area, message, fields, err),
  warn: (area: string, message: string, fields?: LogFields | Error, err?: unknown) => write('warn', area, message, fields, err),
  info: (area: string, message: string, fields?: LogFields) => write('info', area, message, fields),
  debug: (area: string, message: string, fields?: LogFields) => write('debug', area, message, fields),
};

/** Writes an entry sent by the interface, checked and trimmed: it arrives over IPC or HTTP. */
export function writeFromInterface(entry: unknown): void {
  if (!entry || typeof entry !== 'object') return;
  const e = entry as Partial<LogEntry>;
  if (!isLogLevel(e.level) || typeof e.message !== 'string') return;
  const area = typeof e.area === 'string' && /^[\w.-]{1,20}$/.test(e.area) ? e.area : 'ui';
  const fields: LogFields = {};
  if (e.fields && typeof e.fields === 'object') {
    for (const [k, v] of Object.entries(e.fields).slice(0, 20)) {
      if (/^\w{1,40}$/.test(k) && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) fields[k] = v;
    }
  }
  write(e.level, `ui.${area}`, e.message, fields, typeof e.stack === 'string' ? { stack: e.stack } : undefined);
}

function rotate(s: State): void {
  rmSync(`${s.file}.${s.keep}`, { force: true });
  for (let i = s.keep - 1; i >= 1; i--) {
    try {
      renameSync(`${s.file}.${i}`, `${s.file}.${i + 1}`);
    } catch {
      // Not that many old files yet.
    }
  }
  renameSync(s.file, `${s.file}.1`);
  s.size = 0;
}

/** One entry as written: a line, plus indented stack lines for errors. Exported for tests. */
export function formatEntry(at: Date, level: LogLevel, area: string, message: string, fields?: LogFields, err?: unknown): string {
  let line = `${timestamp(at)} ${level.toUpperCase().padEnd(5)} ${area.padEnd(8)} ${oneLine(message)}`;
  const parts = Object.entries(fields ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`);
  const error = describeError(err);
  if (error.message) parts.push(`error=${formatValue(error.message)}`);
  if (parts.length) line += `  ${parts.join(' ')}`;
  line += '\n';
  if (error.stack) line += error.stack.slice(0, MAX_TEXT * 4).split('\n').filter(Boolean).map((l) => `    ${l.trim()}\n`).join('');
  return line;
}

function describeError(err: unknown): { message?: string; stack?: string } {
  if (err === undefined || err === null) return {};
  if (err instanceof Error) {
    // The stack starts with the message already (except in Safari, which sends stacks only).
    const stack = err.stack?.split('\n').slice(err.stack.startsWith(`${err.name}`) ? 1 : 0).join('\n');
    return { message: `${err.name === 'Error' ? '' : `${err.name}: `}${err.message}`, stack };
  }
  if (typeof err === 'object' && 'stack' in err && typeof err.stack === 'string') return { stack: err.stack };
  return { message: String(err) };
}

function formatValue(v: string | number | boolean | null | undefined): string {
  if (typeof v !== 'string') return String(v);
  const s = oneLine(v);
  return /^[\w./\\:@+-]+$/.test(s) ? s : JSON.stringify(s);
}

function oneLine(s: string): string {
  const cut = s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
  return cut.replace(/\r\n|\r|\n/g, '⏎');
}

/** Local time with its offset, so entries match the clock the user remembers. */
function timestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

/** The last `count` lines of the log, for Copy Diagnostic Info. */
export function recentLines(count: number): string[] {
  if (!state) return [];
  const want = 64 * 1024;
  let fd: number | undefined;
  try {
    fd = openSync(state.file, 'r');
    const size = statSync(state.file).size;
    const start = Math.max(0, size - want);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (start > 0) lines.shift(); // probably cut mid-line
    return lines.slice(-count);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Where the log level comes from, strongest first: the command line, the environment, the saved setting. */
export function resolveLogLevel(sources: { cli?: string; env?: string; saved?: unknown }): { level: LogLevel; from: LogLevelSource } {
  if (isLogLevel(sources.cli)) return { level: sources.cli, from: 'command line' };
  const env = sources.env?.toLowerCase();
  if (isLogLevel(env)) return { level: env, from: 'DELTA_LOG_LEVEL' };
  if (isLogLevel(sources.saved)) return { level: sources.saved, from: 'setting' };
  return { level: 'info', from: 'default' };
}

/**
 * Takes `--log-level <level>` or `--log-level=<level>` out of command-line arguments, so the
 * rest can be read as paths.
 */
export function takeLogLevel(args: readonly string[]): { level?: string; rest: string[] } {
  let level: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i));
      break;
    }
    if (a === '--log-level') level = args[++i];
    else if (a.startsWith('--log-level=')) level = a.slice('--log-level='.length);
    else rest.push(a);
  }
  return { level, rest };
}
