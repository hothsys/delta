import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeLog, formatEntry, initLog, log, logLevel, recentLines, resolveLogLevel, takeLogLevel, writeFromInterface } from '../../src/node/log';
import { logInfo, setDebugLogging, startLogging } from '../../src/node/logging';
import { readTextFile, writeTextFile } from '../../src/node/files';

const fresh = () => mkdtempSync(join(tmpdir(), 'delta-log-'));
const read = (dir: string, name = 'test.log') => readFileSync(join(dir, name), 'utf8');

afterEach(() => {
  closeLog();
  delete process.env.DELTA_LOG_LEVEL;
});

describe('formatEntry', () => {
  it('writes one line: local time, level, area, message, then key=value fields', () => {
    const line = formatEntry(new Date(2026, 10, 1, 16, 4, 5, 123), 'info', 'files', 'Saved', { path: '/a/b.txt', bytes: 12, gone: undefined });
    expect(line).toMatch(/^2026-11-01T16:04:05\.123[+-]\d\d:\d\d INFO  files    Saved  path=\/a\/b\.txt bytes=12\n$/);
  });

  it('quotes values with spaces and keeps entries on one line', () => {
    const line = formatEntry(new Date(), 'warn', 'ui', 'two\nlines', { path: '/My Files/x "y".txt' });
    expect(line.trimEnd().split('\n')).toHaveLength(1);
    expect(line).toContain('two⏎lines');
    expect(line).toContain('path="/My Files/x \\"y\\".txt"');
  });

  it('puts an error message in the fields and its stack on indented lines', () => {
    const err = new TypeError('bad thing');
    const lines = formatEntry(new Date(), 'error', 'server', 'Failed', {}, err).trimEnd().split('\n');
    expect(lines[0]).toContain('error="TypeError: bad thing"');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((l) => l.startsWith('    at '))).toBe(true);
  });

  it('cuts very long values', () => {
    expect(formatEntry(new Date(), 'info', 'ui', 'x'.repeat(10_000)).length).toBeLessThan(2100);
  });
});

describe('the log file', () => {
  it('does nothing until it is opened', () => {
    log.error('app', 'nowhere to go');
    expect(recentLines(10)).toEqual([]);
  });

  it('writes entries at or above its level, readable only by the user', () => {
    const dir = fresh();
    initLog({ dir, name: 'test.log', level: 'info' });
    log.debug('app', 'hidden detail');
    log.info('app', 'shown');
    log.error('app', 'broken', new Error('why'));
    const text = read(dir);
    expect(text).not.toContain('hidden detail');
    expect(text).toContain('INFO  app      shown');
    expect(text).toContain('ERROR app      broken  error=why');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'test.log')).mode & 0o777).toBe(0o600);
  });

  it('rotates past the size limit, keeping three old files', () => {
    const dir = fresh();
    initLog({ dir, name: 'test.log', level: 'info', maxBytes: 1000 });
    for (let i = 0; i < 200; i++) log.info('app', `entry ${i}`, { padding: 'x'.repeat(40) });
    for (const f of ['test.log', 'test.log.1', 'test.log.2', 'test.log.3']) {
      expect(existsSync(join(dir, f))).toBe(true);
      expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(1000);
    }
    expect(existsSync(join(dir, 'test.log.4'))).toBe(false);
    // Nothing lost between files: the newest entries are in the current file, older in .1.
    expect(read(dir)).toContain('entry 199');
    const last1 = Number(/entry (\d+)/.exec(read(dir, 'test.log.1').trimEnd().split('\n').pop()!)![1]);
    const first0 = Number(/entry (\d+)/.exec(read(dir).split('\n')[0])![1]);
    expect(first0).toBe(last1 + 1);
  });

  it('carries on from an existing file size, rotating it when already full', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'test.log'), 'y'.repeat(990) + '\n');
    initLog({ dir, name: 'test.log', level: 'info', maxBytes: 1000 });
    log.info('app', 'next start');
    expect(read(dir, 'test.log.1')).toMatch(/^y+\n$/);
    expect(read(dir)).toContain('next start');
  });

  it('returns the latest lines for diagnostics', () => {
    const dir = fresh();
    initLog({ dir, name: 'test.log', level: 'info' });
    for (let i = 0; i < 20; i++) log.info('app', `line ${i}`);
    const lines = recentLines(5);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain('line 19');
  });
});

describe('entries from the interface', () => {
  it('are prefixed with ui., checked and trimmed', () => {
    const dir = fresh();
    initLog({ dir, name: 'test.log', level: 'info' });
    writeFromInterface({ level: 'info', area: 'merge', message: 'Copied', fields: { line: 4, nested: { no: 1 }, 'bad key': 1 } });
    writeFromInterface({ level: 'nonsense', area: 'x', message: 'dropped' });
    writeFromInterface({ level: 'warn', area: '../../etc', message: 'odd area' });
    writeFromInterface('not an object');
    writeFromInterface({ level: 'error', area: 'app', message: 'Uncaught', stack: 'Error: boom\n    at f (app.js:1:2)' });
    const text = read(dir);
    expect(text).toContain('INFO  ui.merge Copied  line=4\n');
    expect(text).not.toContain('nested');
    expect(text).not.toContain('dropped');
    expect(text).toContain('WARN  ui.ui    odd area');
    expect(text).toContain('    at f (app.js:1:2)');
  });
});

