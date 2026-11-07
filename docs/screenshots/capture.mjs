// Takes the README's screenshots (docs/images/*.png) from the real browser version.
//
//   npm run screenshots                     all of them (builds first)
//   npm run screenshots -- start.png        just the ones named
//
// It copies the demo project (docs/screenshots/demo) to a short temporary path, with fixed
// file dates so the folder view shows the same times on every run, starts Delta's server with
// throwaway settings and logs (your own are never touched), and drives a hidden window through
// the scenes below. Images are 2800px wide (1400 at 2x) whatever screen this runs on.
//
// To add a screenshot, add a scene: a file name, a theme, and the steps that set up the view.
import electron from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { app, BrowserWindow, nativeImage } = electron;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = join(ROOT, 'dist/app/server/index.js');
const OUT = join(ROOT, 'docs/images');
const WIDTH = 1400;
const HEIGHT = 909;
/** The demo's files all get this modified date, so the folder view looks the same every run. */
const DEMO_DATE = new Date('2026-10-31T15:37:00');
/** Where the demo is copied: short, since paths show in the pane headers and recent comparisons. */
const DEMO = process.platform === 'win32' ? join(tmpdir(), 'delta-demo') : '/tmp/delta-demo';
const MARKER = '.delta-screenshots';
/**
 * A new image differing from the one already in docs/images by at most this many pixels is not
 * written: the GPU now and then anti-aliases an edge a shade differently (one pixel of an icon,
 * about one run in six), and that shouldn't show up in git as a changed screenshot.
 */
