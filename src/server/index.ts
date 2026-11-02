import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchRequest } from '../node/launch';
import { log } from '../node/log';
import { startLogging } from '../node/logging';
import { createDeltaServer } from './app';
import { openExternally } from './open';
import { answersAsDelta, handOff, isAlive, readRuntime, removeRuntime, stopRunning, writeRuntime } from './runtime';

/** Default port (Foto Nerve Shatter uses 5900). Override with --port. */
const DEFAULT_PORT = 5910;

const USAGE = 'node dist/app/server/index.js [--port N] [--open] [--data-dir DIR] [--log-dir DIR] [--log-level LEVEL] [--stop | --restart] [--] [left right]';

/** The built server is dist/app/server/index.js; the project folder is three up. */
const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, '../../..');

/**
 * Starts Delta's browser version:
 * `node dist/app/server/index.js [--port N] [--open] [--data-dir DIR] [--log-dir DIR] [--log-level LEVEL] [--stop | --restart] [--] [left right]`.
 * Two files or two folders after the options open that comparison straight away (`--` ends
 * the options, for paths that start with "-"). `--data-dir` overrides the settings folder
 * (shared with the desktop app by default), e.g. for tests. `--stop` stops the Delta running
 * on the port; `--restart` stops it and starts this one (after an update, say).
 *
 * The log is `web.log` in Delta's logs folder, beside the desktop app's (`--log-dir` to change). `--log-level`
 * (error, warn, info or debug) overrides the DELTA_LOG_LEVEL variable and the Help menu's
 * Debug Logging setting.
 *
 * One copy per port: if Delta is already running there, the paths are handed to it (and with
 * `--open`, the browser opens on it) instead of failing with "port in use".
 */
