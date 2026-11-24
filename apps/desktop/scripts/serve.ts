import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { announceLaunchLink, launchLink, retireLaunchLink, type Announced } from '../dev/launch-link.ts';
import { askRuntimeToExit, EXPECT_CHECKOUT_ENV, resolveRuntimeBinary } from '../dev/runtime-bin.ts';
import { devRuntimeEnv, legacyDevDataNote, loginWords } from '../dev/runtime-env.ts';

const repo = resolve(import.meta.dirname, '../../..');
const uiDir = join(repo, 'apps/desktop/dist');
if (!existsSync(join(uiDir, 'index.html'))) {
  console.error(`[serve] built UI not found at ${uiDir}; run \`bun run build\` (bun run serve does it first).`);
  process.exit(2);
}

const { env, dataDir, rithmicCredentials } = devRuntimeEnv(repo);
const legacy = process.env.TESSERA_DATA_DIR ? null : legacyDevDataNote();
if (legacy) console.info(`[serve] ${legacy}`);
let bin: string;
try {
  const resolved = resolveRuntimeBinary(repo, { env, quiet: true });
  bin = resolved.path;
  if (resolved.source === 'cargo') env[EXPECT_CHECKOUT_ENV] = repo;
} catch (err) {
  console.error(`[serve] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
const extra = process.argv.slice(2).filter((a) => a !== '--');
const args = [
  'serve',
  '--ui-dir',
  uiDir,
  '--launch-tickets',
  ...(extra.includes('--port') ? [] : ['--port', '0']),
  ...extra,
];
console.info(`[serve] runtime ${bin}`);
const child = spawn(bin, args, { cwd: repo, env, stdio: ['pipe', 'pipe', 'inherit'] });
let announced: Announced | null = null;
let origin: string | null = null;

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg: { event?: string; port?: number; ticket?: string };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return;
  }
  if (msg.event === 'ready' && typeof msg.port === 'number') {
    origin = `http://127.0.0.1:${String(msg.port)}`;
    console.info(`[serve] runtime with ${loginWords(rithmicCredentials)}, data in ${dataDir}`);
    console.info(
      '[serve] each link lets one page in; its reloads, pop-outs and tabs opened beside it keep the session, and the next link follows. Ctrl-C stops the runtime.',
    );
  } else if (msg.event === 'launch' && typeof msg.ticket === 'string' && origin) {
    retireLaunchLink(announced);
    const link = launchLink(origin, msg.ticket);
    announced = announceLaunchLink(link, dataDir, process.stdout.isTTY, (l) => console.info(`[serve] ${l}`));
  }
});
child.on('exit', (code, signal) => {
  retireLaunchLink(announced);
  console.info(`[serve] runtime exited (${signal ?? String(code)})`);
  process.exit(code ?? 1);
});
const stop = () => {
  askRuntimeToExit(child);
  setTimeout(() => child.kill('SIGTERM'), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
