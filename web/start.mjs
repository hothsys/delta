// Starts Delta's browser version: `node web/start.mjs [--port N] [--stop | --restart] [left right]`.
// start.command, start.cmd and `npm run web` all run this.
//
// It installs dependencies when they're missing or the lockfile has changed, builds when
// anything that goes into the build has changed since the last one, then runs the server in
// this window and opens the browser. Ctrl+C (or closing the window) stops it. If Delta is
// already running on the port, the server opens that copy instead (with the comparison, if
// two paths were given).
//
// What it installs and builds, and any failure with npm's output, goes to start.log in Delta's
// logs folder (~/Library/Logs/Delta on macOS), beside the server's web.log and the desktop app's
// desktop.log.
//
// Only Node's built-in modules are used here: node_modules may not exist yet.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = [22, 12];
const STAMP = join(ROOT, 'dist/app/.web-build');
const SERVER = join(ROOT, 'dist/app/server/index.js');
/** Everything that goes into the build; a change to any of it means building again. */
const SOURCES = ['src', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'web/vite.config.ts'];
/** Delta's logs folder: the same one the server and the desktop app use. */
const LOGS =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Logs', 'Delta')
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Delta', 'logs')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Delta', 'logs');
const LOG = join(LOGS, 'start.log');
/** start.log is small: past this it becomes start.log.1 (replacing the previous one). */
const LOG_MAX_BYTES = 1024 * 1024;

/** Adds a line (and any extra output, indented) to start.log. Never fails the start. */
function note(message, output = '') {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    if (existsSync(LOG) && statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, `${LOG}.1`);
    const extra = output.trim() ? `${output.trim().split('\n').map((l) => `    ${l}`).join('\n')}\n` : '';
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n${extra}`, { mode: 0o600 });
  } catch {
    // Logging is a convenience here.
  }
}

const fail = (message, output = '') => {
  note(`FAILED: ${message}`, output);
  console.error(`\n${message}${existsSync(LOG) ? `\nDetails are in ${LOG}` : ''}`);
  process.exit(1);
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  fail(`Delta needs Node.js ${MIN_NODE.join('.')} or newer; this is ${process.version}. Get a current one at https://nodejs.org`);
}

/**
 * Runs an npm command in the project folder; output is shown only if it fails (unless `show`).
 *
 * Ctrl+C reaches npm too (the terminal sends it to both). During an install npm doesn't quit at
 * once: it first undoes what it had started, which waits for downloads in progress. So this
 * waits for npm rather than exiting and leaving it running behind the prompt, says so, and
 * stops it outright on a second Ctrl+C.
 */
function npm(args, { show = false, env = process.env } = {}) {
  const command = `npm ${args.join(' ')}`;
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: ROOT,
      env,
      stdio: show ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    let interrupts = 0;
    const onInterrupt = () => {
      if (++interrupts === 1) console.error('\nStopping: npm is undoing what it started, which can take a moment. Press Ctrl+C again to stop it now.');
      else child.kill('SIGKILL');
    };
    process.on('SIGINT', onInterrupt);
    child.on('error', (err) => fail(`"${command}" couldn't start: ${err.message}.`));
    child.on('close', (code) => {
      process.off('SIGINT', onInterrupt);
      if (interrupts) {
        note(`Stopped with Ctrl+C during "${command}"`);
        process.exit(130);
      }
      if (code !== 0) {
        if (!show) process.stderr.write(output);
        fail(`"${command}" failed.`, output);
      }
      resolve();
    });
  });
}

/** Runs `step` (which returns a promise), noting how long it took. */
async function timed(what, step) {
  const t0 = Date.now();
  note(`${what}…`);
  await step();
  note(`${what}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * A fingerprint of everything that goes into the build: every file's path and modification
 * time. Any edit changes it (even one made during a build, since it's taken before), while a
 * file dated in the future (a clock that was off, an unzipped archive) can't force a rebuild
 * on every start.
 */
function fingerprint() {
  const hash = createHash('sha1');
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      hash.update(`${path}:${mtime(path)}\n`); // a file (or missing: 0)
      return;
    }
    for (const e of entries.sort((x, y) => (x.name < y.name ? -1 : 1))) walk(join(path, e.name));
  };
  for (const s of SOURCES) walk(join(ROOT, s));
  return hash.digest('hex');
}

// Stopping needs only what's already built.
const stopOnly = process.argv.includes('--stop') && existsSync(SERVER);

// Dependencies: on first run, and after a pull that changed the lockfile.
const installed = join(ROOT, 'node_modules/.package-lock.json');
if (!stopOnly && (!existsSync(installed) || mtime(join(ROOT, 'package-lock.json')) > mtime(installed))) {
  console.log('Installing dependencies (first run, or after an update). This can take a minute…');
  // The browser version doesn't need Electron's ~100MB app binary (only the desktop app does),
  // so skip downloading it: a faster first start, and one that works behind proxies the
  // download doesn't support. The desktop app fetches it on first run (npm start's prestart).
  await timed('Installing dependencies', () => npm(['install', '--no-audit', '--no-fund'], { show: true, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } }));
}

// Build: on first run, and whenever anything that goes into it has changed since.
const sources = fingerprint();
const builtFrom = existsSync(STAMP) ? readFileSync(STAMP, 'utf8') : '';
if (!stopOnly && (!existsSync(SERVER) || !existsSync(join(ROOT, 'dist/app/renderer/index.html')) || builtFrom !== sources)) {
  console.log('Building Delta…');
  await timed('Building', () => npm(['run', 'build:web']));
  writeFileSync(STAMP, sources);
}

// Serve, in this process. The server reads its options from the command line.
if (!process.argv.includes('--open') && !process.env.DELTA_NO_BROWSER) process.argv.push('--open');
await import(pathToFileURL(SERVER).href);
