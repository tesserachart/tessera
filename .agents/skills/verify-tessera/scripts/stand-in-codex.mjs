#!/usr/bin/env node
import { createInterface } from 'node:readline';

const PACE_MS = 220;
const MODEL = 'gpt-5-codex';
const send = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const answer = (id, result) => send({ id, result });
const refuse = (id, message) => send({ id, error: { code: -32601, message } });
const note = (method, params) => send({ method, params });

const ANSWER =
  'Stand-in answer for the demo, not a model, from an app-server without turn/steer. I would read the opening ' +
  'range first, then the volume at its edges, and only then size anything.';

let ids = 0;
const running = new Map();

function finish(threadId, status) {
  const turn = running.get(threadId);
  if (!turn) return;
  clearInterval(turn.timer);
  running.delete(threadId);
  note('item/completed', { threadId, turnId: turn.id, item: { type: 'agentMessage', id: turn.item, text: turn.said } });
  note('turn/completed', { threadId, turn: { id: turn.id, status } });
}

function stream(threadId, turnId) {
  const item = `item_${String((ids += 1))}`;
  const words = ANSWER.split(/(?<= )/);
  const turn = { id: turnId, item, said: '', timer: null };
  note('item/started', { threadId, turnId, item: { type: 'agentMessage', id: item } });
  turn.timer = setInterval(() => {
    const word = words.shift();
    if (word === undefined) {
      finish(threadId, 'completed');
      return;
    }
    turn.said += word;
    note('item/agentMessage/delta', { threadId, turnId, itemId: item, delta: word });
  }, PACE_MS);
  running.set(threadId, turn);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || typeof msg.method !== 'string') return;
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'initialize':
      answer(msg.id, { userAgent: 'codex_cli_rs/0.40.0 (stand-in)' });
      break;
    case 'config/read':
      answer(msg.id, { config: {} });
      break;
    case 'account/read':
      answer(msg.id, { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true });
      break;
    case 'model/list':
      answer(msg.id, {
        data: [
          {
            id: MODEL,
            model: MODEL,
            displayName: 'GPT-5 Codex',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
            defaultReasoningEffort: 'medium',
          },
        ],
        nextCursor: null,
      });
      break;
    case 'thread/start':
    case 'thread/resume':
      answer(msg.id, { thread: { id: p.threadId ?? `thr_${String((ids += 1))}` }, model: MODEL });
      break;
    case 'turn/start': {
      const turnId = `turn_${String((ids += 1))}`;
      answer(msg.id, { turn: { id: turnId, status: 'inProgress' } });
      stream(p.threadId, turnId);
      break;
    }
    case 'turn/interrupt':
      answer(msg.id, {});
      finish(p.threadId, 'interrupted');
      break;
    default:
      refuse(msg.id, `Method not found: ${msg.method}`);
  }
});
