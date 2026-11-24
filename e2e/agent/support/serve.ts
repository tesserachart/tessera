import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { askRuntimeToExit, resolveRuntimeBinary, TEST_RUNTIME } from '../../../apps/desktop/dev/runtime-bin.ts';
import { runtimeInfoPath } from './runtime.ts';

const repo = resolve(import.meta.dirname, '../../..');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? process.argv[portArg + 1] : undefined;
if (!port || !/^\d+$/.test(port)) {
  console.error('serve: usage: node e2e/agent/support/serve.ts --port <port> (the e2e runner passes {port})');
  process.exit(2);
}
const uiDir = join(repo, 'apps/desktop/dist');
if (!existsSync(join(uiDir, 'index.html'))) {
  console.error(`serve: built UI not found at ${uiDir}; run \`bun run build\` (bun run e2e:agent does it first).`);
  process.exit(2);
}
let bin: string;
let source: string;
try {
  ({ path: bin, source } = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }));
} catch (err) {
  console.error(`serve: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), 'tessera-e2e-agent-data-'));
const infoPath = runtimeInfoPath(port);
const cleanup = () => {
  rmSync(infoPath, { force: true });
  rmSync(dataDir, { recursive: true, force: true });
};
process.once('exit', cleanup);

const args = ['serve', '--port', port, '--ui-dir', uiDir, '--data-dir', dataDir, '--launch-tickets'];
console.info(`serve: test runtime ${bin} (${source}), data in ${dataDir}`);
const child = spawn(bin, args, { cwd: repo, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });

let info: { origin: string; token: string; ticket: string | null } | null = null;
createInterface({ input: child.stdout }).on('line', (line) => {
  let msg: { event?: string; port?: number; token?: string; ticket?: string };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return;
  }
  if (msg.event === 'ready' && typeof msg.port === 'number' && typeof msg.token === 'string') {
    info = { origin: `http://127.0.0.1:${String(msg.port)}`, token: msg.token, ticket: null };
    rmSync(infoPath, { force: true });
    writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600, flag: 'wx' });
    console.info(`serve: ready on ${info.origin}`);
  } else if (msg.event === 'launch' && typeof msg.ticket === 'string' && info) {
    info.ticket = msg.ticket;
    writeFileSync(infoPath, JSON.stringify(info));
  }
});
child.on('exit', (code, signal) => {
  console.info(`serve: runtime exited (${signal ?? String(code)})`);
  process.exit(code ?? 1);
});
const stop = () => {
  askRuntimeToExit(child);
  setTimeout(() => child.kill('SIGTERM'), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
