#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const PACE_MS = 220;
const args = process.argv.slice(2);
const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

if (args[0] === '--version') {
  process.stdout.write('2.1.309 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth') {
  process.stdout.write(
    `${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })}\n`,
  );
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const session = flag('--session-id') ?? flag('--resume') ?? '00000000-0000-7000-8000-000000000000';
const model = flag('--model') ?? 'claude-sonnet-4-5';
const frame = (event) => ({ type: 'stream_event', event, session_id: session, parent_tool_use_id: null });

const ANSWER =
  'Stand-in answer for the demo, not a model. I would read the opening range on the active chart first, then the ' +
  'volume traded at its edges, then where the session high and low sit against it. A close back inside the range ' +
  'after a break would argue for standing aside; holding outside it on the retest would be the setup to size. ' +
  'Nothing here is measured yet.';
const STEERED =
  'Adjusting the plan to it: I would still wait for the first five minutes to set the range, then size up only if ' +
  'the edge holds with absorption on the tape, and keep the stop beyond the far side of the range. Nothing here is ' +
  'measured yet.';
const NOTE = /The trader's note:\n([\s\S]*?)\n\nFacts Tessera attached:/;
const writeUp = (text) => {
  const note = NOTE.exec(text)?.[1]?.trim() ?? '';
  const events = (text.match(/orders\.[a-z_]+/g) ?? []).length;
  return JSON.stringify({
    title: `Stand-in write-up: ${note.split('\n')[0].slice(0, 60)}`,
    steps: ['Open the NQ chart on Paper', 'Buy 1 at market with a bracket', 'Move the stop on the chart'],
    expected: 'The stop line follows the drag and the DOM shows the new stop',
    actual: `${note} (${String(events)} order events were attached)`,
  });
};
const reply = (text, steered) => {
  if (NOTE.test(text)) return writeUp(text);
  return steered ? `Taking that on board mid-run: ${text} ${STEERED}` : ANSWER;
};

const RESEARCH = /^Research: (.+)$/m;

async function tool(name, args) {
  const server = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.tessera;
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...server.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: name.replace('.', '_'), arguments: args } }),
  });
  const out = await res.json();
  const text = out.result?.content?.[0]?.text ?? '';
  if (out.error || out.result?.isError) throw new Error(out.error?.message ?? text);
  return JSON.parse(text);
}

async function research(name) {
  const study = await tool('research.save_study', {
    name,
    hypothesis:
      'A close beyond the last 20 bars in the New York morning keeps going for an hour: breakouts in the 09:30 to 12:00 window carry.',
    data: { instrument: 'NQ', tf: '5m', rthOnly: true, developmentShare: 0.6, window: { start: '09:30', end: '12:00' } },
    strategy: { kind: 'rules', rule: { rule: 'breakout', lookback: 20, holdBars: 12, sides: 'both' } },
    execution: {
      qty: 1,
      commissionPerContract: 1,
      stopTicks: 60,
      targetTicks: 120,
      fillCases: [
        { name: 'base', slippageTicks: 1 },
        { name: 'stressed', slippageTicks: 2 },
      ],
    },
    placeboRuns: 50,
  });
  const run = await tool('research.run_study', { id: study.id });
  return `Stand-in answer for the demo, not a model. I registered "${name}" and ran it: ${run.verdict}, ${run.reason}`;
}

const SHARE_PROOF = /^Share proof\b/m;

async function shareProof() {
  const { positions } = await tool('portfolio.get_positions', {});
  const held = positions.find((p) => p.qty !== 0) ?? null;
  if (!held) return 'Stand-in answer for the demo, not a model. You hold nothing right now.';
  const pnl = held.unrealizedPnl?.amount ?? held.realizedPnl.amount;
  const sign = pnl < 0 ? '-' : '+';
  return (
    `Stand-in answer for the demo, not a model. On ${held.accountId} you are long ${String(Math.abs(held.qty))} contracts ` +
    `at ${held.avgPrice.toFixed(2)}, and your open P&L is ${sign}$${Math.abs(pnl).toFixed(2)}. ` +
    'The session high sits at 21,480.50 and RSI 14 reads 61%, so the trend still has room; ' +
    'I would trail the stop under the last swing rather than add.'
  );
}

let turn = null;
let messages = 0;
const waiting = [];

function stopStreaming() {
  clearInterval(turn.timer);
  emit(frame({ type: 'content_block_stop', index: 0 }));
  emit(frame({ type: 'message_stop' }));
}

function answer(text, steered, said = null) {
  messages += 1;
  emit({ type: 'system', subtype: 'init', session_id: session, model, mcp_servers: [{ name: 'tessera', status: 'connected' }], tools: [] });
  emit(frame({ type: 'message_start', message: { id: `msg_${String(messages)}` } }));
  emit(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  const words = (said ?? reply(text, steered)).split(/(?<= )/);
  const current = { said: '', timer: null };
  current.timer = setInterval(() => {
    const word = words.shift();
    if (word !== undefined) {
      current.said += word;
      emit(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } }));
      return;
    }
    stopStreaming();
    emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: current.said, session_id: session, uuid: `r${String(messages)}` });
    turn = null;
    const next = waiting.shift();
    if (next !== undefined) answer(next, false);
  }, PACE_MS);
  turn = current;
}

function abort(interrupted) {
  if (!turn) return;
  stopStreaming();
  emit({
    type: 'result',
    subtype: interrupted ? 'error_during_execution' : 'success',
    is_error: interrupted,
    terminal_reason: 'aborted_streaming',
    result: turn.said,
    ...(interrupted ? { errors: ['Request was aborted'] } : {}),
    session_id: session,
    uuid: `a${String(messages)}`,
  });
  turn = null;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    waiting.length = 0;
    abort(true);
    return;
  }
  if (msg.type !== 'user') return;
  const content = msg.message?.content;
  const text = Array.isArray(content)
    ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    : String(content ?? '');
  if (SHARE_PROOF.test(text) && !turn) {
    turn = { said: '', timer: null };
    void shareProof()
      .catch((e) => `Stand-in answer for the demo, not a model. The portfolio tools refused: ${e.message}`)
      .then((said) => {
        turn = null;
        answer(text, false, said);
      });
    return;
  }
  const asked = RESEARCH.exec(text)?.[1];
  if (asked && !turn) {
    turn = { said: '', timer: null };
    void research(asked.trim())
      .catch((e) => `Stand-in answer for the demo, not a model. The research tools refused: ${e.message}`)
      .then((said) => {
        turn = null;
        answer(text, false, said);
      });
    return;
  }
  if (turn && msg.priority === 'now') {
    abort(false);
    answer(text, true);
  } else if (turn) waiting.push(text);
  else answer(text, false);
});
