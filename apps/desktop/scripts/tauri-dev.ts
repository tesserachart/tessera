/** A changed `devUrl` (`tauri dev --config`) rebuilds the shell crate. */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { EXPECT_CHECKOUT_ENV, resolveRuntimeBinary } from '../dev/runtime-bin.ts';
import { devRuntimeEnv, legacyDevDataNote, loginWords } from '../dev/runtime-env.ts';
import { launcherExitStatus } from '../dev/exit-status.ts';
import { DEFAULT_UI_PORT, findFreeUiPort, uiPortConfig } from '../dev/ui-port.ts';

const repo = resolve(import.meta.dirname, '../../..');
const { env, dataDir, rithmicCredentials } = devRuntimeEnv(repo);
const legacy = process.env.TESSERA_DATA_DIR ? null : legacyDevDataNote();
if (legacy) console.info(`[tauri-dev] ${legacy}`);

try {
  const resolved = resolveRuntimeBinary(repo, { env });
  env.TESSERA_RUNTIME_BIN = resolved.path;
  if (resolved.source === 'cargo') env[EXPECT_CHECKOUT_ENV] = repo;
} catch (err) {
  console.error(`[tauri-dev] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
console.info(`[tauri-dev] runtime ${env.TESSERA_RUNTIME_BIN}`);
console.info(`[tauri-dev] runtime: ${loginWords(rithmicCredentials)}, data in ${dataDir}`);

let port: number;
try {
  const pinned = uiPortConfig(env);
  port = pinned.strictPort ? pinned.port : await findFreeUiPort(DEFAULT_UI_PORT);
} catch (err) {
  console.error(`[tauri-dev] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
env.TESSERA_UI_PORT = String(port);
const devArgs: string[] = [];
if (port !== DEFAULT_UI_PORT) {
  devArgs.push('--config', JSON.stringify({ build: { devUrl: `http://localhost:${String(port)}` } }));
  console.info(
    `[tauri-dev] port ${String(DEFAULT_UI_PORT)} is taken (another checkout's dev server?); Vite and the shell use ${String(port)}`,
  );
}
env.TESSERA_WEBVIEW_DATA_DIR ??= join(dataDir, 'webview');
console.info(`[tauri-dev] UI on http://localhost:${String(port)}, webview data in ${env.TESSERA_WEBVIEW_DATA_DIR}`);

const tauri = spawn('tauri', ['dev', ...devArgs, ...process.argv.slice(2)], { env, stdio: 'inherit' });
let stopSignal: NodeJS.Signals | null = null;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopSignal ??= signal;
    tauri.kill(signal);
  });
}
tauri.on('exit', (code, signal) => process.exit(launcherExitStatus(stopSignal, code, signal)));
