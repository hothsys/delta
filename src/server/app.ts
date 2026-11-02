import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import type { ComparisonKind, CopyRequest, FolderCompareMode, LaunchRequest, SaveRequest } from '../shared/api';
import { listDirectory, locations } from '../node/browse';
import { readTextFile, writeTextFile } from '../node/files';
import { compareFolders, copyEntry } from '../node/folders';
import { launchRequest } from '../node/launch';
import { log, writeFromInterface } from '../node/log';
import { diagnostics, logInfo, logsFolder, setDebugLogging } from '../node/logging';
import { RecentStore } from '../node/recents';
import { noteOwnWrite, setWatched, type ChangeSubscriber } from '../node/watch';
import { openExternally } from './open';
import { checkApiRequest, checkHost, checkStreamRequest, type Rejection } from './security';

export interface ServerOptions {
  /** Per-start secret embedded in the page and required on every API call. */
  token: string;
  /** The built interface (index.html and assets). */
  staticDir: string;
  /** Where recent comparisons are kept (shared with the desktop app). */
  recentsFile: string;
  /** Delta's settings folder (the Debug Logging setting); defaults to the recents file's folder. */
  dataDir?: string;
  /** Delta's version, for Copy Diagnostic Info. */
  version?: string;
  /** Shows a folder in the file manager (Open Logs Folder); replaceable for tests. */
  openFolder?: (path: string) => void;
}

export interface DeltaServer extends Server {
  /**
   * Files a comparison to open and returns its id; a page opened at `/?launch=<id>` shows it.
   * Used for the paths given at startup and for later launches handed over to this server.
   */
  addLaunch(request: LaunchRequest): string;
}

/** Largest request body accepted (a save carries the whole file). */
const MAX_BODY_BYTES = 512 * 1024 * 1024;
/** Log entries accepted in one request from the page. */
const MAX_LOG_ENTRIES = 200;
/** Keeps the event stream open through proxies and sleep; also how often closed streams are noticed. */
const KEEPALIVE_MS = 25_000;
/** Launch ids are kept so reloading a launched page reopens its comparison; this many at most. */
const MAX_LAUNCHES = 50;

class BadRequest extends Error {}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new BadRequest(`"${name}" must be a string.`);
  return v;
};
const oneOf = <T extends string>(v: unknown, name: string, allowed: readonly T[]): T => {
  if (!allowed.includes(v as T)) throw new BadRequest(`"${name}" must be one of ${allowed.join(', ')}.`);
  return v as T;
};

/**
 * Delta's local web server: the interface plus a JSON API mirroring the desktop app's bridge
 * (`DeltaApi`), backed by the same system modules. It is meant to listen on 127.0.0.1 only.
 */
