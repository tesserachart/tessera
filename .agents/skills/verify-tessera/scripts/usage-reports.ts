#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';
import { chromium, type Page } from 'playwright';
import { resolveRuntimeBinary, TEST_RUNTIME } from '../../../../apps/desktop/dev/runtime-bin.ts';

const args = process.argv.slice(2);
const forward = args.includes('--forward');
const [out = '.e2e/artifacts/verify/usage-reports', uiDir] = args.filter((a) => !a.startsWith('--'));
const key = forward ? process.env.TESSERA_POSTHOG_KEY : 'phc_sim_stand_in';
if (!key) {
  console.error('usage: usage-reports.ts [evidence dir] [ui dir] [--forward]; --forward needs TESSERA_POSTHOG_KEY');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const dir = resolve(out);
mkdirSync(join(dir, 'replay'), { recursive: true });

const INGEST = 'https://eu.i.posthog.com';
const ASSETS = 'https://eu-assets.i.posthog.com';
const QUESTION = 'Is NQ above its session open? My Paper 2 account is long one.';
const GROUP = 'Evals';
const SURVEY = {
  id: 'stand-in-survey',
  name: 'Alpha: how would you feel without Tessera',
  type: 'api',
  start_date: '2026-11-01T00:00:00Z',
  end_date: null,
  questions: [
    {
      id: 'q1',
      type: 'single_choice',
      question: 'How would you feel if you could no longer use Tessera?',
      choices: ['Very disappointed', 'Somewhat disappointed', 'Not disappointed'],
    },
    { id: 'q2', type: 'open', question: 'What is the one thing Tessera should do better?', optional: true },
  ],
};

type Json = Record<string, unknown>;

const POSTHOG_PATHS = /^\/(batch|e|i\/v0\/e|s|i\/v1\/logs|flags|array|api\/surveys)\b/;

interface Sent {
  method: string;
  path: string;
  status: number;
  answeredBy: 'posthog' | 'stand-in';
  sent: unknown;
}

const sent: Sent[] = [];

function postedEvents(): { name: string; status: number; properties: Json }[] {
  return sent
    .filter((s) => s.method === 'POST' && /^\/(batch|i\/v0\/e)/.test(s.path))
    .flatMap((s) => {
      const body = s.sent as { batch?: Json[] } | Json[] | Json;
      const list = Array.isArray(body) ? body : ((body as { batch?: Json[] }).batch ?? [body as Json]);
      return list.map((e) => ({ name: String(e.event), status: s.status, properties: (e.properties ?? {}) as Json }));
    });
}

const crashReports = () => postedEvents().filter((e) => e.name === '$exception').length;

function decoded(body: Buffer, encoding: string | undefined): unknown {
  if (body.length === 0) return null;
  try {
    const raw = encoding === 'gzip' || (body[0] === 0x1f && body[1] === 0x8b) ? gunzipSync(body) : body;
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return `<${String(body.length)} bytes>`;
  }
}

function standIn(path: string, answer: Json | null): Json | null {
  if (path.startsWith('/array/')) {
    const config = answer ?? {};
    return config.sessionRecording ? null : { ...config, sessionRecording: { endpoint: '/s/' } };
  }
  if (path.startsWith('/api/surveys')) {
    const surveys = (answer?.surveys as unknown[] | undefined) ?? [];
    return surveys.length > 0 ? null : { surveys: [SURVEY] };
  }
  if (path.startsWith('/flags')) {
    const flags = (answer?.flags as Json | undefined) ?? {};
    return { ...answer, flags: { ...flags, 'analyst-trading-sessions': { key: 'analyst-trading-sessions', enabled: false } } };
  }
  return answer ?? { status: 1 };
}

async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = req.url ?? '/';
  if (path.startsWith('/__replay/')) {
    const file = path.slice('/__replay/'.length);
    const body = file === 'rrweb.js' ? readFileSync(join(repo, 'apps/desktop/node_modules/posthog-js/dist/rrweb.js')) : readFileSync(join(dir, 'replay', file));
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(body);
    return;
  }
  if (!POSTHOG_PATHS.test(path)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  let status = 200;
  let fromPostHog: Json | null = null;
  if (forward) {
    const headers: Record<string, string> = {};
    for (const h of ['content-type', 'content-encoding', 'authorization']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const upstream = await fetch((path.startsWith('/array/') ? ASSETS : INGEST) + path, {
      method: req.method ?? 'GET',
      headers,
      ...(req.method === 'GET' ? {} : { body }),
    });
    status = upstream.status;
    const text = await upstream.text();
    try {
      fromPostHog = text ? (JSON.parse(text) as Json) : {};
    } catch {
      fromPostHog = { text };
    }
  }
  const stood = standIn(path, fromPostHog);
  sent.push({
    method: req.method ?? 'GET',
    path: path.replace(/phc_[A-Za-z0-9_]+/g, 'phc_…'),
    status,
    answeredBy: forward && stood === fromPostHog ? 'posthog' : 'stand-in',
    sent: decoded(body, req.headers['content-encoding'] as string | undefined),
  });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(stood ?? fromPostHog ?? {}));
}

const project = createServer((req, res) => void answer(req, res));
await new Promise<void>((done) => project.listen(0, '127.0.0.1', done));
const projectOrigin = `http://127.0.0.1:${String((project.address() as AddressInfo).port)}`;

const data = mkdtempSync(join(tmpdir(), 'tessera-usage-reports-'));
const bin = resolveRuntimeBinary(repo, { quiet: true, target: TEST_RUNTIME }).path;
const runtime = spawn(
  bin,
  ['serve', '--port', '0', '--ui-dir', uiDir || join(repo, 'apps/desktop/dist'), '--data-dir', data, '--launch-tickets'],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TESSERA_POSTHOG_KEY: key, TESSERA_POSTHOG_HOST: projectOrigin, TESSERA_TEST_CRASH: '1' },
  },
);
let ticket: string | null = null;
const ready = await new Promise<{ port: number; token: string }>((done, fail) => {
  runtime.once('exit', (code) => fail(new Error(`the sim runtime exited (${String(code)})`)));
  const seen: { port?: number; token?: string } = {};
  createInterface({ input: runtime.stdout }).on('line', (line) => {
    let m: { event?: string; ticket?: string; port?: number; token?: string };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      return;
    }
    if (m.event === 'launch' && m.ticket) ticket = m.ticket;
    Object.assign(seen, m);
    if (seen.port && seen.token) done({ port: seen.port, token: seen.token });
  });
});
const origin = `http://127.0.0.1:${String(ready.port)}`;
const stop = () => {
  runtime.kill('SIGTERM');
  project.close();
  rmSync(data, { recursive: true, force: true });
};

