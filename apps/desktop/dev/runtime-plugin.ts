import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Plugin } from 'vite';
import { announceLaunchLink, launchLink, retireLaunchLink, type Announced } from './launch-link.ts';
import { RestartPolicy } from './restart-policy.ts';
import { askRuntimeToExit, cargoTargetDir, claimTargetDir, EXPECT_CHECKOUT_ENV } from './runtime-bin.ts';
import { devRuntimeEnv, legacyDevDataNote, loginWords } from './runtime-env.ts';
import {
  EXIT_DATA_DIR_LOCKED,
  failedStatus,
  startingStatus,
  unavailableBody,
  type RuntimeStatus,
} from './runtime-status.ts';

interface RuntimeInfo {
  port: number;
  url: string;
}

type Mode = 'cargo' | 'bin' | 'external' | 'none';

const READY_TIMEOUT_MS = 15 * 60_000;
const MAX_EARLY_OUTPUT = 256 * 1024;
const TERM_AFTER_MS = 1500;
const KILL_AFTER_MS = 10_000;

function parseLine(line: string): { port: number } | { ticket: string } | null {
  try {
    const v = JSON.parse(line) as { event?: unknown; port?: unknown; ticket?: unknown };
    if (v.event === 'ready' && typeof v.port === 'number') return { port: v.port };
    if (v.event === 'launch' && typeof v.ticket === 'string') return { ticket: v.ticket };
  } catch {}
  return null;
}

export interface TesseraRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  terminal?: boolean;
}

