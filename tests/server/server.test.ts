import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeltaServer } from '../../src/server/app';
import { TOKEN_HEADER } from '../../src/server/security';

const TOKEN = 'test-token-0123456789abcdef';
const base = mkdtempSync(join(tmpdir(), 'delta-server-'));
const staticDir = join(base, 'static');
const files = join(base, 'files');
mkdirSync(staticDir);
mkdirSync(join(staticDir, 'assets'));
mkdirSync(join(files, 'L'), { recursive: true });
mkdirSync(join(files, 'R'), { recursive: true });
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><head><title>Delta</title></head><body></body></html>');
writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
writeFileSync(join(base, 'secret.txt'), 'outside the static folder');
writeFileSync(join(files, 'L', 'a.txt'), 'left\n');
writeFileSync(join(files, 'R', 'a.txt'), 'right\n');

const server = createDeltaServer({
  token: TOKEN,
  staticDir,
  recentsFile: join(base, 'recents.json'),
});
let port = 0;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: () => any;
}

/** Raw HTTP (not fetch), so tests can send any Host, Origin or path. */
function http(options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: { host: `127.0.0.1:${port}`, ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** An API call exactly as Delta's page would make it. */
function api(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return http({
    method: 'POST',
    path,
    headers: { origin: `http://127.0.0.1:${port}`, [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('static files', () => {
  it('serves the page with its token embedded, at 127.0.0.1 and at localhost, plus assets', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const page = await http({ path: '/', headers: { host } });
      expect(page.status).toBe(200);
      expect(page.text).toContain(`<meta name="delta-token" content="${TOKEN}" />`);
      expect(page.headers['x-frame-options']).toBe('DENY');
    }
    const js = await http({ path: '/assets/app.js' });
    expect(js.headers['content-type']).toContain('text/javascript');
  });

  it('never serves files outside the interface folder', async () => {
    expect((await http({ path: '/%2e%2e/secret.txt' })).status).toBe(404);
    expect((await http({ path: '/../secret.txt' })).status).toBe(404);
    expect((await http({ path: '/missing.js' })).status).toBe(404);
    expect((await http({ path: '/%E0%A4%A' })).status).toBe(404);
  });
});

describe('security', () => {
  it('rejects requests addressed to another host (DNS rebinding)', async () => {
    expect((await http({ path: '/', headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await api('/api/locations', {}, { host: `evil.example:${port}` })).status).toBe(403);
  });

  it('rejects API calls from other origins, or with no origin', async () => {
    expect((await api('/api/locations', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('/api/locations', {}, { origin: `http://127.0.0.1:${port + 1}` })).status).toBe(403);
    const noOrigin = await http({ method: 'POST', path: '/api/locations', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }, body: '{}' });
    expect(noOrigin.status).toBe(403);
  });

  it('rejects API calls without the right token', async () => {
    expect((await api('/api/locations', {}, { [TOKEN_HEADER]: 'wrong' })).status).toBe(403);
    const noToken = await http({ method: 'POST', path: '/api/locations', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{}' });
    expect(noToken.status).toBe(403);
  });

  it('rejects form posts (which a hostile page could send) and GETs on the API', async () => {
    const form = await api('/api/save', {}, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    expect((await http({ path: '/api/locations' })).status).toBe(405);
  });

  it('accepts localhost as well as 127.0.0.1', async () => {
    const r = await api('/api/locations', {}, { host: `localhost:${port}`, origin: `http://localhost:${port}` });
    expect(r.status).toBe(200);
  });

  it('validates request bodies', async () => {
    expect((await api('/api/read', { path: 42 })).status).toBe(400);
    expect((await api('/api/save', { path: join(base, 'x.txt'), text: 'x', encoding: 'ebcdic' })).status).toBe(400);
    expect((await api('/api/nope')).status).toBe(404);
  });
});

describe('API routes', () => {
  it('reads and saves files', async () => {
    const read = (await api('/api/read', { path: join(files, 'L', 'a.txt') })).json();
    expect(read).toMatchObject({ ok: true, file: { name: 'a.txt', text: 'left\n', encoding: 'utf8' } });
    const target = join(files, 'saved.txt');
    const saved = (await api('/api/save', { path: target, text: 'café\n', encoding: 'latin1' })).json();
    expect(saved).toMatchObject({ ok: true, encoding: 'latin1' });
    expect(readFileSync(target)).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  });

  it('reports path kinds', async () => {
    expect((await api('/api/path-kind', { path: files })).json()).toBe('dir');
    expect((await api('/api/path-kind', { path: join(files, 'L', 'a.txt') })).json()).toBe('file');
    expect((await api('/api/path-kind', { path: join(files, 'nope') })).json()).toBeNull();
  });

  it('compares folders and copies entries', async () => {
    const cmp = (await api('/api/compare-folders', { left: join(files, 'L'), right: join(files, 'R'), mode: 'contents' })).json();
    expect(cmp.ok && cmp.root.children.map((c: any) => [c.name, c.status])).toEqual([['a.txt', 'different']]);
    const copied = (await api('/api/copy', { leftRoot: join(files, 'L'), rightRoot: join(files, 'R'), relPath: 'a.txt', from: 'left' })).json();
    expect(copied).toEqual({ ok: true });
    expect(readFileSync(join(files, 'R', 'a.txt'), 'utf8')).toBe('left\n');
    const escape = (await api('/api/copy', { leftRoot: join(files, 'L'), rightRoot: join(files, 'R'), relPath: '../secret', from: 'left' })).json();
    expect(escape.ok).toBe(false);
  });

  it('keeps recent comparisons', async () => {
    await api('/api/recents/remember', { kind: 'folders', left: join(files, 'L'), right: join(files, 'R') });
    const list = (await api('/api/recents/list')).json();
    expect(list.items.map((x: any) => [x.kind, x.left.state])).toEqual([['folders', 'available']]);
    await api('/api/recents/forget', { kind: 'folders', left: join(files, 'L'), right: join(files, 'R') });
    expect((await api('/api/recents/list')).json().items).toEqual([]);
  });

  it('lists folders, locations and the launch request', async () => {
    const dir = (await api('/api/list-directory', { path: files })).json();
    expect(dir.ok && dir.entries.map((e: any) => e.name)).toEqual(['L', 'R', 'saved.txt']);
    const locs = (await api('/api/locations')).json();
    expect(locs[0].kind).toBe('home');
  });

  it('opens launched comparisons by id, and hands later launches to this server', async () => {
    const id = server.addLaunch({ kind: 'folders', left: join(files, 'L'), right: join(files, 'R') });
    expect((await api('/api/launch-request', { id })).json()).toMatchObject({ kind: 'folders' });
    // Ids stay valid, so reloading the page reopens the comparison.
    expect((await api('/api/launch-request', { id })).json()).toMatchObject({ kind: 'folders' });
    // A plain visit, or an unknown id, opens nothing.
    expect((await api('/api/launch-request')).json()).toEqual({ kind: 'none' });
    expect((await api('/api/launch-request', { id: 'nope' })).json()).toEqual({ kind: 'none' });
    // A later launch hands its paths over and gets an id for them.
    const handed = (await api('/api/handoff', { paths: [join(files, 'L', 'a.txt'), join(files, 'R', 'a.txt')] })).json();
    expect((await api('/api/launch-request', { id: handed.id })).json()).toEqual({ kind: 'files', left: join(files, 'L', 'a.txt'), right: join(files, 'R', 'a.txt') });
    expect((await api('/api/handoff', { paths: 'x' })).status).toBe(400);
    // Handing over needs the token like every other call.
    expect((await api('/api/handoff', { paths: [] }, { [TOKEN_HEADER]: 'wrong' })).status).toBe(403);
  });
});

describe('change events', () => {
  it('streams outside changes to watched files, but not Delta’s own saves', async () => {
    const watched = join(files, 'watched.txt');
    writeFileSync(watched, 'one\n');
    const events: string[] = [];
    const stream = request({ host: '127.0.0.1', port, path: `/api/events?client=tab1&token=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } });
    const opened = new Promise<void>((resolve) => {
      stream.on('response', (res) => {
        expect(res.statusCode).toBe(200);
        res.on('data', (c: Buffer) => {
          for (const m of c.toString().matchAll(/event: file-changed\ndata: (.*)\n/g)) events.push(JSON.parse(m[1]));
        });
        resolve();
      });
    });
    stream.end();
    await opened;
    expect((await api('/api/watch', { client: 'tab1', paths: [watched] })).json()).toEqual({ ok: true });

    // Delta's own save: no event.
    await api('/api/save', { path: watched, text: 'two\n', encoding: 'utf8' });
    await new Promise((r) => setTimeout(r, 2500));
    expect(events).toEqual([]);

    // An outside change: one event.
    appendFileSync(watched, 'outside\n');
    await new Promise((r) => setTimeout(r, 2500));
    expect(events).toEqual([watched]);
    stream.destroy();
  }, 10_000);

  it('requires the token to open a stream', async () => {
    expect((await http({ path: '/api/events?client=x' })).status).toBe(403);
    expect((await http({ path: `/api/events?client=x&token=wrong` })).status).toBe(403);
    expect(existsSync(join(base, 'recents.json'))).toBe(true);
  });
});
