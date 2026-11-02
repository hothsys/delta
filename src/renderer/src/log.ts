import type { LogFields, LogLevel } from '../../shared/api';
import { api } from './platform';

/**
 * The interface's side of Delta's log: entries go to the host (the desktop app's main process
 * or the browser version's server), which writes them to the log file with `ui.` before the
 * area. Entries below the current level aren't sent at all.
 *
 * Log what the user did and what came of it: paths, counts, timings. Never file contents or
 * edited text, and nothing per keystroke or scroll.
 */

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let level: LogLevel = 'info';

/** Follows the host's level (loaded at start, and changed by Help > Debug Logging). */
export function setLogLevel(next: LogLevel): void {
  level = next;
}

function write(at: LogLevel, area: string, message: string, fields?: LogFields, err?: unknown): void {
  if (RANK[at] > RANK[level]) return;
  const error = err instanceof Error ? err : undefined;
  const detail = err !== undefined && !error ? String(err) : error?.message;
  api.log({ level: at, area, message, fields: detail ? { ...fields, error: detail } : fields, stack: error?.stack });
}

export const log = {
  error: (area: string, message: string, fields?: LogFields, err?: unknown) => write('error', area, message, fields, err),
  warn: (area: string, message: string, fields?: LogFields, err?: unknown) => write('warn', area, message, fields, err),
  info: (area: string, message: string, fields?: LogFields) => write('info', area, message, fields),
  debug: (area: string, message: string, fields?: LogFields) => write('debug', area, message, fields),
};