const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`);
await new Promise((done, fail) => {
  ws.onopen = done;
  ws.onerror = fail;
});
const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
  if (m.id !== undefined) waiting.get(m.id)?.(m);
};
let rpcId = 0;
const call = (method: string, params: unknown) =>
  new Promise<{ result?: unknown; error?: { message: string } }>((done) => {
    waiting.set(++rpcId, done);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }));
  });
await call('session.hello', { client: { name: 'usage-reports', version: '0', platform: 'node' }, protocolVersion: 1, token: ready.token });
async function tool<T>(name: string, input: unknown): Promise<T> {
  const answer = await call('tools.invoke', { name, input });
  if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
  const result = answer.result as { ok: boolean; output: T; error: { message: string } | null };
  if (!result.ok) throw new Error(`${name}: ${result.error?.message ?? 'refused'}`);
  return result.output;
}

const { dataSource } = await tool<{ dataSource: string }>('connections.list', {});
const { accounts } = await tool<{ accounts: { account: { id: string; environment: string; displayName: string } }[] }>(
  'portfolio.get_accounts',
  {},
);
if (dataSource !== 'mock' || accounts.some((a) => a.account.environment !== 'paper')) {
  console.error('refused: not the sim runtime');
  stop();
  process.exit(1);
}
const standIns = join(repo, '.agents/skills/verify-tessera/scripts');
await tool('settings.set', {
  key: 'agent.providers',
  value: {
    'claude-code': { enabled: true, binaryPath: join(standIns, 'stand-in-claude.mjs') },
    codex: { enabled: true, binaryPath: join(standIns, 'stand-in-codex.mjs') },
  },
});
await tool('agent.list_providers', { recheck: true });

const log = (...words: unknown[]) => console.info(new Date().toISOString().slice(11, 19), ...words);
const browser = await chromium.launch();
const page: Page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const outside: string[] = [];
page.on('request', (r) => {
  const host = new URL(r.url()).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && !r.url().startsWith('data:')) outside.push(r.url());
});
const shotAt = new Map<string, number>();
const shot = async (name: string) => {
  await page.screenshot({ path: join(dir, `${name}.png`) });
  if (!name.startsWith('failed-')) shotAt.set(name, Date.now());
};
const steps: Record<string, string> = {};
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    steps[name] = 'ok';
  } catch (e) {
    steps[name] = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'failed';
    await shot(`failed-${name}`);
  }
  log(name, steps[name]);
}
const open = async () => {
  const deadline = Date.now() + 60_000;
  while (!ticket && Date.now() < deadline) await page.waitForTimeout(100);
  const t = ticket;
  ticket = null;
  await page.goto(`${origin}/#ticket=${t ?? ''}`);
};
const areas = page.getByRole('navigation', { name: 'Areas' });
const area = async (name: string) => {
  await areas.getByRole('button', { name }).click();
  await page.waitForTimeout(2_000);
};

