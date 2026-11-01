import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { TOKEN_HEADER } from './security';

/**
 * A running server's details, written to Delta's settings folder (readable only by the user) so
 * a later launch on the same port can hand its paths over instead of failing with "port in use".
 */
export interface RuntimeInfo {
  pid: number;
  port: number;
  token: string;
}

export const runtimeFile = (dataDir: string, port: number) => join(dataDir, `server-${port}.json`);

export function writeRuntime(dataDir: string, info: RuntimeInfo): void {
  mkdirSync(dataDir, { recursive: true });
  const file = runtimeFile(dataDir, info.port);
  writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync's mode only applies when it creates the file.
}

export function readRuntime(dataDir: string, port: number): RuntimeInfo | null {
  try {
    const info = JSON.parse(readFileSync(runtimeFile(dataDir, port), 'utf8')) as RuntimeInfo;
    return typeof info.token === 'string' && info.port === port ? info : null;
  } catch {
    return null;
  }
}

/** Removes the file, unless another server has since replaced it. */
export function removeRuntime(dataDir: string, info: RuntimeInfo): void {
  if (readRuntime(dataDir, info.port)?.pid === info.pid) rmSync(runtimeFile(dataDir, info.port), { force: true });
}

/**
 * Asks the server described by `info` to open `paths` (absolute) and returns the launch id,
 * or null if no Delta server answers there (a stale file left by a crash).
 */
export function handOff(info: RuntimeInfo, paths: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ paths });
    const req = request(
      {
        host: '127.0.0.1',
        port: info.port,
        method: 'POST',
        path: '/api/handoff',
        timeout: timeoutMs,
        headers: {
          host: `127.0.0.1:${info.port}`,
          origin: `http://127.0.0.1:${info.port}`,
          'content-type': 'application/json',
          [TOKEN_HEADER]: info.token,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            const id = (JSON.parse(text) as { id?: unknown }).id;
            resolve(res.statusCode === 200 && typeof id === 'string' ? id : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

/** Whether a process with this id exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether the server on `port` is a Delta: it says so in a header, or (copies from before that
 * header) its page is titled Delta and never framed.
 */
export function answersAsDelta(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve(res.headers['x-delta'] === '1' || (res.headers['x-frame-options'] === 'DENY' && text.includes('Delta'))));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Stops the Delta running on `port` (any version), found through its runtime file and
 * confirmed by asking the port, so an unrelated process that reused the id is never touched.
 */
export async function stopRunning(dataDir: string, port: number): Promise<'stopped' | 'not-running' | 'not-delta'> {
  const info = readRuntime(dataDir, port);
  if (!info || !isAlive(info.pid)) {
    if (info) rmSync(runtimeFile(dataDir, port), { force: true }); // left by a crash
    return 'not-running';
  }
  if (!(await answersAsDelta(port))) return 'not-delta';
  process.kill(info.pid, 'SIGTERM');
  for (let i = 0; i < 50 && isAlive(info.pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(info.pid)) process.kill(info.pid, 'SIGKILL');
  rmSync(runtimeFile(dataDir, port), { force: true });
  return 'stopped';
}
