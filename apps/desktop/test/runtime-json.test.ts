// @vitest-environment node
import { request } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { announceLaunchLink, LAUNCH_LINK_FILE, launchLink } from '../dev/launch-link.ts';
import { tesseraRuntime } from '../dev/runtime-plugin.ts';

const TOKEN = `tss_${'f'.repeat(64)}`;
const TICKET = `tst_${'c'.repeat(64)}`;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(port: number, path: string, headers: Record<string, string>, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the dev server never hands out the token', () => {
  let server: ViteDevServer;
  let port = 0;
  let root = '';
  let dataDir = '';
  const said: string[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'tessera-vite-'));
    dataDir = join(root, 'data');
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
    const bin = join(root, 'runtime');
    writeFileSync(
      bin,
      `#!/bin/sh\necho '{"event":"ready","port":1,"token":"${TOKEN}","version":"0"}'\n` +
        `echo '{"event":"launch","ticket":"${TICKET}"}'\nexec cat > /dev/null\n`,
    );
    chmodSync(bin, 0o755);
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      said.push(args.map(String).join(' '));
    });
    server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      server: { host: 'localhost', port: 0, strictPort: false, ws: false },
      plugins: [
        tesseraRuntime(root, {
          terminal: false,
          env: { TESSERA_RUNTIME: 'bin', TESSERA_RUNTIME_BIN: bin, TESSERA_DATA_DIR: dataDir },
        }),
      ],
    });
    await server.listen();
    const addr = server.httpServer?.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(existsSync(join(dataDir, LAUNCH_LINK_FILE))).toBe(true);
    });
  });

  afterAll(async () => {
    await server.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const own = () => `localhost:${String(port)}`;

  it('says where the runtime is, never its token, whatever the request claims to be', async () => {
    const asked: Record<string, string>[] = [
      { host: own(), origin: `http://${own()}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
      { host: own(), 'sec-fetch-site': 'none' },
      { host: own() },
      { host: own(), origin: 'http://127.0.0.1:8899', 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of asked) {
      const r = await send(port, '/runtime.json', headers);
      expect(r.status, JSON.stringify(headers)).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ port: 1, url: 'ws://127.0.0.1:1/ws' });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['cache-control']).toBe('no-store');
    }
    // Vite itself refuses a Host it does not allow.
    const rebound = await send(port, '/runtime.json', { host: `attacker.example:${String(port)}` });
    expect(rebound.status).toBe(403);
  });

  it('grants no CORS and refuses framing', async () => {
    const pre = await send(
      port,
      '/runtime.json',
      { host: own(), origin: 'http://127.0.0.1:8899', 'access-control-request-method': 'GET' },
      'OPTIONS',
    );
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const page = await send(port, '/', { host: own(), origin: 'http://127.0.0.1:8899' });
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('hands the launch link, a ticket, to a file only the developer can read, and prints only its path', () => {
    const file = join(dataDir, LAUNCH_LINK_FILE);
    expect(readFileSync(file, 'utf8').trim()).toBe(`http://localhost:${String(port)}/#ticket=${TICKET}`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(said.some((l) => l.includes(file))).toBe(true);
    const printed = said.join('\n');
    expect(printed).not.toContain(TOKEN.slice(4));
    expect(printed).not.toContain(TICKET.slice(4));
  });

  it('never passes the token on: not in the link, not in anything it serves', async () => {
    expect(readFileSync(join(dataDir, LAUNCH_LINK_FILE), 'utf8')).not.toContain(TOKEN.slice(4));
    const r = await send(port, '/runtime.json', { host: own() });
    expect(r.body).not.toContain(TOKEN.slice(4));
    expect(r.body).not.toContain(TICKET.slice(4));
  });
});

describe('an external runtime', () => {
  it('is served as where it is, without anything else its URL carried', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tessera-vite-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      server: { host: 'localhost', port: 0, strictPort: false, ws: false },
      plugins: [
        tesseraRuntime(root, {
          env: {
            TESSERA_RUNTIME: 'external',
            TESSERA_RUNTIME_URL: `ws://user:pw@127.0.0.1:7420/ws?token=${TOKEN}`,
            TESSERA_DATA_DIR: join(root, 'data'),
          },
        }),
      ],
    });
    try {
      await server.listen();
      const addr = server.httpServer?.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const r = await send(port, '/runtime.json', { host: `localhost:${String(port)}` });
      expect(JSON.parse(r.body)).toEqual({ port: 7420, url: 'ws://127.0.0.1:7420/ws' });
    } finally {
      await server.close();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the launch link', () => {
  it('carries a ticket in the fragment, which no server receives', () => {
    expect(launchLink('http://127.0.0.1:7420/', 'tst_ab')).toBe('http://127.0.0.1:7420/#ticket=tst_ab');
  });

  it('is printed to a terminal and written nowhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessera-link-'));
    const lines: string[] = [];
    expect(announceLaunchLink('http://x/#ticket=t', dir, true, (l) => lines.push(l))).toEqual({ printed: true });
    expect(lines).toEqual(['open http://x/#ticket=t']);
    expect(existsSync(join(dir, LAUNCH_LINK_FILE))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces an earlier file whatever its mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessera-link-'));
    const file = join(dir, LAUNCH_LINK_FILE);
    writeFileSync(file, 'old', { mode: 0o644 });
    announceLaunchLink('http://x/#ticket=new', dir, false, () => undefined);
    expect(readFileSync(file, 'utf8')).toBe('http://x/#ticket=new\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