const until = async (done: () => boolean, why: string) => {
  const deadline = Date.now() + 30_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(why);
    await page.waitForTimeout(250);
  }
};
const firstRun = page.getByRole('dialog', { name: /One question before you go on|Before you start/ });

await open();
await step('crash-before-asking', async () => {
  await firstRun.waitFor({ timeout: 60_000 });
  await shot('first-run');
  await tool('sim.crash', {});
  await until(() => crashReports() > 0, 'no crash report reached PostHog before the first-run answer');
  const early = postedEvents().filter((e) => e.name !== '$exception');
  if (early.length > 0) throw new Error(`usage before the answer: ${early.map((e) => e.name).join(', ')}`);
});
await step('consent', async () => {
  const yes = firstRun.getByRole('radio', { name: 'Yes' });
  const no = firstRun.getByRole('radio', { name: 'No' });
  const go = firstRun.getByRole('button', { name: /Continue|Accept/ });
  if ((await yes.getAttribute('aria-checked', { timeout: 60_000 })) !== 'false') throw new Error('Yes is chosen in advance');
  if ((await no.getAttribute('aria-checked')) !== 'false') throw new Error('No is chosen in advance');
  if (await go.isEnabled()) throw new Error('Continue goes on without an answer');
  await yes.click();
  await go.click();
  await areas.waitFor({ timeout: 60_000 });
});
await step('return', async () => {
  await page.waitForTimeout(2_000);
  await open();
  await areas.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(8_000);
  await shot('desk');
});
await step('connection', async () => {
  await area('Settings');
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Connections' }).click();
  const list = page.getByRole('region', { name: 'Your connections' });
  await list.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: /^Rithmic…/ }).click();
  const form = page.getByRole('region', { name: 'Add a Rithmic login' }).getByRole('form', { name: 'Rithmic login' });
  await form.getByRole('button', { name: 'Firm' }).click();
  await page.getByRole('option', { name: 'Tessera Test' }).click();
  await form.getByRole('textbox', { name: 'User' }).fill('demo-trader');
  await form.getByRole('textbox', { name: 'Password' }).fill('demo');
  await form.getByRole('button', { name: 'Test and save' }).click();
  await list.getByRole('group', { name: /Tessera Test/ }).first().waitFor({ timeout: 30_000 });
  await shot('connections');
});
await step('order', async () => {
  await area('Desk');
  await page.getByRole('button', { name: /^Account: / }).first().click();
  await page.getByRole('menuitem').filter({ hasText: 'Paper 2' }).first().click();
  await page.waitForTimeout(1_000);
  await page.getByRole('group', { name: /orders$/ }).first().getByRole('button', { name: 'Buy market' }).click();
  await page.waitForTimeout(3_000);
  await shot('ordered');
});
await step('copier', async () => {
  await area('Trade copier');
  await page.getByRole('button', { name: 'New group' }).click();
  const form = page.getByRole('region', { name: 'New group' });
  await form.getByText('Paper 3').click();
  await form.getByLabel('Group name').fill(GROUP, { force: true });
  await form.getByRole('button', { name: 'Create' }).click({ force: true });
  await page.getByRole('switch', { name: `Copy ${GROUP}` }).first().click();
  await page.waitForTimeout(1_500);
  await shot('copier');
});
await step('areas', async () => {
  for (const name of ['Journal', 'Research', 'Markets']) {
    await area(name);
    await shot(`area-${name.toLowerCase()}`);
  }
});
await step('analyst', async () => {
  await area('Analyst');
  const box = page.getByRole('textbox', { name: 'Ask the analyst' }).first();
  await box.click();
  await box.fill(QUESTION);
  await page.keyboard.press('Enter');
  await page.getByText(/Stand-in answer/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2_000);
  await shot('analyst');
});
await step('survey-and-flag', async () => {
  await area('Settings');
  const nav = page.getByRole('navigation', { name: 'Settings' });
  await nav.getByRole('button', { name: 'App' }).click();
  const ask = page.getByRole('region', { name: 'A question from the team' });
  await ask.getByRole('radio', { name: 'Very disappointed' }).click({ timeout: 30_000 });
  await ask.getByRole('textbox').fill('Show why the copier skipped an order');
  await shot('survey');
  await ask.getByRole('button', { name: 'Send' }).click();
  await nav.getByRole('button', { name: 'Analyst' }).click();
  await page.waitForTimeout(1_500);
  if ((await page.getByRole('region', { name: 'Trading sessions' }).count()) > 0) throw new Error('the flag is off but Trading sessions shows');
  await shot('settings-analyst-flag-off');
});
await step('crash-reports-off', async () => {
  await area('Settings');
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'App' }).click();
  const privacy = page.getByRole('region', { name: 'Privacy' });
  const crashes = privacy.getByRole('switch', { name: 'Send crash reports' });
  await crashes.click();
  await page.waitForTimeout(1_000);
  if ((await crashes.getAttribute('aria-checked')) !== 'false') throw new Error('the switch did not turn off');
  await shot('settings-privacy');
  const before = crashReports();
  await tool('sim.crash', {});
  await page.waitForTimeout(5_000);
  if (crashReports() !== before) throw new Error('a crash report went with crash reports off');
});
await area('Desk');
await page.waitForTimeout(12_000);
await browser.close();
const { accounts: after } = await tool<{ accounts: { account: { id: string; displayName: string } }[] }>(
  'portfolio.get_accounts',
  {},
);
ws.close();

