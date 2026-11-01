// End-to-end checks of the browser version: the real server (dist/app/server) driven through a
// real Chromium page. Electron provides the browser, so there's no extra dependency.
//
//   npm run test:e2e        (builds first)
//
// Everything runs against temporary files and a temporary settings folder, on a spare port.
import electron from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { app, BrowserWindow } = electron;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = join(ROOT, 'dist/app/server/index.js');
const PORT = 5990 + Math.floor(Math.random() * 9);
const MOD = process.platform === 'darwin' ? 'meta' : 'control';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Fixtures ----------------------------------------------------------------------------

const T = mkdtempSync(join(tmpdir(), 'delta-e2e-'));
const DATA = join(T, 'settings');
const F = join(T, 'files');
mkdirSync(F);
writeFileSync(join(F, 'left.txt'), 'alpha\nbravo\ncharlie\ndelta\necho\n');
writeFileSync(join(F, 'right.txt'), 'alpha\nBRAVO\ncharlie\necho\nfoxtrot\n');
// Latin-1 with CRLF line endings: saving must keep both.
writeFileSync(join(F, 'latin1.txt'), Buffer.from('caf\xe9\r\nna\xefve\r\n', 'latin1'));
writeFileSync(join(F, 'other.txt'), 'cafe\r\nnaive\r\n');

const L = join(T, 'L');
const R = join(T, 'R');
for (const d of [L, R, join(L, 'sub'), join(R, 'sub'), join(R, 'right-only')]) mkdirSync(d, { recursive: true });
writeFileSync(join(L, 'same.txt'), 'same\n');
writeFileSync(join(R, 'same.txt'), 'same\n');
writeFileSync(join(L, 'diff.txt'), 'left version\n');
writeFileSync(join(R, 'diff.txt'), 'right version, longer\n');
writeFileSync(join(L, 'left-only.txt'), 'only on the left\n');
writeFileSync(join(R, 'right-only', 'x.txt'), 'x\n');
writeFileSync(join(L, 'sub', 'nested.txt'), 'one\n');
writeFileSync(join(R, 'sub', 'nested.txt'), 'two\n');
// Same size and modified time, different content: only a contents comparison can tell.
writeFileSync(join(L, 'tricky.txt'), 'aaaa\n');
writeFileSync(join(R, 'tricky.txt'), 'bbbb\n');
const stamp = new Date('2026-01-02T03:04:05Z');
utimesSync(join(L, 'tricky.txt'), stamp, stamp);
utimesSync(join(R, 'tricky.txt'), stamp, stamp);
// A folder that disappears later, for the missing-path badge on the start screen.
const GONE = join(T, 'gone');
mkdirSync(GONE);
writeFileSync(join(GONE, 'a.txt'), 'a\n');

// ---- Results -----------------------------------------------------------------------------

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  ok ? passes++ : failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};
const section = (name) => console.log(`\n${name}`);

// ---- Server ------------------------------------------------------------------------------

// The server runs on Electron's own Node (ELECTRON_RUN_AS_NODE), so no separate Node is needed.
const env = { ...process.env, DELTA_NO_BROWSER: '1', ELECTRON_RUN_AS_NODE: '1' };
const server = spawn(process.execPath, [SERVER, '--port', String(PORT), '--data-dir', DATA], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => appendFileSync(join(T, 'server.log'), d));

/** Launches Delta again with paths, as a user would; the running server takes them. Returns the URL. */
function launch(...paths) {
  const r = spawnSync(process.execPath, [SERVER, '--port', String(PORT), '--data-dir', DATA, ...paths], { env, encoding: 'utf8', timeout: 15000 });
  const url = /(http:\/\/\S+launch=[0-9a-f]+)/.exec(r.stdout)?.[1];
  if (!url) throw new Error(`no launch URL from: ${r.stdout} ${r.stderr}`);
  return { url, output: r.stdout };
}

// ---- Page helpers ------------------------------------------------------------------------

let win;
let firstUrl = '';
const errors = [];
let unloadPrompts = 0;
const js = (s) => win.webContents.executeJavaScript(s);
async function waitFor(expr, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await js(expr).catch(() => false)) return true;
    await sleep(50);
  }
  return false;
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode.length === 1 && !modifiers.includes('meta') && !modifiers.includes('control')) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await sleep(60);
}
const type = async (text) => {
  for (const ch of text) await key(ch);
};
/** A real click at the centre of an element (or `dx` pixels from its left edge). */
async function clickEl(selector, { dx, index = 0, count = 1 } = {}) {
  const p = await js(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(${dx === undefined ? 'r.left + r.width / 2' : `r.left + ${dx}`}), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!p) throw new Error(`nothing matches ${selector}`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
  for (let i = 1; i <= count; i++) {
    win.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: i });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: i });
  }
  await sleep(150);
}
const clickText = (selector, text) =>
  js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(`${selector} "${text}"`)}); el.click(); return true; })()`);
/** Sets an input's value the way React notices. */
const fill = (selector, value) =>
  js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); return true; })()`);
