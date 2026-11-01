// `npm run web:dev`: the browser version with hot reload.
//
// Delta's server runs as usual (on DELTA_DEV_PORT, default 5911, so it can sit beside a
// normal copy on 5910), and Vite's dev server serves the interface on 5173 with hot reload.
// Vite passes /api calls through to Delta's server as if they came from its own page, and
// adds the server's token to the page, as the server does. CORS stays off, so other websites
// can neither read the page (and its token) nor call the API through it.
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.DELTA_DEV_PORT ?? 5911);
const dataDir =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Delta')
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Delta')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Delta');
const runtime = () => JSON.parse(readFileSync(join(dataDir, `server-${port}.json`), 'utf8'));
const token = () => runtime().token;

const server = spawn(process.execPath, [join(root, 'dist/app/server/index.js'), '--port', String(port), ...process.argv.slice(2)], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, DELTA_NO_BROWSER: '1' },
});
const stop = () => {
  server.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => {
  // Exiting at once with success means it handed over to a Delta already on this port.
  if (code === 0) console.error(`A Delta is already running on port ${port}; stop it, or set DELTA_DEV_PORT to another port.`);
  process.exit(code === 0 ? 1 : (code ?? 1));
});
// Paths given on the command line open as a launch; pass its id on to Vite's page.
let launchPath = '/';
server.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  const id = /[?&]launch=([0-9a-f]+)/.exec(String(chunk))?.[1];
  if (id) launchPath = `/?launch=${id}`;
});

// Wait for this server to write its runtime file (it holds the token); one left by a crash
// belongs to another process and doesn't count.
for (let i = 0; ; i++) {
  try {
    if (runtime().pid === server.pid) break;
    throw new Error('not yet');
  } catch {
    if (i > 100) throw new Error(`Delta's server didn't start on port ${port}.`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const target = `http://127.0.0.1:${port}`;
const pageLink = `http://localhost:5173${launchPath === '/' ? '' : launchPath}`;

const vite = await createServer({
  configFile: false,
  root: join(root, 'src/renderer'),
  plugins: [
    react(),
    {
      name: 'delta-token',
      // Read on every page load, so a restarted server's new token is picked up.
      transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta name="delta-token" content="${token()}" />`),
    },
  ],
  worker: { format: 'es' },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    cors: false,
    open: process.env.DELTA_NO_BROWSER ? false : launchPath,
    proxy: { '/api': { target, changeOrigin: true, headers: { origin: target } } },
  },
});
await vite.listen();
console.log(`  ➜  Open: ${pageLink}`);