export function createDeltaServer(options: ServerOptions): DeltaServer {
  const recents = new RecentStore(options.recentsFile);
  const dataDir = options.dataDir ?? dirname(options.recentsFile);
  const openFolder = options.openFolder ?? openExternally;
  /** Event streams by client id: file watching and folder-comparison progress go through them. */
  const streams = new Map<string, ChangeSubscriber & { emit(event: string, data: unknown): void }>();
  /** One folder comparison per client: starting another (or Cancel) aborts the one running. */
  const comparisons = new Map<string, AbortController>();
  /** Comparisons to open, by launch id (oldest dropped first). */
  const launches = new Map<string, LaunchRequest>();
  const addLaunch = (request: LaunchRequest) => {
    const id = randomBytes(9).toString('hex');
    launches.set(id, request);
    if (launches.size > MAX_LAUNCHES) launches.delete(launches.keys().next().value!);
    return id;
  };
  const port = () => {
    const a = server.address();
    return typeof a === 'object' && a ? a.port : 0;
  };

  type Route = (body: Record<string, unknown>) => Promise<unknown>;
  const routes: Record<string, Route> = {
    '/api/read': (b) => readTextFile(str(b.path, 'path')),
    '/api/save': async (b) => {
      const req: SaveRequest = { path: str(b.path, 'path'), text: str(b.text, 'text'), encoding: oneOf(b.encoding, 'encoding', ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'latin1']) };
      const result = await writeTextFile(req);
      if (result.ok) noteOwnWrite(result.path, result.mtimeMs);
      return result;
    },
    '/api/path-kind': async (b) => {
      try {
        return (await stat(str(b.path, 'path'))).isDirectory() ? 'dir' : 'file';
      } catch {
        return null;
      }
    },
    '/api/compare-folders': async (b) => {
      const client = typeof b.client === 'string' ? b.client : '';
      comparisons.get(client)?.abort();
      const controller = new AbortController();
      comparisons.set(client, controller);
      try {
        return await compareFolders(str(b.left, 'left'), str(b.right, 'right'), oneOf<FolderCompareMode>(b.mode, 'mode', ['contents', 'size-date', 'date']), {
          signal: controller.signal,
          onProgress: (p) => streams.get(client)?.emit('folder-progress', p),
        });
      } finally {
        if (comparisons.get(client) === controller) comparisons.delete(client);
      }
    },
    '/api/compare-folders/cancel': async (b) => {
      comparisons.get(str(b.client, 'client'))?.abort();
      return { ok: true };
    },
    '/api/copy': (b) => {
      const req: CopyRequest = {
        leftRoot: str(b.leftRoot, 'leftRoot'),
        rightRoot: str(b.rightRoot, 'rightRoot'),
        relPath: str(b.relPath, 'relPath'),
        from: oneOf(b.from, 'from', ['left', 'right']),
      };
      return copyEntry(req);
    },
    '/api/recents/list': async () => ({ items: await recents.list(), homeDir: homedir() }),
    '/api/recents/remember': async (b) => {
      await recents.remember(oneOf<ComparisonKind>(b.kind, 'kind', ['files', 'folders']), str(b.left, 'left'), str(b.right, 'right'));
      return { ok: true };
    },
    '/api/recents/forget': async (b) => {
      await recents.forget(oneOf<ComparisonKind>(b.kind, 'kind', ['files', 'folders']), str(b.left, 'left'), str(b.right, 'right'));
      return { ok: true };
    },
    // What a page opened at /?launch=<id> should show; nothing for a plain visit.
    '/api/launch-request': async (b) => (typeof b.id === 'string' && launches.get(b.id)) || { kind: 'none' },
    // A later launch (`server.sh start a b`, the launchers) handing its paths to this server.
    '/api/handoff': async (b) => {
      if (!Array.isArray(b.paths) || !b.paths.every((p) => typeof p === 'string')) throw new BadRequest('"paths" must be a list of strings.');
      const request = launchRequest(b.paths as string[]);
      log.info('server', 'Another launch handed over', { kind: request.kind, paths: (b.paths as string[]).length });
      return { id: addLaunch(request) };
    },
    '/api/list-directory': (b) => listDirectory(str(b.path, 'path'), b.showHidden === true),
    '/api/locations': () => locations(),
    '/api/watch': async (b) => {
      const client = streams.get(str(b.client, 'client'));
      if (!client) return { ok: false, message: 'No event stream open for this client.' };
      const paths = Array.isArray(b.paths) ? b.paths.map((p, i) => str(p, `paths[${i}]`)) : [];
      setWatched(client, paths);
      return { ok: true };
    },
    // The page's log entries, sent in batches.
    '/api/log': async (b) => {
      if (Array.isArray(b.entries)) for (const e of b.entries.slice(0, MAX_LOG_ENTRIES)) writeFromInterface(e);
      return { ok: true };
    },
    '/api/log/info': async () => logInfo(),
    '/api/log/set-debug': (b) => setDebugLogging(dataDir, b.on === true),
    '/api/log/open-folder': async () => {
      // Only ever the server's own logs folder: the page can't name a path to open.
      const folder = logsFolder();
      if (!folder) return { ok: false, message: 'There is no log.' };
      openFolder(folder);
      return { ok: true };
    },
    '/api/log/diagnostics': async () => diagnostics('browser version', options.version ?? 'unknown', dataDir),
  };

  const server = createServer((req, res) => {
    const t0 = performance.now();
    const path = (req.url ?? '/').split('?')[0];
    res.on('finish', () => {
      // The page's own log batches would only log themselves.
      if (path !== '/api/log' && res.statusCode < 400) log.debug('server', `${req.method} ${path}`, { status: res.statusCode, ms: Math.round(performance.now() - t0) });
    });
    void handle(req, res).catch((err) => {
      if (err instanceof BadRequest) log.warn('server', 'Bad request', { path, error: err.message });
      else {
        log.error('server', `${req.method} ${path} failed`, err);
        console.error(`Delta: ${req.method} ${path} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
      if (!res.headersSent) send(res, err instanceof BadRequest ? 400 : 500, { ok: false, message: String(err?.message ?? err) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/events') return openStream(req, res, url);
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST') return reject(req, res, { status: 405, message: 'Use POST.' });
      const rejected = checkApiRequest(req, port(), options.token);
      if (rejected) return reject(req, res, rejected);
      const route = routes[url.pathname];
      if (!route) return reject(req, res, { status: 404, message: 'Unknown API route.' });
      const body = await readJson(req);
      return send(res, 200, await route(body));
    }
    const rejected = checkHost(req, port());
    if (rejected) return reject(req, res, rejected);
    return serveStatic(url.pathname, res);
  }

  /** Server-Sent Events: "file changed on disk" notifications for one browser tab. */
  function openStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const rejected = checkStreamRequest(req, port(), options.token, url.searchParams.get('token'));
    if (rejected) return reject(req, res, rejected);
    const id = url.searchParams.get('client');
    if (!id) return reject(req, res, { status: 400, message: 'Missing client id.' });
    log.debug('server', 'Page connected', { client: id.slice(0, 8), pages: streams.size + 1 });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const closeListeners: (() => void)[] = [];
    let closed = false;
    const emit = (event: string, data: unknown) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const subscriber = {
      send: (path: string) => emit('file-changed', path),
      emit,
      closed: () => closed,
      onClose: (listener: () => void) => closeListeners.push(listener),
    };
    // A reconnecting tab replaces its previous stream.
    streams.set(id, subscriber);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    req.on('close', () => {
      closed = true;
      clearInterval(keepalive);
      // A tab that went away doesn't need its comparison finished; a stream replaced by the
      // tab reconnecting isn't the tab going away.
      if (streams.get(id) === subscriber) {
        comparisons.get(id)?.abort();
        streams.delete(id);
        log.debug('server', 'Page disconnected', { client: id.slice(0, 8), pages: streams.size });
      }
      for (const l of closeListeners) l();
    });
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const root = resolve(options.staticDir);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    } catch {
      return send(res, 404, { ok: false, message: 'Not found.' }); // a malformed address
    }
    const file = resolve(root, '.' + normalize(decoded));
    if (file !== root && !file.startsWith(root + sep)) return send(res, 404, { ok: false, message: 'Not found.' });
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      return send(res, 404, { ok: false, message: 'Not found.' });
    }
    if (file === join(root, 'index.html')) {
      // Hand the page its token; other sites can't read this response.
      data = Buffer.from(data.toString('utf8').replace('<head>', `<head>\n    <meta name="delta-token" content="${options.token}" />`));
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(data);
  }

  return Object.assign(server, { addLaunch });
}

const SECURITY_HEADERS = {
  // Lets a later launch recognise this as a Delta server (see `answersAsDelta`).
  'X-Delta': '1',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(data);
}

/** Refuses a request, logging why: a refusal can mean something other than Delta's page tried. */
function reject(req: IncomingMessage, res: ServerResponse, r: Rejection): void {
  log.warn('server', 'Refused a request', { method: req.method, path: (req.url ?? '').split('?')[0], status: r.status, reason: r.message, origin: req.headers.origin, host: req.headers.host });
  send(res, r.status, { ok: false, message: r.message });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new BadRequest('Body must be a JSON object.');
  }
}
