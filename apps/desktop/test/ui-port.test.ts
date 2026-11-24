// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_UI_PORT, findFreeUiPort, UI_HOST, uiPortConfig } from '../dev/ui-port.ts';

const appDir = resolve(import.meta.dirname, '..');

function listen(port: number, host = UI_HOST): Promise<Server> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen({ port, host, exclusive: true }, () => done(server));
  });
}

const closeAll = (servers: Server[]) =>
  Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));

describe('dev server port', () => {
  it('is 5173 with fallback by default, exactly TESSERA_UI_PORT when set', () => {
    expect(uiPortConfig({})).toEqual({ port: DEFAULT_UI_PORT, strictPort: false });
    expect(uiPortConfig({ TESSERA_UI_PORT: '' })).toEqual({ port: DEFAULT_UI_PORT, strictPort: false });
    expect(uiPortConfig({ TESSERA_UI_PORT: '5199' })).toEqual({ port: 5199, strictPort: true });
    expect(() => uiPortConfig({ TESSERA_UI_PORT: 'abc' })).toThrow(/not a port/);
    expect(() => uiPortConfig({ TESSERA_UI_PORT: '70000' })).toThrow(/not a port/);
  });

  it('finds the next free port when one is taken (bun run tauri:dev)', async () => {
    const base = 46_100 + Math.floor(Math.random() * 500);
    const start = await findFreeUiPort(base);
    const held = [await listen(start)];
    try {
      const next = await findFreeUiPort(start);
      expect(next).toBeGreaterThan(start);
      held.push(await listen(next));
      expect(await findFreeUiPort(start)).toBeGreaterThan(next);
    } finally {
      await closeAll(held);
    }
    await expect(findFreeUiPort(start, UI_HOST, 0)).rejects.toThrow(/no free port/);
  });
});

describe('two checkouts’ default dev servers', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGTERM');
  });

  function startVite(): Promise<number> {
    const env: NodeJS.ProcessEnv = { ...process.env, TESSERA_RUNTIME: 'none', NO_COLOR: '1' };
    delete env.TESSERA_UI_PORT;
    const child = spawn(resolve(appDir, 'node_modules/.bin/vite'), ['--clearScreen', 'false'], {
      cwd: appDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    return new Promise((done, fail) => {
      let out = '';
      const onData = (chunk: Buffer) => {
        out += chunk.toString();
        const m = /Local:\s+http:\/\/localhost:(\d+)\//.exec(out);
        if (m) done(Number(m[1]));
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => fail(new Error(`vite exited (${String(code)}):\n${out}`)));
    });
  }

  it('both start, on different ports', async () => {
    const first = await startVite();
    const second = await startVite();
    expect(first).toBeGreaterThanOrEqual(DEFAULT_UI_PORT);
    expect(second).not.toBe(first);
  });
});