const paneLines = (side) => js(`[...document.querySelectorAll('.pane-${side} .row')].map((r) => r.querySelector('.txt')?.innerText ?? '').filter(Boolean)`);
const stats = () => js(`document.querySelector('.stats')?.innerText.replace(/\\s+/g, ' ').trim()`);
async function open(url) {
  await win.loadURL(url);
  await waitFor(`!!document.querySelector('.menubar')`);
  await sleep(500);
}
/** Picks a file in the in-app file browser: go to its folder, then double-click it. */
async function pickFile(path) {
  if (!(await waitFor(`!!document.querySelector('.file-browser')`))) throw new Error('the file browser did not open');
  await fill('.fb-path', dirname(path));
  await key('Return');
  const name = path.split('/').pop();
  await waitFor(`[...document.querySelectorAll('.fb-row .fb-name')].some((n) => n.innerText === ${JSON.stringify(name)})`);
  await js(`[...document.querySelectorAll('.fb-row')].find((r) => r.querySelector('.fb-name').innerText === ${JSON.stringify(name)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(300);
}
const rowStatus = (name) => js(`(() => { const r = [...document.querySelectorAll('.frow')].find((r) => r.querySelector('.fcell:not(.missing)')?.innerText.includes(${JSON.stringify(name)})); return r ? [...r.classList].find((c) => c.startsWith('st-'))?.slice(3) : null; })()`);

// ---- Scenarios ---------------------------------------------------------------------------

async function run() {
  section('Start screen');
  await open(firstUrl);
  check('loads with the menu bar and both choices', await js(`!!document.querySelector('.start') && document.querySelectorAll('.start-choice').length === 2 && [...document.querySelectorAll('.menubar-title')].map((b) => b.innerText).join() === 'File,Edit,View'`));

  section('Comparing files through the in-app file browser');
  await key('o', [MOD]);
  await pickFile(join(F, 'left.txt'));
  await pickFile(join(F, 'right.txt'));
  check('both files open side by side', await waitFor(`!!document.querySelector('.diff-view') && document.querySelectorAll('.diff-view .pane-title').length === 2`));
  check('the headers show full paths', await js(`[...document.querySelectorAll('.pane-title')].map((t) => t.title).join('|') === ${JSON.stringify(`${join(F, 'left.txt')}|${join(F, 'right.txt')}`)}`));
  const s1 = await stats();
  check('differences are counted', s1?.startsWith('3 differences') && s1.includes('1 modified') && s1.includes('1 inserted') && s1.includes('1 deleted'), s1);
  await clickEl('.pane-b .row', { dx: 120 });
  await key('F7');
  check('F7 goes to the first difference', (await js(`document.querySelector('.detail-b .detail-ln')?.innerText`)) === '2');

  section('Editing, saving, merging, undo');
  await key('End');
  await type('!');
  check('typing marks the side edited', await waitFor(`!!document.querySelector('.pane-header .edited')`));
  await key('s', [MOD]);
  await sleep(500);
  check('Cmd/Ctrl+S saves the active side to disk', readFileSync(join(F, 'right.txt'), 'utf8') === 'alpha\nBRAVO!\ncharlie\necho\nfoxtrot\n', JSON.stringify(readFileSync(join(F, 'right.txt'), 'utf8')));
  check('saving clears the edited mark', !(await js(`!!document.querySelector('.pane-header .edited')`)));
  await sleep(800); // let the re-diff settle so the merge arrows are live
  await clickEl('[aria-label="Copy to right"]');
  check('a merge arrow copies the change across', (await paneLines('b'))[1] === 'bravo', JSON.stringify(await paneLines('b')));
  await clickText('.menubar-title', 'File');
  await clickText('.menubar-panel [role=menuitem]', 'Save Right');
  await sleep(500);
  check('File > Save Right writes it', readFileSync(join(F, 'right.txt'), 'utf8').startsWith('alpha\nbravo\n'));
  await key('z', [MOD]);
  check('undo brings the change back', (await paneLines('b'))[1] === 'BRAVO!', JSON.stringify(await paneLines('b')));

  section('Launching again while running, and the unsaved-changes guard');
  const l1 = launch(join(F, 'latin1.txt'), join(F, 'other.txt'));
  check('a second launch hands its files to the running copy', l1.output.includes('already running'));
  win.webContents.once('will-prevent-unload', (e) => {
    unloadPrompts++;
    e.preventDefault(); // answer "Leave"
  });
  await open(l1.url);
  check('leaving with unsaved edits asks first', unloadPrompts === 1);
  check('the launched comparison opens', await js(`[...document.querySelectorAll('.pane-title')].map((t) => t.title).join('|') === ${JSON.stringify(`${join(F, 'latin1.txt')}|${join(F, 'other.txt')}`)}`));

  section('Saving keeps encoding and line endings');
  await clickEl('.pane-a .row', { dx: 120 });
  await key('End');
  await type('s');
  await key('s', [MOD]);
  await sleep(500);
  check('Latin-1 and CRLF are preserved', readFileSync(join(F, 'latin1.txt')).equals(Buffer.from('caf\xe9s\r\nna\xefve\r\n', 'latin1')), readFileSync(join(F, 'latin1.txt')).toString('hex'));

  section('Outside changes');
  appendFileSync(join(F, 'other.txt'), 'added elsewhere\r\n');
  check('a change made elsewhere is noticed', await waitFor(`document.querySelector('.notice')?.innerText.includes('changed on disk')`, 10000));
  await clickText('.notice button', 'Reload');
  check('Reload shows the new content', await waitFor(`[...document.querySelectorAll('.pane-b .txt')].some((t) => t.innerText === 'added elsewhere')`));
  writeFileSync(join(F, 'other.txt'), 'cafe\r\nnaive\r\nmore\r\n');
  await key('F5');
  check('F5 reloads too (and not the page)', await waitFor(`[...document.querySelectorAll('.pane-b .txt')].some((t) => t.innerText === 'more')`));

  section('Comparing folders');
  await open(launch(L, R).url);
  check('the folder comparison opens', await waitFor(`document.querySelectorAll('.frow').length > 0`));
  check('statuses: same, different, left only, right only', (await rowStatus('same.txt')) === 'same' && (await rowStatus('diff.txt')) === 'different' && (await rowStatus('left-only.txt')) === 'left-only' && (await rowStatus('right-only')) === 'right-only');
  check('a folder with a difference inside is marked different', (await rowStatus('sub')) === 'different');
  check('contents mode sees through equal size and date', (await rowStatus('tricky.txt')) === 'different');
  await clickEl('.toolbar .options-button');
  await clickText('.options-menu [role=menuitemradio], .options-menu button', 'Size and modified date');
  await waitFor(`!document.querySelector('.scan-progress')`);
  await sleep(300);
  check('size-and-date mode treats it as the same', (await rowStatus('tricky.txt')) === 'same', await rowStatus('tricky.txt'));
  await clickEl('.toolbar .options-button');
  await clickText('.options-menu [role=menuitemradio], .options-menu button', 'Contents');
  await waitFor(`!document.querySelector('.scan-progress')`);
  await sleep(300);
  await clickEl('[aria-label="Copy left-only.txt to the right"]');
  await sleep(600);
  check('copying a file across writes it', readFileSync(join(R, 'left-only.txt'), 'utf8') === 'only on the left\n');
  check('and it now shows as the same', (await rowStatus('left-only.txt')) === 'same');
  await clickEl('[aria-label="Copy diff.txt to the right"]');
  check('replacing a file asks first', await waitFor(`!!document.querySelector('.confirm-dialog')`));
  await clickEl('.confirm-dialog button.primary');
  await sleep(600);
  check('and replaces it after confirming', readFileSync(join(R, 'diff.txt'), 'utf8') === 'left version\n');

  section('Opening a file from the folder comparison and going back');
  await js(`document.querySelector('.folder-list').scrollTop = 0; true`);
  await js(`[...document.querySelectorAll('.frow')].find((r) => r.innerText.includes('tricky.txt')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  check('double-clicking a file compares it', await waitFor(`!!document.querySelector('.diff-view') && document.querySelector('.pane-a .txt')?.innerText === 'aaaa'`));
  await clickText('.toolbar button', '← Folders');
  check('"← Folders" returns to the list without rescanning', (await js(`!document.querySelector('.diff-view') && document.querySelectorAll('.frow').length > 0 && !document.querySelector('.scan-progress')`)) === true);

  section('Recent comparisons');
  await open(launch(GONE, R).url);
  await waitFor(`document.querySelectorAll('.frow').length > 0`);
  rmSync(GONE, { recursive: true });
  await open(`http://127.0.0.1:${PORT}/`);
  await waitFor(`!!document.querySelector('.recents')`);
  const recents = await js(`[...document.querySelectorAll('.recents li, .recents .recent')].map((e) => e.innerText.replace(/\\s+/g, ' '))`);
  check('comparisons are listed on the start screen', recents.some((r) => r.includes('latin1.txt')) && recents.some((r) => r.includes('L') && r.includes('R')), JSON.stringify(recents));
  check('a path that no longer exists is flagged', await js(`[...document.querySelectorAll('.recents .flag.warn')].some((f) => f.innerText === 'Not found')`));

  check('no errors in the page console', errors.length === 0, errors.join(' / '));
}

// ---- Main --------------------------------------------------------------------------------

(async () => {
  let code = 1;
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => {
        const m = /running at (http:\/\/\S+)/.exec(String(d));
        if (m) {
          firstUrl = m[1];
          resolve();
        }
      });
      server.on('exit', () => reject(new Error('the server exited; see ' + join(T, 'server.log'))));
      setTimeout(() => reject(new Error('the server did not start')), 15000);
    });
    await app.whenReady();
    win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
    win.webContents.on('console-message', (e) => e.level === 'error' && errors.push(e.message.slice(0, 200)));
    console.log(`Delta browser version: end-to-end checks (port ${PORT})`);
    await run();
    console.log(`\n${passes} passed, ${failures} failed`);
    code = failures ? 1 : 0;
  } catch (err) {
    console.error('\nStopped:', err.stack ?? err);
  } finally {
    server.kill();
    rmSync(T, { recursive: true, force: true });
    app.exit(code);
  }
})();
