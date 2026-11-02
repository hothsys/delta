import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeLog } from '../../src/node/log';
import { startLogging } from '../../src/node/logging';
import { createDeltaServer } from '../../src/server/app';
import { TOKEN_HEADER } from '../../src/server/security';

const TOKEN = 'log-test-token';
const base = mkdtempSync(join(tmpdir(), 'delta-server-log-'));
const logDir = join(base, 'logs');
const dataDir = join(base, 'settings');
mkdirSync(join(base, 'static'));
writeFileSync(join(base, 'static', 'index.html'), '<!doctype html><html><head></head></html>');
const opened: string[] = [];

const server = createDeltaServer({
  token: TOKEN,
  staticDir: join(base, 'static'),
  recentsFile: join(dataDir, 'recents.json'),
  dataDir,
  version: '9.9.9',
  openFolder: (path) => opened.push(path),
});
let port = 0;

beforeAll(async () => {
  startLogging({ dir: logDir, name: 'web.log', dataDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  closeLog();
  server.closeAllConnections();
  server.close();
});

function call(path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const logText = () => readFileSync(join(logDir, 'web.log'), 'utf8');

describe('logging in the browser version', () => {
  it("writes the page's entries", async () => {
    const r = await call('/api/log', { entries: [{ level: 'info', area: 'files', message: 'Comparing files', fields: { left: '/a.txt' } }] });
    expect(r.status).toBe(200);
    expect(logText()).toContain('INFO  ui.files Comparing files  left=/a.txt');
  });

  it('only from Delta\'s own page', async () => {
    const r = await call('/api/log', { entries: [{ level: 'error', area: 'x', message: 'forged' }] }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(logText()).not.toContain('forged');
    expect(logText()).toMatch(/WARN  server   Refused a request .*status=403/);
  });

  it('turns debug logging on and off, logging requests while on', async () => {
    expect((await call('/api/log/info')).json).toMatchObject({ level: 'info', file: join(logDir, 'web.log') });
    expect((await call('/api/log/set-debug', { on: true })).json).toMatchObject({ level: 'debug', from: 'setting' });
    await call('/api/locations');
    expect(logText()).toMatch(/DEBUG server   POST \/api\/locations  status=200 ms=\d+/);
    expect((await call('/api/log/set-debug', { on: false })).json.level).toBe('info');
    expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))).toEqual({});
  });

  it('opens only its own logs folder', async () => {
    await call('/api/log/open-folder', { path: '/etc' });
    expect(opened).toEqual([logDir]);
  });

  it('gives diagnostic info with the latest entries', async () => {
    const text: string = (await call('/api/log/diagnostics')).json;
    expect(text).toContain('Delta 9.9.9 (browser version)');
    expect(text).toContain(`Log file: ${join(logDir, 'web.log')}`);
    expect(text).toContain('Latest log entries:');
    expect(text).toContain('ui.files Comparing files');
  });
});
