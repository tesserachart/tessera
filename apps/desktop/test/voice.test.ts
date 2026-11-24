import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  AccountUpdate,
  LimitsStatus,
  Order,
  OrderRole,
  OrderStatus,
  OrderType,
  Position,
  ProviderHealth,
  ToolCallEvent,
  ToolCallRecord,
  ToolErrorCode,
  ToolErrorInfo,
} from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { ConnectionSoundTracker } from '../src/sound/connectionSounds.ts';
import { SOUND_EVENTS } from '../src/sound/events.ts';
import {
  LimitSoundTracker,
  PositionSoundTracker,
  RefusalSoundTracker,
  orderLine,
  positionLine,
  refusalLine,
  tradeSound,
} from '../src/sound/tradeSounds.ts';
import { BUNDLED_PACKS } from '../src/sound/voice/bundled.ts';
import { TIMING, VoiceDirector } from '../src/sound/voice/director.ts';
import {
  EVENT_SAMPLE,
  VOICE_LINES,
  VOICE_LINE_IDS,
  fallbackChain,
  type VoiceLineId,
} from '../src/sound/voice/lines.ts';
import { parseManifest } from '../src/sound/voice/manifest.ts';
import { DEFAULT_VOICE, clipFor, packFor, packsFrom } from '../src/sound/voice/packs.ts';
import { providerHealth } from './support/providers.ts';