async function main(): Promise<void> {
  const { port, dataDir, logDir, logLevel, open, paths, action } = parseArgs(process.argv.slice(2));
  // localhost, like Foto Nerve Shatter (the server itself listens on 127.0.0.1 only).
  const base = `http://localhost:${port}`;
  const version = readVersion();
  const logging = startLogging({ dir: logDir, name: 'web.log', dataDir, cli: logLevel });
  if (logLevel !== undefined && logging.level !== logLevel) console.error(`Unknown log level "${logLevel}"; use error, warn, info or debug. Logging at ${logging.level}.`);
  // Logged without changing what happens next (Node prints the error and exits).
  process.on('uncaughtExceptionMonitor', (err, origin) => log.error('server', `Uncaught ${origin === 'unhandledRejection' ? 'rejection' : 'exception'}`, err));

  if (action !== 'start') {
    const result = await stopRunning(dataDir, port);
    log.info('server', `--${action}`, { port, result });
    if (result === 'stopped') console.log(`Stopped the Delta running on port ${port}.`);
    else if (result === 'not-delta') {
      console.error(`Something other than Delta is using port ${port}; it wasn't touched. Try another: --port <number>`);
      process.exit(1);
    } else if (action === 'stop') console.log(`Delta isn't running on port ${port}.`);
    if (action === 'stop') return;
  }
  const pageUrl = (id: string | null) => (id ? `${base}/?launch=${id}` : base);

  /** Hands the paths to a Delta already running on the port; false if none answers. */
  const tryHandOff = async () => {
    const running = readRuntime(dataDir, port);
    const id = running && (await handOff(running, paths));
    if (!id) return false;
    log.info('server', 'Handed over to the Delta already running', { port, pid: running.pid, paths: paths.length });
    const url = pageUrl(paths.length ? id : null);
    console.log(paths.length ? `Delta is already running; opening the comparison at ${url}` : `Delta is already running at ${base}`);
    if (open) openBrowser(url);
    return true;
  };
  // A runtime file nobody answers for was left by a crash: start afresh.
  if (await tryHandOff()) return;

  const info = { pid: process.pid, port, token: randomBytes(24).toString('hex') };
  const server = createDeltaServer({
    token: info.token,
    staticDir: join(here, '../renderer'),
    recentsFile: join(dataDir, 'recent-comparisons.json'),
    dataDir,
    version,
  });

  server.on('error', async (err: NodeJS.ErrnoException) => {
    // Another copy may have started at the same moment and won the port: hand over to it.
    if (err.code === 'EADDRINUSE' && (await tryHandOff())) process.exit(0);
    if (err.code !== 'EADDRINUSE') {
      log.error('server', 'The server failed', err);
      console.error(err.message);
    } else {
      // A Delta that won't take the hand-over is one started before an update.
      const running = readRuntime(dataDir, port);
      const olderDelta = running && isAlive(running.pid) && (await answersAsDelta(port));
      log.error('server', olderDelta ? 'An older Delta is running on the port' : 'The port is in use by another program', { port });
      console.error(
        olderDelta
          ? `A Delta started before an update is still running on port ${port}. Restart it with --restart (./start.command --restart, start.cmd --restart or npm run web -- --restart).`
          : `Port ${port} is already in use by another program. Try another: --port <number>`,
      );
    }
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    writeRuntime(dataDir, info);
    const url = pageUrl(paths.length ? server.addLaunch(launchRequest(paths)) : null);
    log.info('server', 'Delta started', {
      version,
      node: process.versions.node,
      system: `${process.platform} ${process.arch}`,
      url: base,
      pid: process.pid,
      paths: paths.length,
      level: logging.level,
      levelFrom: logging.from,
      log: logging.file,
    });
    console.log(`Delta is running at ${url}  (Ctrl+C to stop)`);
    if (logging.file) console.log(`Log: ${logging.file}${logging.level === 'debug' ? '  (debug logging is on)' : ''}`);
    if (open) openBrowser(url);
  });
  const stop = (signal: NodeJS.Signals) => {
    log.info('server', 'Delta stopped', { signal });
    removeRuntime(dataDir, info);
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
}

/** The version in package.json (the server always runs from the project folder). */
function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Reads the command line, exiting with a clear message (not a stack trace) on bad input. */
function parseArgs(args: string[]): {
  port: number;
  dataDir: string;
  logDir: string;
  logLevel?: string;
  open: boolean;
  paths: string[];
  action: 'start' | 'stop' | 'restart';
} {
  const fail = (message: string): never => {
    console.error(`${message}\nUsage: ${USAGE}`);
    process.exit(2);
  };
  let action: 'start' | 'stop' | 'restart' = 'start';
  let port = DEFAULT_PORT;
  let dataDir = appDataDir();
  let logDir = logsDir();
  let logLevel: string | undefined;
  let open = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].startsWith('--') ? args[i].split(/=(.*)/s, 2) : [args[i], undefined];
    const value = () => inline ?? (i + 1 < args.length ? args[++i] : fail(`${flag} needs a value.`));
    if (flag === '--') {
      paths.push(...args.slice(i + 1));
      break;
    } else if (flag === '--port') {
      const raw = value();
      port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port must be a number from 1 to 65535, not "${raw}".`);
    } else if (flag === '--data-dir') dataDir = value();
    else if (flag === '--log-dir') logDir = resolve(value());
    else if (flag === '--log-level') logLevel = value().toLowerCase();
    else if (flag === '--open') open = true;
    else if (flag === '--stop') action = 'stop';
    else if (flag === '--restart') action = 'restart';
    else if (flag.startsWith('--')) fail(`Unknown option ${flag}.`);
    else paths.push(args[i]);
  }
  // Resolved here: the running copy may have a different working directory.
  return { port, dataDir, logDir, logLevel, open, paths: paths.map((p) => resolve(p)), action };
}

/** The same settings folder the desktop app uses, so both share recent comparisons. */
function appDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Delta');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Delta');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Delta');
}

/**
 * Delta's logs folder, shared with the desktop app (the folder Electron's `app.getPath('logs')`
 * gives it) and web/start.mjs, so every log is in one place.
 */
function logsDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'Delta');
  return join(appDataDir(), 'logs');
}

/** Opens the default browser, unless DELTA_NO_BROWSER is set (tests, headless machines). */
function openBrowser(url: string): void {
  if (!process.env.DELTA_NO_BROWSER) openExternally(url);
}

void main();
