// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { rustNumber } from './support/rust.ts';
import { tesseraRuntime } from '../dev/runtime-plugin.ts';
import {
  EXIT_DATA_DIR_LOCKED,
  EXIT_OTHER_CHECKOUT,
  failedStatus,
  startingStatus,
  unavailableBody,
} from '../dev/runtime-status.ts';

const LOCKED =
  'tessera-runtime: data directory /home/u/.local/share/tessera-dev/repo-1234abcd is in use by another ' +
  'tessera-runtime (pid 4242); stop that runtime, or give this one its own directory with --data-dir or TESSERA_DATA_DIR';

const runtimeExitCode = (file: string, name: string) => rustNumber(`tessera-runtime/src/${file}`, name);

describe('runtime status', () => {
  it('reads the exit codes tessera-runtime serve declares', () => {
    expect(EXIT_DATA_DIR_LOCKED).toBe(runtimeExitCode('lock.rs', 'EXIT_DATA_DIR_LOCKED'));
    expect(EXIT_OTHER_CHECKOUT).toBe(runtimeExitCode('build_source.rs', 'EXIT_OTHER_CHECKOUT'));
  });

  it('names the data directory and the holder’s pid when the directory is locked', () => {
    const s = failedStatus(EXIT_DATA_DIR_LOCKED, 'exit 3', `\x1b[1m\x1b[31m${LOCKED}\x1b[0m\n`);
    expect(s.state).toBe('data_dir_locked');
    expect(s.message).toContain('repo-1234abcd is in use by another tessera-runtime (pid 4242)');
    expect(s.message).not.toContain('\x1b');
    expect(s.message).not.toMatch(/tessera-runtime: data/);
    expect(s.message).toContain('keeps retrying');
  });

  it('says when cargo handed the dev server another checkout’s build', () => {
    const line =
      'tessera-runtime: this binary was built from the checkout /w/feature, not from /w/main ' +
      '(TESSERA_EXPECT_CHECKOUT). The two checkouts share a cargo target directory (CARGO_TARGET_DIR), …';
    const s = failedStatus(EXIT_OTHER_CHECKOUT, 'exit 4', `${line}\n`);
    expect(s.state).toBe('failed');
    expect(s.message).toContain('built from the checkout /w/feature, not from /w/main');
    expect(s.message).toContain('CARGO_TARGET_DIR');
    expect(s.message).not.toMatch(/tessera-runtime: this/);
  });

  it('points at the terminal for any other failed start', () => {
    const s = failedStatus(101, 'exit 101', 'error[E0425]: cannot find value `x`');
    expect(s.state).toBe('failed');
    expect(s.message).toContain('exit 101');
    expect(s.message).toContain('bun run dev terminal');
    expect(startingStatus('cargo').message).toContain('cargo');
    expect(JSON.parse(unavailableBody(s))).toEqual({
      error: 'runtime unavailable',
      state: 'failed',
      message: s.message,
    });
  });
});

function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: 'localhost',
        port,
        path,
        headers: { host: `localhost:${String(port)}`, 'sec-fetch-site': 'same-origin' },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('/runtime.json while the runtime cannot start', () => {
  let server: ViteDevServer | null = null;
  let root = '';

  afterAll(async () => {
    await server?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('answers 503 with the lock message instead of a bare “starting”', async () => {
    root = mkdtempSync(join(tmpdir(), 'tessera-vite-status-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
    const bin = join(root, 'locked-runtime.sh');
    writeFileSync(bin, `#!/bin/sh\necho '${LOCKED}' >&2\nexit 3\n`);
    chmodSync(bin, 0o755);
    server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      server: { host: 'localhost', port: 0, strictPort: false, ws: false },
      plugins: [
        tesseraRuntime(root, {
          env: {
            TESSERA_RUNTIME: 'bin',
            TESSERA_RUNTIME_BIN: bin,
            TESSERA_DATA_DIR: join(root, 'data'),
            PATH: process.env.PATH,
          },
        }),
      ],
    });
    await server.listen();
    const addr = server.httpServer?.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const answer = await vi.waitFor(
      async () => {
        const polled = await getJson(port, '/runtime.json');
        expect(polled.body).toMatchObject({ state: 'data_dir_locked' });
        return polled;
      },
      { interval: 100 },
    );
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ state: 'data_dir_locked' });
    expect((answer.body as { message: string }).message).toContain('in use by another tessera-runtime (pid 4242)');
  });
});