const posted = sent.filter((s) => s.method === 'POST');
const events = postedEvents();
const recordings = posted.filter((s) => s.path.startsWith('/s/'));
const logs = posted.filter((s) => s.path.startsWith('/i/v1/logs'));
const count = (names: string[]) => Object.fromEntries(names.map((n) => [n, events.filter((e) => e.name === n).length]));
const EXPECTED = [
  '$exception',
  'app opened',
  'chart loaded',
  'connection added',
  'account switched',
  'order placed',
  'copy group created',
  'area opened',
  'analyst session started',
  '$ai_trace',
  '$ai_generation',
  'survey shown',
  'survey sent',
  '$feature_flag_called',
];
const counts = count(EXPECTED);
const missing = EXPECTED.filter((n) => counts[n] === 0);
const refused = posted.filter((s) => s.status >= 300).map((s) => `${s.path} ${String(s.status)}`);

const everything = JSON.stringify(sent.map((s) => s.sent));
const privateWords = [
  QUESTION,
  'Paper 2',
  'Paper 3',
  'demo-trader',
  GROUP,
  ...after.map((a) => a.account.id),
  ...after.map((a) => a.account.displayName).filter((n) => n !== 'Paper'),
];
const leaks = [...new Set(privateWords)].filter((w) => everything.includes(w));

const rrweb: Json[] = recordings
  .flatMap((s) => (Array.isArray(s.sent) ? (s.sent as Json[]) : []))
  .flatMap((e) => ((e.properties as Json).$snapshot_data as Json[] | undefined) ?? []);
