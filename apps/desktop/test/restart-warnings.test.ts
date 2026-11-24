import type { AgentSessionSummary, Order, Position } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { hasWarnings, restartWarnings, restartWords } from '../src/app/restartWarnings.ts';
import { wireOrder } from './support/orders.ts';

const position = (qty: number, instrument = 'NQZ6.CME'): Position => ({
  accountId: 'paper-main',
  instrument,
  qty,
  avgPrice: 100,
  realizedPnl: { amount: 0, currency: 'USD' },
  unrealizedPnl: null,
  mark: null,
  openedAt: 0,
});

const session = (status: AgentSessionSummary['status']): AgentSessionSummary => ({
  id: `s_${status}`,
  title: 'NQ gamma plan',
  preset: 'Trader',
  provider: 'codex',
  model: null,
  mode: 'supervised',
  status,
  origin: { kind: 'agent', sessionId: 's', provider: 'codex' },
  sourceLabel: null,
  createdAt: 0,
  updatedAt: 0,
});

const working = (n: number): Order[] => Array.from({ length: n }, () => wireOrder({ status: 'working' }));
const held = (n: number): Position[] => Array.from({ length: n }, (_, i) => position(1, `INSTRUMENT${String(i)}.CME`));
const busy = (n: number): AgentSessionSummary[] => Array.from({ length: n }, () => session('running'));

const BROKER_MANY = 'They stay at your broker, but Tessera will be offline for a moment while it restarts.';
const BROKER_ONE = 'It stays at your broker, but Tessera will be offline for a moment while it restarts.';
const NOT_CONNECTED = 'Tessera isn’t connected, so it can’t count your working orders and positions.';

describe('what a restart touches', () => {
  it('counts working orders, open positions and busy sessions from what the stores hold', () => {
    const counted = restartWarnings(
      [...working(2), wireOrder({ status: 'filled' })],
      [position(2), position(-1, 'ESZ6.CME'), position(0, 'CLZ6.NYMEX')],
      [session('running'), session('needs_you'), session('idle')],
    );
    expect(counted).toEqual({ orders: 2, positions: 2, sessions: 2 });
  });

  it('says nothing when everything is flat and quiet', () => {
    const flat = restartWarnings([], [], [session('idle')]);
    expect(flat).toEqual({ orders: 0, positions: 0, sessions: 0 });
    expect(hasWarnings(flat)).toBe(false);
    expect(restartWords(flat)).toEqual([]);
  });

  it('names working orders alone', () => {
    expect(restartWords(restartWarnings(working(1), [], []))).toEqual([`You have 1 working order. ${BROKER_ONE}`]);
    expect(restartWords(restartWarnings(working(2), [], []))).toEqual([`You have 2 working orders. ${BROKER_MANY}`]);
  });

  it('names open positions alone', () => {
    expect(restartWords(restartWarnings([], held(1), []))).toEqual([`You have 1 open position. ${BROKER_ONE}`]);
    expect(restartWords(restartWarnings([], held(3), []))).toEqual([`You have 3 open positions. ${BROKER_MANY}`]);
  });

  it('names orders and positions together, as the issue words it', () => {
    const both = restartWarnings(working(2), held(1), []);
    expect(hasWarnings(both)).toBe(true);
    expect(restartWords(both)).toEqual([`You have 2 working orders and 1 open position. ${BROKER_MANY}`]);
    expect(restartWords(restartWarnings(working(1), held(1), []))).toEqual([
      `You have 1 working order and 1 open position. ${BROKER_MANY}`,
    ]);
  });

  it('says a session in progress is interrupted and can be picked up', () => {
    expect(restartWords(restartWarnings([], [], busy(1)))).toEqual([
      '1 analyst session is in progress. The restart interrupts it; you can pick it up once Tessera is back.',
    ]);
    expect(restartWords(restartWarnings([], [], busy(2)))).toEqual([
      '2 analyst sessions are in progress. The restart interrupts them; you can pick them up once Tessera is back.',
    ]);
  });

  it('puts the broker line before the sessions line', () => {
    const lines = restartWords(restartWarnings(working(1), [], busy(1)));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^You have 1 working order\./);
    expect(lines[1]).toMatch(/^1 analyst session is in progress\./);
  });

  it('warns when a source has not answered, and still counts the ones that have', () => {
    const unknown = restartWarnings(null, null, null);
    expect(unknown).toEqual({ orders: null, positions: null, sessions: null });
    expect(hasWarnings(unknown)).toBe(true);
    expect(restartWords(unknown)).toEqual([NOT_CONNECTED]);
    const partly = restartWarnings(working(1), null, []);
    expect(hasWarnings(partly)).toBe(true);
    expect(restartWords(partly)).toEqual([`You have 1 working order. ${BROKER_ONE}`, NOT_CONNECTED]);
  });

  it('never promises Tessera keeps managing anything while it restarts', () => {
    const every = [
      ...restartWords(restartWarnings(working(2), held(2), busy(2))),
      ...restartWords(restartWarnings(null, null, null)),
    ].join(' ');
    expect(every).not.toMatch(/bracket|keeps? managing|cancel/i);
  });
});
