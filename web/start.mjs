// Starts Delta's browser version: `node web/start.mjs [--port N] [--stop | --restart] [left right]`.
// start.command, start.cmd and `npm run web` all run this.
//
// It installs dependencies when they're missing or the lockfile has changed, builds when
// anything that goes into the build has changed since the last one, then runs the server in
// this window and opens the browser. Ctrl+C (or closing the window) stops it. If Delta is
// already running on the port, the server opens that copy instead (with the comparison, if
// two paths were given).
//
// Only Node's built-in modules are used here: node_modules may not exist yet.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = [22, 12];
const STAMP = join(ROOT, 'dist/app/.web-build');
const SERVER = join(ROOT, 'dist/app/server/index.js');
/** Everything that goes into the build; a change to any of it means building again. */
const SOURCES = ['src', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'web/vite.config.ts'];

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  fail(`Delta needs Node.js ${MIN_NODE.join('.')} or newer; this is ${process.version}. Get a current one at https://nodejs.org`);
}

/** Runs an npm command in the project folder; output is shown only if it fails (unless `show`). */
function npm(args, { show = false, env = process.env } = {}) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: ROOT,
    env,
    stdio: show ? 'inherit' : 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    if (!show) process.stderr.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    fail(`"npm ${args.join(' ')}" failed${r.error ? `: ${r.error.message}` : ''}.`);
  }
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
  // download doesn't support. `npm rebuild electron` fetches it later for the desktop app.
  npm(['install', '--no-audit', '--no-fund'], { show: true, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
}

// Build: on first run, and whenever anything that goes into it has changed since.
const sources = fingerprint();
const builtFrom = existsSync(STAMP) ? readFileSync(STAMP, 'utf8') : '';
if (!stopOnly && (!existsSync(SERVER) || !existsSync(join(ROOT, 'dist/app/renderer/index.html')) || builtFrom !== sources)) {
  console.log('Building Delta…');
  npm(['run', 'build:web']);
  writeFileSync(STAMP, sources);
}

// Serve, in this process. The server reads its options from the command line.
if (!process.argv.includes('--open') && !process.env.DELTA_NO_BROWSER) process.argv.push('--open');
await import(pathToFileURL(SERVER).href);
