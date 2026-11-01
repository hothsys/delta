import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeltaServer } from '../../src/server/app';
import { answersAsDelta, handOff, readRuntime, removeRuntime, runtimeFile, stopRunning, writeRuntime } from '../../src/server/runtime';
import { createServer } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'delta-runtime-'));
const token = 'runtime-test-token-0123456789';
const server = createDeltaServer({ token, staticDir: dir, recentsFile: join(dir, 'recents.json') });
let port = 0;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('runtime file', () => {
  it('is written readable only by the user, and read back for its port', () => {
    writeRuntime(dir, { pid: 1234, port: 7001, token: 't' });
    expect(statSync(runtimeFile(dir, 7001)).mode & 0o777).toBe(0o600);
    expect(readRuntime(dir, 7001)).toEqual({ pid: 1234, port: 7001, token: 't' });
    expect(readRuntime(dir, 7002)).toBeNull();
    writeFileSync(runtimeFile(dir, 7003), 'not json');
    expect(readRuntime(dir, 7003)).toBeNull();
  });

  it('is only removed by the server that wrote it', () => {
    writeRuntime(dir, { pid: 1, port: 7004, token: 'a' });
    writeRuntime(dir, { pid: 2, port: 7004, token: 'b' }); // a newer server took over the port
    removeRuntime(dir, { pid: 1, port: 7004, token: 'a' });
    expect(readRuntime(dir, 7004)?.pid).toBe(2);
    removeRuntime(dir, { pid: 2, port: 7004, token: 'b' });
    expect(existsSync(runtimeFile(dir, 7004))).toBe(false);
  });
});

describe('handOff', () => {
  it('passes paths to a running server and returns a launch id for them', async () => {
    const id = await handOff({ pid: process.pid, port, token }, [join(dir, 'a.txt'), join(dir, 'b.txt')]);
    expect(id).toMatch(/^[0-9a-f]{18}$/);
  });

  it('returns null for a stale file (nothing listening) or a wrong token', async () => {
    expect(await handOff({ pid: 1, port: 1, token }, [], 1000)).toBeNull();
    expect(await handOff({ pid: process.pid, port, token: 'wrong' }, [])).toBeNull();
  });
});

describe('stopping a running Delta', () => {
  it('recognises a Delta server, and nothing else, on a port', async () => {
    expect(await answersAsDelta(port)).toBe(true);
    const other = createServer((_q, r) => r.end('not delta'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    expect(await answersAsDelta((other.address() as AddressInfo).port)).toBe(false);
    other.close();
  });

  it('treats a runtime file for a process that has gone as not running, and removes it', async () => {
    writeRuntime(dir, { pid: 2 ** 22 + 12345, port: 7010, token: 't' });
    expect(await stopRunning(dir, 7010)).toBe('not-running');
    expect(existsSync(runtimeFile(dir, 7010))).toBe(false);
  });

  it("refuses to stop a live process that isn't answering as Delta", async () => {
    writeRuntime(dir, { pid: process.pid, port: 1, token: 't' });
    expect(await stopRunning(dir, 1)).toBe('not-delta');
  });
});