let n = 0;
function order(o: {
  id?: string;
  role?: OrderRole;
  status?: OrderStatus;
  filledQty?: number;
  qty?: number;
  type?: OrderType;
  reason?: string;
}): Order {
  n += 1;
  return {
    id: o.id ?? `o${String(n)}`,
    brokerOrderId: null,
    draftId: null,
    request: {
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      side: 'buy',
      qty: o.qty ?? 2,
      orderType: o.type ?? 'limit',
      limitPrice: null,
      stopPrice: null,
      tif: 'day',
      bracket: null,
      clientOrderId: null,
      reduceOnly: false,
    },
    role: o.role ?? 'entry',
    parentId: null,
    status: o.status ?? 'working',
    filledQty: o.filledQty ?? 0,
    avgFillPrice: null,
    queueAhead: null,
    triggeredAt: null,
    environment: 'paper',
    reason: o.reason ?? null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const working = { status: 'working' as const, filledQty: 0 };

describe('the voice’s lines', () => {
  it('are a trader’s few words, each said once, each a statement', () => {
    const texts = VOICE_LINE_IDS.map((id) => VOICE_LINES[id].text);
    expect(new Set(texts).size).toBe(texts.length);
    for (const t of texts) {
      expect(t).toMatch(/^[A-Z][a-z]*( [a-z]+){0,2}\.$/);
    }
  });

  it('fall back from an order’s type to "Order filled", never from a partial fill', () => {
    for (const id of ['market_filled', 'limit_filled', 'stop_filled', 'stop_limit_filled'] as const)
      expect(fallbackChain(id)).toEqual([id, 'order_filled']);
    expect(fallbackChain('partially_filled')).toEqual(['partially_filled']);
    expect(fallbackChain('stop_hit')).toEqual(['stop_hit']);
    for (const id of VOICE_LINE_IDS)
      for (const at of fallbackChain(id)) expect(VOICE_LINES[at].event).toBe(VOICE_LINES[id].event);
  });

  it('keep each tone the tones alone always played', () => {
    expect(VOICE_LINES.limit_filled.tone).toBe('fill');
    expect(VOICE_LINES.partially_filled.tone).toBe('fill');
    expect(VOICE_LINES.stop_hit.tone).toBe('stop');
    expect(VOICE_LINES.target_hit.tone).toBe('target');
    expect(VOICE_LINES.order_rejected.tone).toBe('rejected');
    expect(VOICE_LINES.alert.tone).toBe('alert');
    for (const id of ['order_cancelled', 'position_closed', 'connection_lost', 'loss_limit', 'account_locked'] as const)
      expect(VOICE_LINES[id].tone).toBeNull();
  });

  it('give every switch a line to preview', () => {
    for (const e of SOUND_EVENTS) expect(VOICE_LINES[EVENT_SAMPLE[e]].event).toBe(e);
  });
});

describe('an order’s line', () => {
  it('says the order’s type when it is done, and each part before as partly filled', () => {
    const types: [OrderType, VoiceLineId][] = [
      ['market', 'market_filled'],
      ['limit', 'limit_filled'],
      ['stop', 'stop_filled'],
      ['stop_limit', 'stop_limit_filled'],
    ];
    for (const [type, line] of types)
      expect(orderLine(working, order({ type, status: 'filled', filledQty: 2 }))).toBe(line);
    expect(orderLine(working, order({ role: 'exit', type: 'market', status: 'filled', filledQty: 2 }))).toBe(
      'market_filled',
    );
    expect(orderLine(working, order({ status: 'partially_filled', filledQty: 1, qty: 3 }))).toBe('partially_filled');
    expect(orderLine(working, order({ status: 'partially_filled', filledQty: 3, qty: 3 }))).toBe('limit_filled');
  });

  it('says a bracket’s leg as what it is, in part or whole', () => {
    expect(orderLine(working, order({ role: 'stop_loss', type: 'stop', status: 'filled', filledQty: 2 }))).toBe(
      'stop_hit',
    );
    expect(orderLine(working, order({ role: 'stop_loss', status: 'partially_filled', filledQty: 1 }))).toBe('stop_hit');
    expect(orderLine(working, order({ role: 'take_profit', status: 'filled', filledQty: 2 }))).toBe('target_hit');
  });

  it('says a rejection and a cancel once, but not a bracket’s legs going with their entry', () => {
    expect(orderLine(undefined, order({ status: 'rejected' }))).toBe('order_rejected');
    expect(orderLine({ status: 'rejected', filledQty: 0 }, order({ status: 'rejected' }))).toBeNull();
    expect(orderLine(working, order({ status: 'cancelled', reason: 'Cancelled.' }))).toBe('order_cancelled');
    expect(orderLine(undefined, order({ status: 'cancelled' }))).toBe('order_cancelled');
    expect(orderLine({ status: 'cancelled', filledQty: 0 }, order({ status: 'cancelled' }))).toBeNull();
    expect(orderLine({ status: 'held', filledQty: 0 }, order({ role: 'stop_loss', status: 'cancelled' }))).toBeNull();
    expect(orderLine(working, order({ role: 'take_profit', status: 'cancelled' }))).toBeNull();
    expect(orderLine(working, order({ status: 'cancelled', reason: "Shown as its bracket's stop." }))).toBeNull();
    expect(orderLine(working, order({ status: 'expired' }))).toBeNull();
    expect(orderLine(working, order({ status: 'working' }))).toBeNull();
  });

  it('keeps the tones alone exactly as they were: a cancel has none', () => {
    expect(tradeSound(working, order({ status: 'cancelled' }))).toBeNull();
    expect(tradeSound(working, order({ status: 'partially_filled', filledQty: 1, qty: 3 }))).toBe('fill');
    expect(tradeSound(working, order({ type: 'stop_limit', status: 'filled', filledQty: 2 }))).toBe('fill');
  });
});

function position(qty: number, o: { account?: string; instrument?: string; mark?: number } = {}): Position {
  return {
    accountId: o.account ?? 'paper-main',
    instrument: o.instrument ?? 'NQZ6.CME',
    qty,
    avgPrice: 21000,
    realizedPnl: { amount: 0, currency: 'USD' },
    unrealizedPnl: null,
    mark: o.mark ?? null,
    openedAt: 0,
  };
}

describe('a position’s line', () => {
  it('is closed going flat and reversed flipping sides; opening, adding and reducing are the fill’s', () => {
    expect(positionLine(2, 0)).toBe('position_closed');
    expect(positionLine(-1, 0)).toBe('position_closed');
    expect(positionLine(2, -1)).toBe('position_reversed');
    expect(positionLine(-3, 3)).toBe('position_reversed');
    expect(positionLine(0, 1)).toBeNull();
    expect(positionLine(1, 3)).toBeNull();
    expect(positionLine(3, 1)).toBeNull();
    expect(positionLine(0, 0)).toBeNull();
  });

  it('is told per account and contract, and never for the snapshot or a mark’s change', () => {
    const t = new PositionSoundTracker();
    expect(t.see(position(2), 0)).toBeNull();
    t.activate();
    expect(t.see(position(1, { account: 'eval-1' }), 0)).toBeNull();
    expect(t.see(position(2, { mark: 21010 }), 1)).toBeNull();
    expect(t.see(position(0, { account: 'eval-1' }), 2)).toBe('position_closed');
    expect(t.see(position(-2), 3)).toBe('position_reversed');
    expect(t.see(position(0), 4)).toBe('position_closed');
    expect(t.see(position(0), 5)).toBeNull();
    expect(t.see(position(0, { instrument: 'ESZ6.CME' }), 6)).toBeNull();
    t.restart();
    expect(t.see(position(1), 7)).toBeNull();
  });
});

function account(id: string, limits?: Partial<LimitsStatus>): AccountUpdate {
  const u = { account: { id }, summary: {}, risk: null } as unknown as AccountUpdate;
  if (limits) u.limits = { locked: false, lockedWhy: null, asOf: 0, ...limits } as LimitsStatus;
  return u;
}

const usd = (amount: number) => ({ amount, currency: 'USD' as const });
const open = { locked: false };
const lossLimitHit = { locked: true, dailyLossLimit: usd(500), dailyLossLeft: usd(0) };
const lossLimitUntilOpen = { ...lossLimitHit, lockedUntil: 5, lockKind: 'daily_loss' as const };
const lockedByMe = { locked: true, lockedUntil: 5, lockKind: 'manual' as const };
const firmRulesHit = { locked: true, firmRoom: usd(0) };
const firmPlatformLock = { locked: true, firmRoom: usd(400) };

const spoken = (line: VoiceLineId | null) => (line === null ? null : VOICE_LINES[line].text);

function lockSaid(lock: Partial<LimitsStatus>): string | null {
  const t = new LimitSoundTracker();
  t.activate();
  t.see(account('a', open), 1);
  return spoken(t.see(account('a', lock), 2));
}

describe('a lock’s line', () => {
  it('is "Loss limit reached" only when the daily loss limit locked the account', () => {
    expect(lockSaid(lossLimitHit)).toBe('Loss limit reached.');
    expect(lockSaid(lossLimitUntilOpen)).toBe('Loss limit reached.');
  });

  it('is "Account locked" for every other lock: the trader’s own, the firm’s rules, the firm’s platform', () => {
    expect(lockSaid(lockedByMe)).toBe('Account locked.');
    expect(lockSaid(firmRulesHit)).toBe('Account locked.');
    expect(lockSaid(firmPlatformLock)).toBe('Account locked.');
  });

  it('is said once a lock, as it starts or changes cause, never for one already there', () => {
    const t = new LimitSoundTracker();
    t.activate();
    expect(t.see(account('a', open), 0)).toBeNull();
    expect(t.see(account('b', lockedByMe), 0)).toBeNull();
    expect(t.see(account('a', open), 1)).toBeNull();
    expect(t.see(account('a', lockedByMe), 2)).toBe('account_locked');
    expect(t.see(account('a', lockedByMe), 3)).toBeNull();
    expect(t.see(account('a', lossLimitUntilOpen), 4)).toBe('loss_limit');
    expect(t.see(account('a', lossLimitHit), 5)).toBeNull();
    expect(t.see(account('a', open), 6)).toBeNull();
    expect(t.see(account('c'), 7)).toBeNull();
    expect(t.see(account('c', firmRulesHit), 8)).toBe('account_locked');
    expect(t.see(account('c', firmPlatformLock), 9)).toBeNull();
    expect(t.see(account('d', lossLimitHit), 10)).toBeNull();
  });

  it('is in every voice pack, in its own words', () => {
    for (const p of BUNDLED_PACKS) {
      expect(clipFor(p, 'account_locked')?.clip.text, p.manifest.id).toBe('Account locked.');
      expect(clipFor(p, 'loss_limit')?.clip.text, p.manifest.id).toBe('Loss limit reached.');
    }
  });
});

let calls = 0;
function call(
  o: Partial<ToolCallRecord> & { code?: ToolErrorCode; details?: ToolErrorInfo['details'] },
): ToolCallRecord {
  calls += 1;
  const { code, details, ...rest } = o;
  return {
    callId: `c${String(calls)}`,
    tool: 'orders.submit',
    risk: 'financial',
    origin: { kind: 'user' },
    sessionId: null,
    inputHash: '',
    input: {},
    status: code ? 'error' : 'ok',
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    error: code ? { code, message: 'Refused.', details: details ?? null, retryable: false } : null,
    approvalId: null,
    deduped: false,
    idempotencyKey: null,
    summary: null,
    approvedBy: null,
    ...rest,
  };
}

const finished = (c: ToolCallRecord): ToolCallEvent => ({ phase: 'finished', call: c });

describe('a rejected order’s line', () => {
  it('is "Order rejected" when the broker rejects it, said from the order itself', () => {
    expect(spoken(orderLine(working, order({ status: 'rejected' })))).toBe('Order rejected.');
    const sent = call({ code: 'rejected', details: { order: {}, sent: true } });
    expect(refusalLine(sent)).toBeNull();
  });

  it('is "Order rejected" when Tessera refuses it before it reaches the broker', () => {
    const blocked = call({ code: 'rejected', details: { code: 'max_order_qty', sent: false } });
    expect(spoken(refusalLine(blocked))).toBe('Order rejected.');
    const locked = call({ code: 'rejected', details: { code: 'manual', sent: false } });
    expect(spoken(refusalLine(locked))).toBe('Order rejected.');
    const denied = call({ code: 'permission_denied', status: 'denied' });
    expect(spoken(refusalLine(denied))).toBe('Order rejected.');
    const reversed = call({ tool: 'orders.reverse', code: 'rejected', details: { sent: false } });
    expect(spoken(refusalLine(reversed))).toBe('Order rejected.');
    const agents = call({
      origin: { kind: 'agent', sessionId: 's1', provider: 'codex' },
      code: 'loop_guard',
      status: 'denied',
    });
    expect(spoken(refusalLine(agents))).toBe('Order rejected.');
    const approved = call({ approvalId: 'a1', approvedBy: 'a1', code: 'rejected', details: { sent: false } });
    expect(spoken(refusalLine(approved))).toBe('Order rejected.');
  });

  it('is not said for what is no refusal of an order', () => {
    expect(refusalLine(call({}))).toBeNull();
    expect(refusalLine(call({ code: 'timeout' }))).toBeNull();
    expect(refusalLine(call({ code: 'outcome_unknown' }))).toBeNull();
    expect(refusalLine(call({ code: 'unavailable' }))).toBeNull();
    expect(refusalLine(call({ code: 'rejected', details: { flat: true } }))).toBeNull();
    expect(refusalLine(call({ tool: 'orders.cancel', code: 'rejected', details: { sent: false } }))).toBeNull();
    expect(refusalLine(call({ approvalId: 'a2', code: 'permission_denied', status: 'denied' }))).toBeNull();
    expect(refusalLine(call({ deduped: true, code: 'rejected', details: { sent: false } }))).toBeNull();
  });

  it('is said once a call, as it finishes, once the feed is live', () => {
    const t = new RefusalSoundTracker();
    const refused = call({ code: 'rejected', details: { sent: false } });
    expect(t.see(finished(refused), 1)).toBeNull();
    t.activate();
    const next = call({ code: 'rejected', details: { sent: false } });
    expect(t.see({ phase: 'started', call: { ...next, status: 'running', error: null } }, 2)).toBeNull();
    expect(t.see(finished(next), 3)).toBe('order_rejected');
    expect(t.see(finished(next), 4)).toBeNull();
    expect(t.see(finished(call({ code: 'rejected', details: { sent: false } })), 0)).toBeNull();
  });
});

function provider(
  id: string,
  status: ProviderHealth['status'],
  kind: ProviderHealth['kind'] = 'broker',
): ProviderHealth {
  return providerHealth({ providerId: id, kind, status });
}

describe('a connection’s line', () => {
  it('is lost once when a working one drops, and restored when it is back', () => {
    const t = new ConnectionSoundTracker();
    t.activate();
    expect(t.see([provider('rithmic', 'unknown'), provider('paper', 'ok')], 0)).toBeNull();
    expect(t.see([provider('rithmic', 'ok'), provider('paper', 'ok')], 1)).toBeNull();
    expect(t.see([provider('rithmic', 'degraded'), provider('paper', 'ok')], 2)).toBe('connection_lost');
    expect(t.see([provider('rithmic', 'degraded'), provider('paper', 'ok')], 3)).toBeNull();
    expect(t.see([provider('rithmic', 'down'), provider('paper', 'ok')], 4)).toBeNull();
    expect(t.see([provider('rithmic', 'ok'), provider('paper', 'ok')], 5)).toBe('connection_restored');
    expect(t.see([provider('rithmic', 'ok'), provider('paper', 'ok')], 6)).toBeNull();
  });

  it('is nothing for a connection the user stopped, an agent, or one removed', () => {
    const t = new ConnectionSoundTracker();
    t.activate();
    t.see([provider('rithmic', 'ok'), provider('codex', 'ok', 'agent')], 1);
    expect(t.see([provider('rithmic', 'disconnected'), provider('codex', 'down', 'agent')], 2)).toBeNull();
    expect(t.see([provider('rithmic', 'ok')], 3)).toBeNull();
    expect(t.see([], 4)).toBeNull();
    expect(t.see([provider('rithmic', 'ok')], 5)).toBeNull();
  });

  it('says two dropping at once as one, and nothing before it is live', () => {
    const t = new ConnectionSoundTracker();
    t.see([provider('a', 'ok'), provider('b', 'ok', 'market_data')], 1);
    expect(t.see([provider('a', 'down'), provider('b', 'ok', 'market_data')], 2)).toBeNull();
    t.activate();
    expect(t.see([provider('a', 'ok'), provider('b', 'ok', 'market_data')], 3)).toBeNull();
    expect(t.see([provider('a', 'down'), provider('b', 'degraded', 'market_data')], 4)).toBe('connection_lost');
  });
});

describe('the director', () => {
  const { gatherMs, holdMs, gapMs, staleMs } = TIMING;

  it('waits a moment, then says a burst’s best line once', () => {
    const d = new VoiceDirector();
    expect(d.wakeAt()).toBeNull();
    d.offer('limit_filled', 0);
    d.offer('order_cancelled', 20);
    d.offer('position_closed', 40);
    expect(d.wakeAt()).toBe(gatherMs);
    expect(d.take(gatherMs - 1)).toEqual([]);
    expect(d.take(gatherMs)).toEqual(['position_closed', 'limit_filled', 'order_cancelled']);
    expect(d.wakeAt()).toBeNull();
  });

  it('says a copier’s five fills once, and drops their echoes until the hold ends', () => {
    const d = new VoiceDirector();
    for (let i = 0; i < 5; i++) d.offer('limit_filled', i * 25);
    const lines = d.take(gatherMs);
    expect(lines).toEqual(['limit_filled']);
    d.said(lines, gatherMs, 1200);
    d.offer('market_filled', 1500);
    d.offer('limit_filled', gatherMs + 1200 + holdMs - 1);
    d.offer('order_cancelled', 2000);
    expect(d.wakeAt()).toBeNull();
    d.offer('limit_filled', gatherMs + 1200 + holdMs);
    expect(d.wakeAt()).not.toBeNull();
  });

  it('says a higher line that comes during the hold next, never over the one speaking', () => {
    const d = new VoiceDirector();
    d.offer('stop_hit', 0);
    d.said(d.take(gatherMs), gatherMs, 1000);
    d.offer('loss_limit', 400);
    const next = gatherMs + 1000 + gapMs;
    expect(d.wakeAt()).toBe(next);
    expect(d.take(next - 1)).toEqual([]);
    expect(d.take(next)).toEqual(['loss_limit']);
  });

  it('says an alert and a fill of one moment one after the other', () => {
    const d = new VoiceDirector();
    d.offer('market_filled', 0);
    d.offer('alert', 10);
    const first = d.take(gatherMs);
    expect(first).toEqual(['alert']);
    d.said(first, gatherMs, 700);
    expect(d.take(gatherMs + 1)).toEqual([]);
    expect(d.wakeAt()).toBe(gatherMs + 700 + gapMs);
    expect(d.take(gatherMs + 700 + gapMs)).toEqual(['market_filled']);
  });

  it('drops a line left waiting too long', () => {
    const d = new VoiceDirector();
    d.offer('connection_lost', 0);
    d.said(d.take(gatherMs), gatherMs, staleMs + 1000);
    d.offer('alert', gatherMs + 10);
    expect(d.take(gatherMs + staleMs + 1000 + gapMs)).toEqual([]);
    expect(d.wakeAt()).toBeNull();
  });
});

function manifest(id: string, lines: Record<string, unknown>, name = id): unknown {
  return {
    schema: 1,
    id,
    name,
    about: 'test',
    vendor: { id: 'elevenlabs', voiceId: 'v', model: 'm', plan: 'free', commercialUse: false, credit: 'Voices by X' },
    generated: '2026-10-19',
    lines,
  };
}
const clip = (file: string) => ({ file, text: 'x.', durationMs: 900, lufs: -20 });

describe('the packs', () => {
  const packs = packsFrom(
    {
      './packs/zed/manifest.json': manifest('zed', { order_filled: clip('order_filled.mp3') }, 'Zed'),
      './packs/amy/manifest.json': manifest(
        'amy',
        { order_filled: clip('order_filled.mp3'), limit_filled: clip('limit_filled.mp3'), gone: clip('gone.mp3') },
        'Amy',
      ),
      './packs/odd/manifest.json': manifest('other', { order_filled: clip('order_filled.mp3') }),
      './packs/bad/manifest.json': { schema: 2 },
    },
    {
      './packs/zed/order_filled.mp3': '/a/zed-order.mp3',
      './packs/amy/order_filled.mp3': '/a/amy-order.mp3',
      './packs/odd/order_filled.mp3': '/a/odd.mp3',
    },
  );

  it('are those whose manifest is one and names its folder, each line with its clip there', () => {
    expect(packs.map((p) => p.manifest.id)).toEqual(['amy', 'zed']);
    expect(Object.keys(packs[0]!.clips)).toEqual(['order_filled']);
    expect(packs[0]!.clips.order_filled?.url).toBe('/a/amy-order.mp3');
  });

  it('speak as chosen, the default voice until one is, and nothing for Off', () => {
    expect(packFor('zed', packs)?.manifest.id).toBe('zed');
    expect(packFor('off', packs)).toBeNull();
    expect(packFor(null, [])).toBeNull();
    expect(packFor(null, packs)?.manifest.id).toBe('amy');
    expect(packFor('retired', packs)?.manifest.id).toBe('amy');
  });

  it('say a line they lack by its fallback, else nothing (the tone)', () => {
    const amy = packs[0]!;
    expect(clipFor(amy, 'limit_filled')).toEqual({ line: 'order_filled', clip: amy.clips.order_filled });
    expect(clipFor(amy, 'order_filled')?.line).toBe('order_filled');
    expect(clipFor(amy, 'partially_filled')).toBeNull();
    expect(clipFor(amy, 'stop_hit')).toBeNull();
  });

  it('read a manifest strictly where it matters: its schema, its id, a clip beside it', () => {
    expect(parseManifest(manifest('ok', {}))).not.toBeNull();
    expect(parseManifest(manifest('Not An Id', {}))).toBeNull();
    expect(parseManifest({ ...(manifest('x', {}) as object), schema: 2 })).toBeNull();
    expect(parseManifest(manifest('x', { order_filled: clip('../../etc/passwd') }))?.lines).toEqual({});
    expect(parseManifest(manifest('x', { order_filled: { file: 'a.mp3' } }))?.lines).toEqual({});
  });
});

describe('the pack generator', () => {
  it('loads the lines and the manifest outside Vite, under Bun', () => {
    const dir = resolve(import.meta.dirname, '../src/sound/voice');
    const load = ['lines.ts', 'manifest.ts'].map((f) => `await import(${JSON.stringify(join(dir, f))});`).join('');
    const run = spawnSync('bun', ['--eval', load], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});

describe('the packs the app ships', () => {
  const dir = resolve(import.meta.dirname, '../src/sound/voice/packs');

  it('are four voices, the default among them, each saying every line as the line set words it', () => {
    expect(BUNDLED_PACKS.map((p) => p.manifest.id).sort()).toEqual(['alice', 'daniel', 'eric', 'sarah']);
    expect(packFor(null, BUNDLED_PACKS)?.manifest.id).toBe(DEFAULT_VOICE);
    for (const p of BUNDLED_PACKS) {
      for (const id of VOICE_LINE_IDS) {
        const c = p.clips[id];
        expect(c, `${p.manifest.id} ${id}`).toBeDefined();
        expect(c!.text).toBe(VOICE_LINES[id].text);
        expect(c!.durationMs).toBeGreaterThan(300);
        expect(c!.durationMs).toBeLessThan(2500);
        expect(c!.lufs).toBeGreaterThan(-23);
        expect(c!.lufs).toBeLessThan(-19);
        const file = resolve(dir, p.manifest.id, c!.file);
        expect(existsSync(file), file).toBe(true);
        expect(statSync(file).size).toBeLessThan(20_000);
      }
    }
  });

  it('credit their vendor and say the plan they were made on', () => {
    for (const p of BUNDLED_PACKS) {
      expect(p.manifest.vendor.credit).toBe('Voices by ElevenLabs');
      expect(p.manifest.vendor.commercialUse).toBe(p.manifest.vendor.plan !== 'free');
    }
  });
});