const NOISE_PIXELS = 24;
const only = process.argv.slice(2).filter((a) => a.endsWith('.png'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- The scenes, in order (later ones build on the recent comparisons earlier ones leave) -----

const files = (d) => [join(d, 'shop-1.4/src/inventory.ts'), join(d, 'shop-1.5/src/inventory.ts')];
const folders = (d) => [join(d, 'shop-1.4'), join(d, 'shop-1.5')];

const scenes = [
  {
    name: 'files.png',
    theme: 'light',
    async run(s) {
      await s.open(...files(DEMO));
      // The caret on the left's line 21, so the details strip at the bottom shows that pair.
      await s.clickLine('a', 21);
      return { top: await s.menubarHeight() };
    },
  },
  {
    name: 'files-dark.png',
    theme: 'dark',
    async run(s) {
      await s.open(...files(DEMO));
      await s.clickLine('a', 21);
      return { top: await s.menubarHeight() };
    },
  },
  {
    name: 'browser.png',
    theme: 'dark',
    async run(s) {
      await s.open(...files(DEMO));
      await s.click('.menubar-title:nth-child(3)'); // View
      return { top: 0, height: 520 };
    },
  },
  {
    name: 'folders.png',
    theme: 'dark',
    async run(s) {
      await s.open(...folders(DEMO));
      await s.js(`[...document.querySelectorAll('.toolbar button')].find((b) => b.innerText === 'Expand all').click(); true`);
      await sleep(300);
      await s.js(`[...document.querySelectorAll('.frow')].find((r) => r.innerText.includes('inventory.ts')).click(); true`);
      await sleep(300);
      const top = await s.menubarHeight();
      const bottom = await s.js(`Math.round([...document.querySelectorAll('.frow')].pop().getBoundingClientRect().bottom)`);
      return { top, height: bottom - top + 36 };
    },
  },
  {
    name: 'start.png',
    theme: 'light',
    async run(s) {
      // Home from the folder comparison, so the start screen offers to resume it.
      await s.open(...folders(DEMO));
      await s.click('button[aria-label="Home"]');
      if (!(await s.js(`!!document.querySelector('.start-resume')`))) throw new Error('the start screen has no Resume button');
      return { top: await s.menubarHeight() };
    },
  },
];

// ---- Setting up ---------------------------------------------------------------------------

if (!existsSync(SERVER)) {
  console.error('The browser version is not built: run "npm run screenshots" (it builds first), or "npm run build:web".');
  process.exit(1);
}
const unknown = only.filter((n) => !scenes.some((s) => s.name === n));
if (unknown.length) {
  console.error(`No such screenshot: ${unknown.join(', ')}. Known: ${scenes.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

/**
 * Whether two PNGs show the same picture: identical bytes, or the same size with at most
 * NOISE_PIXELS pixels different. Both are decoded the same way (a fresh capture and a PNG read
 * back differ slightly, from colour conversion, even when nothing changed).
 */
function samePng(oldPng, newPng) {
  if (oldPng.equals(newPng)) return true;
  const [a, b] = [nativeImage.createFromBuffer(oldPng), nativeImage.createFromBuffer(newPng)];
  const [sa, sb] = [a.getSize(), b.getSize()];
  if (a.isEmpty() || sa.width !== sb.width || sa.height !== sb.height) return false;
  const [pa, pb] = [a.toBitmap(), b.toBitmap()];
  let differing = 0;
  for (let i = 0; i < pa.length; i += 4) {
    if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2] || pa[i + 3] !== pb[i + 3]) {
      if (++differing > NOISE_PIXELS) return false;
    }
  }
  return true;
}

/** Copies the demo, replacing only a copy this script made before. */
function copyDemo() {
  if (existsSync(DEMO)) {
    if (!existsSync(join(DEMO, MARKER))) {
      console.error(`${DEMO} exists and wasn't made by this script; move it away and try again.`);
      process.exit(1);
    }
    rmSync(DEMO, { recursive: true, force: true });
  }
  cpSync(join(ROOT, 'docs/screenshots/demo'), DEMO, { recursive: true });
  writeFileSync(join(DEMO, MARKER), 'Made by docs/screenshots/capture.mjs; safe to delete.\n');
  const stamp = (path) => {
    if (statSync(path).isDirectory()) for (const n of readdirSync(path)) stamp(join(path, n));
    utimesSync(path, DEMO_DATE, DEMO_DATE);
  };
  for (const n of readdirSync(DEMO)) if (n !== MARKER) stamp(join(DEMO, n));
}

// Sharp, same-size images on any screen.
app.commandLine.appendSwitch('force-device-scale-factor', '2');

(async () => {
  copyDemo();
  const work = mkdtempSync(join(tmpdir(), 'delta-screenshots-'));
  const port = 5940 + Math.floor(Math.random() * 9);
  const env = { ...process.env, DELTA_NO_BROWSER: '1', ELECTRON_RUN_AS_NODE: '1' };
  const serverArgs = ['--port', String(port), '--data-dir', join(work, 'settings'), '--log-dir', join(work, 'logs')];
  const server = spawn(process.execPath, [SERVER, ...serverArgs], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let code = 1;
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => /running at/.test(String(d)) && resolve());
      server.on('exit', () => reject(new Error("Delta's server stopped")));
      setTimeout(() => reject(new Error("Delta's server didn't start")), 15000);
    });
    // A later launch hands its paths to the running server and prints the page to open.
    const launch = (...paths) => {
      const r = spawnSync(process.execPath, [SERVER, ...serverArgs, ...paths], { env, encoding: 'utf8', timeout: 15000 });
      const url = /(http:\/\/\S+launch=[0-9a-f]+)/.exec(r.stdout)?.[1];
      if (!url) throw new Error(`no launch URL from: ${r.stdout} ${r.stderr}`);
      return url;
    };

    await app.whenReady();
    const win = new BrowserWindow({ width: WIDTH, height: HEIGHT, useContentSize: true, x: -10000, y: 0, show: false, webPreferences: { backgroundThrottling: false } });
    // Shown (off-screen, without focus) so it paints every change, as a real window does.
    win.showInactive();
    const js = (s) => win.webContents.executeJavaScript(s);
    /** The theme of the scene being set up, applied as soon as its page opens. */
    let sceneTheme = 'light';
    const helpers = {
      js,
      async open(...paths) {
        await win.loadURL(launch(...paths));
        for (let i = 0; i < 100 && !(await js(`!!document.querySelector('.diff-view .row, .frow')`).catch(() => false)); i++) await sleep(50);
        // No animations or transitions in these pictures: a fade or a blinking caret caught at a
        // slightly different moment would make an image differ between runs for no reason.
        await js(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after, ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; transition: none !important; }'; document.head.append(s); return true; })()`);
        await sleep(600);
        await helpers.theme(sceneTheme);
      },
      async click(selector, dx) {
        const p = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + ${dx ?? 'r.width / 2'}), y: Math.round(r.top + r.height / 2) }; })()`);
        if (!p) throw new Error(`nothing matches ${selector}`);
        win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
        win.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 });
        await sleep(300);
      },
      async clickLine(side, line) {
        await js(`(() => { const r = [...document.querySelectorAll('.pane-${side} .row')].find((r) => r.querySelector('.ln')?.textContent === '${line}'); r.dataset.shot = '1'; return true; })()`);
        await helpers.click(`.pane-${side} .row[data-shot="1"] .txt`, 60);
      },
      menubarHeight: () => js(`Math.round(document.querySelector('.menubar')?.getBoundingClientRect().height ?? 0)`),
      /** Switches theme the way a user does, with the theme button. */
      async theme(want) {
        if ((await js(`document.documentElement.dataset.theme`)) === want) return;
        await js(`[...document.querySelectorAll('button[aria-label]')].find((b) => /^Switch to (dark|light) mode$/.test(b.getAttribute('aria-label'))).click(); true`);
        await sleep(800); // the crossfade
        const now = await js(`document.documentElement.dataset.theme`);
        if (now !== want) throw new Error(`the theme is ${now}, not ${want}`);
      },
    };

    mkdirSync(OUT, { recursive: true });
    const written = [];
    const unchanged = [];
    for (const scene of scenes) {
      sceneTheme = scene.theme;
      const crop = await scene.run(helpers);
      if (only.length && !only.includes(scene.name)) continue;
      // The comparison's time ("2 ms") varies from run to run; show a fixed one, so an image only
      // changes when the interface does.
      await js(`document.querySelectorAll('.stats .elapsed').forEach((e) => { if (/^\\d+ ms$/.test(e.textContent)) e.textContent = '1 ms'; }); true`);
      // Settle, then capture.
      win.webContents.invalidate();
      await sleep(400);
      const image = await win.webContents.capturePage();
      const scale = image.getSize().width / WIDTH;
      const top = Math.round((crop.top ?? 0) * scale);
      const height = Math.round((crop.height ?? image.getSize().height / scale - (crop.top ?? 0)) * scale);
      const png = image.crop({ x: 0, y: top, width: image.getSize().width, height }).toPNG();
      const path = join(OUT, scene.name);
      if (existsSync(path) && samePng(readFileSync(path), png)) {
        unchanged.push(scene.name);
        continue;
      }
      writeFileSync(path, png);
      const size = nativeImage.createFromBuffer(png).getSize();
      written.push(`${scene.name} (${size.width}x${size.height})`);
    }
    console.log(written.length ? `Updated in docs/images: ${written.join(', ')}` : 'No screenshot changed.');
    if (unchanged.length) console.log(`Unchanged: ${unchanged.join(', ')}`);
    code = 0;
  } catch (err) {
    console.error('\nScreenshots failed:', err.stack ?? err);
  } finally {
    server.kill();
    rmSync(work, { recursive: true, force: true });
    app.exit(code);
  }
})();