export function tesseraRuntime(repoRoot: string, options: TesseraRuntimeOptions = {}): Plugin {
  const env = options.env ?? process.env;
  const terminal = options.terminal ?? process.stdout.isTTY;
  let child: ChildProcess | null = null;
  let info: RuntimeInfo | null = null;
  let announce: (ticket: string) => void = () => undefined;
  let announced: Announced | null = null;
  let status: RuntimeStatus = startingStatus('cargo');
  let stopping = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let sourceWatch: FSWatcher | null = null;
  const policy = new RestartPolicy();
  const log = (msg: string) => {
    console.info(`\x1b[2m[tessera-runtime]\x1b[0m ${msg}`);
  };

  const pickMode = (): Mode => {
    const mode = (env.TESSERA_RUNTIME ?? 'auto').toLowerCase();
    if (mode === 'cargo' || mode === 'bin' || mode === 'external' || mode === 'none') return mode;
    if (mode !== 'auto') log(`unknown TESSERA_RUNTIME=${mode}; using cargo`);
    return 'cargo';
  };

  const start = (mode: Mode) => {
    if (mode === 'external') {
      const given = env.TESSERA_RUNTIME_URL;
      if (!given) {
        log('TESSERA_RUNTIME=external needs TESSERA_RUNTIME_URL');
        status = {
          state: 'failed',
          message: 'TESSERA_RUNTIME=external needs TESSERA_RUNTIME_URL (see the dev terminal).',
        };
        return;
      }
      const u = new URL(given);
      info = { port: Number(u.port || 80), url: `${u.protocol}//${u.host}${u.pathname}` };
      log(
        `using external runtime at ${u.host}: open a launch link its own launcher printed, on this server ` +
          '(…/#ticket=…)',
      );
      return;
    }
    const launch = devRuntimeEnv(repoRoot, env);
    const serve = ['serve', '--port', '0', '--data-dir', launch.dataDir, '--launch-tickets'];
    const bin = env.TESSERA_RUNTIME_BIN;
    if (mode === 'bin' && !bin) {
      log('TESSERA_RUNTIME=bin needs TESSERA_RUNTIME_BIN');
      status = { state: 'failed', message: 'TESSERA_RUNTIME=bin needs TESSERA_RUNTIME_BIN (see the dev terminal).' };
      return;
    }
    if (mode === 'cargo') {
      try {
        claimTargetDir(repoRoot, cargoTargetDir(repoRoot, launch.env));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log(`not starting the runtime: ${reason}. Fix it, then press r + Enter.`);
        status = { state: 'failed', message: `The runtime cannot start: ${reason}` };
        return;
      }
      launch.env[EXPECT_CHECKOUT_ENV] = repoRoot;
    }
    const [cmd, args]: [string, string[]] =
      mode === 'bin' && bin ? [bin, serve] : ['cargo', ['run', '-p', 'tessera-runtime', '--quiet', '--', ...serve]];
    log(`starting ${mode} runtime (${loginWords(launch.rithmicCredentials)}, data in ${launch.dataDir})…`);
    const spawned = mode === 'bin' ? 'bin' : 'cargo';
    status = startingStatus(spawned);
    const color = process.stderr.isTTY ? { CARGO_TERM_COLOR: 'always' } : {};
    const proc = spawn(cmd, args, {
      cwd: repoRoot,
      env: { ...launch.env, ...color },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = proc;
    let ready = false;
    let early = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      if (ready) process.stderr.write(chunk);
      else if (early.length < MAX_EARLY_OUTPUT) early += chunk.toString();
    });
    const timeout = setTimeout(() => {
      if (!info) log(`no ready line after ${String(READY_TIMEOUT_MS / 60_000)} min; still waiting`);
    }, READY_TIMEOUT_MS);
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const r = parseLine(line);
      if (r && 'port' in r) {
        clearTimeout(timeout);
        if (policy.consecutiveFailures > 0) log('the runtime starts again');
        policy.ready();
        ready = true;
        if (early) process.stderr.write(early);
        early = '';
        info = { port: r.port, url: `ws://127.0.0.1:${String(r.port)}/ws` };
        log(`ready on 127.0.0.1:${String(r.port)} (${mode})`);
      } else if (r) {
        announce(r.ticket);
      }
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (child === proc) child = null;
      info = null;
      retireLaunchLink(announced);
      announced = null;
      if (stopping) return;
      const how = signal ?? `exit ${String(code)}`;
      status = ready ? startingStatus(spawned) : failedStatus(code, how, early);
      const { delayMs, repeated } = ready ? policy.exitedAfterReady() : policy.failedBeforeReady(early);
      const wait = `${String(delayMs / 1000)}s`;
      if (ready) {
        log(`runtime exited (${how}); restarting in ${wait}`);
      } else if (code === EXIT_DATA_DIR_LOCKED) {
        if (!repeated && early) process.stderr.write(early);
        log(
          `another runtime holds the data directory ${launch.dataDir} (see above); retrying in ${wait}. ` +
            'Stop it, or give this dev server its own directory with TESSERA_DATA_DIR.',
        );
      } else if (repeated) {
        log(`runtime still fails to start with the same output (${how}); retrying in ${wait}`);
      } else {
        if (early) process.stderr.write(early);
        log(
          `runtime failed to start (${how}); retrying in ${wait}. Fix the error and save${
            mode === 'cargo' ? ' (a change under crates/ retries at once)' : ''
          }, or press r + Enter to restart the dev server now.`,
        );
      }
      restartTimer = setTimeout(() => restart(mode), delayMs);
      if (!ready && mode === 'cargo') watchSources(mode);
    });
  };

  const restart = (mode: Mode) => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    sourceWatch?.close();
    sourceWatch = null;
    if (!stopping) start(mode);
  };

  const watchSources = (mode: Mode) => {
    if (sourceWatch) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    try {
      sourceWatch = watch(join(repoRoot, 'crates'), { recursive: true }, (_event, file) => {
        if (!file || !/\.rs$|Cargo\.toml$/.test(file)) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          log(`${file} changed; retrying now`);
          restart(mode);
        }, 300);
      });
      sourceWatch.on('error', () => {
        sourceWatch?.close();
        sourceWatch = null;
      });
    } catch {
      sourceWatch = null;
    }
  };

  const stop = (): Promise<boolean> => {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    sourceWatch?.close();
    sourceWatch = null;
    const c = child;
    const running = c !== null && c.exitCode === null && c.signalCode === null;
    if (!running) return Promise.resolve(true);
    return new Promise((resolve) => {
      const term = setTimeout(() => c.kill('SIGTERM'), TERM_AFTER_MS);
      const kill = setTimeout(() => {
        c.kill('SIGKILL');
        resolve(false);
      }, KILL_AFTER_MS);
      term.unref();
      kill.unref();
      c.once('exit', () => {
        clearTimeout(term);
        clearTimeout(kill);
        resolve(true);
      });
      askRuntimeToExit(c);
    });
  };
  let onSignal: (() => void) | null = null;

  let cleanStop = true;

  return {
    name: 'tessera-runtime',
    apply: 'serve',
    async closeServer() {
      if (onSignal) {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        onSignal = null;
      }
      cleanStop = await stop();
      retireLaunchLink(announced);
      announced = null;
    },
    config() {
      return {
        server: {
          // Vite's default CORS reflects every localhost Origin, on every route.
          cors: false,
          headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
        },
      };
    },
    configureServer(server) {
      if (env.VITEST) return;
      onSignal = () => {
        process.exitCode = 0; // Vite's SIGTERM handler keeps an exit code that is already set
        server.close().then(
          () => process.exit(cleanStop ? 0 : 1),
          () => process.exit(1),
        );
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      const mode = pickMode();
      if (mode === 'none') return;
      if ((mode === 'cargo' || mode === 'bin') && !env.TESSERA_DATA_DIR) {
        const note = legacyDevDataNote(env);
        if (note) log(note);
      }
      const listeningPort = (): number => {
        const addr = server.httpServer?.address();
        return typeof addr === 'object' && addr ? addr.port : server.config.server.port;
      };
      const linkDir = devRuntimeEnv(repoRoot, env).dataDir;
      announce = (ticket) => {
        const hand = () => {
          retireLaunchLink(announced);
          const origin = server.resolvedUrls?.local[0] ?? `http://localhost:${String(listeningPort())}`;
          announced = announceLaunchLink(launchLink(origin, ticket), linkDir, terminal, log);
        };
        if (server.httpServer?.listening) hand();
        else server.httpServer?.once('listening', hand);
      };
      start(mode);
      process.once('exit', () => {
        retireLaunchLink(announced);
        void stop();
      });
      server.middlewares.use('/runtime.json', (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        if (!info) {
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json');
          res.end(req.method === 'HEAD' ? undefined : unavailableBody(status));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(info));
      });
    },
  };
}