rrweb.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
const digits: string[] = [];
const TEXT_ATTRIBUTES = /^(aria-label|aria-valuetext|aria-valuenow|title|alt|placeholder|value|label)$/;
let texts = 0;
const walk = (n: unknown) => {
  if (!n || typeof n !== 'object') return;
  const node = n as { type?: number; textContent?: string; isStyle?: boolean; attributes?: Json; childNodes?: unknown[] };
  if (node.type === 3 && typeof node.textContent === 'string' && !node.isStyle) {
    texts += 1;
    if (/\d/.test(node.textContent)) digits.push(node.textContent.slice(0, 60));
  }
  for (const [k, v] of Object.entries(node.attributes ?? {}))
    if (TEXT_ATTRIBUTES.test(k) && typeof v === 'string' && /\d/.test(v)) digits.push(`${k}=${v.slice(0, 60)}`);
  for (const c of node.childNodes ?? []) walk(c);
};
for (const r of rrweb) {
  const d = r.data as Json | undefined;
  if (r.type === 2) walk(d?.node);
  if (r.type === 3 && d?.source === 0) {
    for (const t of (d.texts as { value?: string }[] | undefined) ?? []) {
      texts += 1;
      if (t.value && /\d/.test(t.value)) digits.push(t.value.slice(0, 60));
    }
    for (const a of (d.adds as { node: unknown }[] | undefined) ?? []) walk(a.node);
    for (const a of (d.attributes as { attributes: Json }[] | undefined) ?? []) walk({ attributes: a.attributes });
  }
}

writeFileSync(join(dir, 'replay', 'events.json'), JSON.stringify(rrweb));
writeFileSync(
  join(dir, 'replay', 'index.html'),
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style><div id="root"></div>
<script type="module">import { Replayer } from './rrweb.js';
const events = await (await fetch('./events.json')).json();
window.replayer = new Replayer(events, { root: document.getElementById('root'), mouseTail: false, showWarning: false });
window.first = events[0].timestamp; window.last = events.at(-1).timestamp; window.ready = true;</script>`,
);
const stills: string[] = [];
if (rrweb.length > 1) {
  const viewer = await chromium.launch();
  const p = await viewer.newPage({ viewport: { width: 1600, height: 1000 } });
  await p.goto(`${projectOrigin}/__replay/index.html`);
  await p.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
  const first = await p.evaluate(() => (window as unknown as { first: number }).first);
  for (const [name, at] of shotAt) {
    await p.evaluate(
      (ms) => (window as unknown as { replayer: { pause: (t: number) => void } }).replayer.pause(ms),
      Math.max(0, at - first),
    );
    await p.waitForTimeout(600);
    await p.screenshot({ path: join(dir, `${name}-replay.png`) });
    stills.push(`${name}-replay`);
  }
  await viewer.close();
}
stop();

const scrubbed = JSON.stringify(sent, null, 1).split(key).join('phc_…');
writeFileSync(join(dir, 'sent.json'), scrubbed);
const report = {
  mode: forward ? 'forwarded to PostHog EU' : 'local stand-in',
  steps,
  requests: Object.entries(
    sent.reduce<Record<string, number>>((m, s) => {
      const k = `${s.method} ${s.path.split('?')[0]!.replace(/\/array\/[^/]+/, '/array/<key>')} → ${String(s.status)} (${s.answeredBy})`;
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {}),
  ),
  events: counts,
  missing,
  refused,
  recordings: { batches: recordings.length, rrwebEvents: rrweb.length, textNodes: texts, withDigits: digits.slice(0, 20) },
  logBatches: logs.length,
  leaks,
  pageRequestsOutsideTheRuntime: outside,
  replayStills: stills,
};
writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
console.info(JSON.stringify(report, null, 2));
const verified =
  Object.values(steps).every((s) => s === 'ok') &&
  missing.length === 0 &&
  refused.length === 0 &&
  recordings.length > 0 &&
  digits.length === 0 &&
  logs.length > 0 &&
  leaks.length === 0 &&
  outside.length === 0;
console.info(verified ? 'VERIFIED' : 'NOT VERIFIED');
process.exit(verified ? 0 : 1);
