import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Header carrying the per-start token; browsers can't send custom headers cross-site without permission. */
export const TOKEN_HEADER = 'x-delta-token';

export interface Rejection {
  status: number;
  message: string;
}

/**
 * The API reads and writes files, so every request must come from Delta's own page:
 * - Host must be this server (blocks DNS rebinding, where a hostile domain resolves to 127.0.0.1).
 * - API calls must carry Delta's Origin (blocks other websites open in the same browser).
 * - API calls must carry the token issued to the page, and send JSON (a cross-site form can't
 *   set either without the browser first asking this server for permission, which it never grants).
 */
export function checkHost(req: IncomingMessage, port: number): Rejection | null {
  const host = req.headers.host ?? '';
  return allowedHosts(port).includes(host) ? null : { status: 403, message: 'Unexpected Host header.' };
}

export function checkApiRequest(req: IncomingMessage, port: number, token: string): Rejection | null {
  const hostProblem = checkHost(req, port);
  if (hostProblem) return hostProblem;
  const origin = req.headers.origin;
  if (!origin || !allowedHosts(port).some((h) => origin === `http://${h}`)) {
    return { status: 403, message: 'Requests must come from Delta’s own page.' };
  }
  if (!tokenMatches(req.headers[TOKEN_HEADER], token)) return { status: 403, message: 'Missing or invalid token.' };
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) return { status: 415, message: 'Requests must be JSON.' };
  return null;
}

/** For the event stream, which browsers open without custom headers: the token comes in the URL. */
export function checkStreamRequest(req: IncomingMessage, port: number, token: string, queryToken: string | null): Rejection | null {
  return checkHost(req, port) ?? (tokenMatches(queryToken ?? undefined, token) ? null : { status: 403, message: 'Missing or invalid token.' });
}

function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
