import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';
import { chatgpt } from 'e2e/oauth/chatgpt';
import { openRuntimeTool } from './e2e/agent/support/open-runtime-tool.ts';
import { replayOnly } from './e2e/agent/support/replay-only.ts';

const ci = !['', '0', 'false'].includes((process.env.CI ?? '').trim().toLowerCase());

const RECORDED_PORT = '47231';
const port = process.env.TESSERA_E2E_AGENT_PORT ?? RECORDED_PORT;
if (!/^\d+$/.test(port)) throw new Error(`TESSERA_E2E_AGENT_PORT must be a port number, got ${port}`);

/** The e2e runner passes the app command only PATH, HOME and the temp variables. */
const passEnv = [
  'TESSERA_TEST_RUNTIME_BIN',
  'TESSERA_TEST_MARKET',
  'CARGO_TARGET_DIR',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'RUSTUP_TOOLCHAIN',
  'RUSTC_WRAPPER',
  'SCCACHE_DIR',
] as const;
const appEnv: Record<string, string> = {};
for (const name of passEnv) {
  const value = process.env[name];
  if (value !== undefined) appEnv[name] = value;
}

const context = [
  'The app is Tessera, a futures trading workspace; here its market data comes from a test connection.',
  'The left sidebar lists the areas Trade, Research, Journal and Connections; Settings opens from the "Account" button at its foot (or Ctrl+,), and Agents from the command palette ("Open Agents").',
  'On Trade the stage bar over the charts shows the active chart: its symbol button (accessible name "Symbol …", it opens the command palette) and a Timeframe group of buttons.',
  'Each chart tile is a region named after its symbol and timeframe ("NQ Z6 5m"); its header has a symbol button and a timeframe menu button ("Timeframe …").',
  "The command palette (Ctrl+K, or the stage bar's symbol button) searches symbols and commands.",
  'Never place, arm or approve orders.',
].join(' ');

const COLD_RUNTIME_BUILD_MS = 15 * 60_000;

const engine = web({ viewport: { width: 1600, height: 1000 } });

export default {
  projectId: 'tessera',
  tests: ['e2e/agent/**/*.e2e.ts'],
  targets: [
    {
      name: 'web',
      engine,
      app: {
        url: `http://127.0.0.1:${port}`,
        readyUrl: 'http://127.0.0.1:{port}/healthz',
        identity: 'tessera-served-demo',
        command: {
          executable: 'node',
          args: ['e2e/agent/support/serve.ts', '--port', '{port}'],
          env: appEnv,
          startupTimeout: COLD_RUNTIME_BUILD_MS,
          log: '.e2e/logs/runtime.log',
        },
      },
    },
  ],
  workers: 1,
  trace: 'retain-on-failure',
  reporters: ['list', 'junit'],
  agents: {
    default: ci
      ? { executor: replayOnly, context }
      : { model: chatgpt('gpt-6-luna'), context, tools: { open_runtime: openRuntimeTool(engine) } },
  },
  cache: ci ? { mode: 'read-only', strict: true } : { mode: port === RECORDED_PORT ? 'read-write' : 'read-only' },
} satisfies E2EConfig;