describe('what is logged about files', () => {
  it('paths, sizes and encodings, but never the contents', async () => {
    const dir = fresh();
    initLog({ dir, name: 'test.log', level: 'debug' });
    const path = join(dir, 'secret.txt');
    await writeTextFile({ path, text: 'TOP SECRET CONTENTS\n', encoding: 'utf8' });
    await readTextFile(path);
    await readTextFile(join(dir, 'missing.txt'));
    const text = read(dir);
    expect(text).toContain('Saved');
    expect(text).toContain('bytes=20');
    expect(text).toContain('Read');
    expect(text).toContain('Could not read');
    expect(text).not.toContain('TOP SECRET');
  });
});

describe('the log level', () => {
  it('comes from the command line, then DELTA_LOG_LEVEL, then the setting, else info', () => {
    expect(resolveLogLevel({ cli: 'debug', env: 'warn', saved: 'error' })).toEqual({ level: 'debug', from: 'command line' });
    expect(resolveLogLevel({ env: 'WARN', saved: 'debug' })).toEqual({ level: 'warn', from: 'DELTA_LOG_LEVEL' });
    expect(resolveLogLevel({ cli: 'loud', saved: 'debug' })).toEqual({ level: 'debug', from: 'setting' });
    expect(resolveLogLevel({ saved: 42 })).toEqual({ level: 'info', from: 'default' });
  });

  it('is read from the command line, leaving the paths', () => {
    expect(takeLogLevel(['--log-level', 'debug', 'a.txt', 'b.txt'])).toEqual({ level: 'debug', rest: ['a.txt', 'b.txt'] });
    expect(takeLogLevel(['a', '--log-level=warn', 'b'])).toEqual({ level: 'warn', rest: ['a', 'b'] });
    expect(takeLogLevel(['--', '--log-level', 'x'])).toEqual({ level: undefined, rest: ['--', '--log-level', 'x'] });
  });

  it('Debug Logging switches now and is remembered for the next start', async () => {
    const dir = fresh();
    const dataDir = join(dir, 'settings');
    expect(startLogging({ dir, name: 'test.log', dataDir })).toMatchObject({ level: 'info', from: 'default' });
    expect(await setDebugLogging(dataDir, true)).toMatchObject({ level: 'debug', from: 'setting' });
    expect(logLevel()).toBe('debug');
    if (process.platform !== 'win32') expect(statSync(join(dataDir, 'settings.json')).mode & 0o777).toBe(0o600);
    closeLog();
    expect(startLogging({ dir, name: 'test.log', dataDir })).toMatchObject({ level: 'debug', from: 'setting' });
    // The environment wins over the setting.
    process.env.DELTA_LOG_LEVEL = 'error';
    expect(startLogging({ dir, name: 'test.log', dataDir })).toMatchObject({ level: 'error', from: 'DELTA_LOG_LEVEL' });
    delete process.env.DELTA_LOG_LEVEL;
    await setDebugLogging(dataDir, false);
    expect(logInfo().level).toBe('info');
    expect(startLogging({ dir, name: 'test.log', dataDir })).toMatchObject({ level: 'info', from: 'default' });
    expect(read(dir)).toContain('Debug logging turned on');
  });
});

describe('what is logged about folder scans', () => {
  it('totals, and each entry that could not be read', async () => {
    if (process.platform === 'win32') return; // chmod can't make a folder unreadable there
    const { chmodSync, mkdirSync } = await import('node:fs');
    const { compareFolders } = await import('../../src/node/folders');
    const dir = fresh();
    for (const d of ['L/locked', 'R/locked']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'L', 'a.txt'), 'private words\n');
    writeFileSync(join(dir, 'R', 'a.txt'), 'other words\n');
    chmodSync(join(dir, 'L', 'locked'), 0o000);
    initLog({ dir, name: 'test.log', level: 'info' });
    try {
      await compareFolders(join(dir, 'L'), join(dir, 'R'));
    } finally {
      chmodSync(join(dir, 'L', 'locked'), 0o755);
    }
    const text = read(dir);
    expect(text).toMatch(/INFO  folders  Comparing folders  left=\S+ right=\S+ mode=contents/);
    expect(text).toMatch(/INFO  folders  Folder comparison finished  status=different entries=\d+ files=1 .*unreadable=1/);
    expect(text).toMatch(/WARN  folders  Couldn't read  relPath=locked error=/);
    expect(text).not.toContain('words');
  });
});
