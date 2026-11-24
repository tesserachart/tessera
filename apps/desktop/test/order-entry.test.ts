import type { BrokerCapabilities, ConnectionInfo, Environment, Order, Position } from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { describe, expect, it } from 'vitest';
import { bracketPalette, bracketTags, groupBrackets, readOnlyTags, type ChartMath } from '../src/chart/brackets.ts';
import { orderEntryOf, orderEntrySwitchOf, type EntryAccount } from '../src/shell/orderEntry.ts';
import { firstFailure } from '../src/shell/tradeActions.ts';
import { connectionInfo, providerHealth } from './support/providers.ts';

const broker = (o: Partial<BrokerCapabilities> & { environments: Environment[] }): BrokerCapabilities => ({
  orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
  timeInForce: ['day', 'gtc'],
  brackets: false,
  oco: false,
  modify: true,
  readOnly: false,
  fractionalQty: false,
  stopRules: false,
  ...o,
});

const connection = (
  id: string,
  displayName: string,
  b: BrokerCapabilities | null,
  accountOrderEntry: string[] | null = null,
): ConnectionInfo =>
  connectionInfo(providerHealth({ providerId: id, displayName, message: 'Connected' }), {
    broker: b,
    accountOrderEntry,
  });

const apex = connection(
  'rithmic-apex',
  'Apex · Rithmic',
  broker({ readOnly: true, orderTypes: [], modify: false, environments: ['eval'] }),
);
const paperOff = connection(
  'rithmic-paper-trading',
  'Rithmic Paper Trading',
  broker({ readOnly: true, orderTypes: [], modify: false, environments: ['sim'] }),
);
const paperOn = connection(
  'rithmic-paper-trading',
  'Rithmic Paper Trading',
  broker({ readOnly: false, environments: ['sim'] }),
);
const dataOnly = connection('rithmic-data', 'Data · Rithmic', null);

const acct = (connectionId: string, environment: Environment = 'eval', id = `${connectionId}-a1`): EntryAccount => ({
  id,
  connectionId,
  environment,
});

describe('order entry by account', () => {
  it('an account on a read-only login takes no orders, and says why in the preview’s words', () => {
    expect(orderEntryOf(acct('rithmic-apex'), [dataOnly, apex])).toEqual({
      open: false,
      why: 'Tessera reads this Apex account; this connection sends no orders.',
    });
  });

  it('a paper login with routing off is read-only too, for its own reason', () => {
    const e = orderEntryOf(acct('rithmic-paper-trading', 'sim'), [paperOff]);
    expect(e.open).toBe(false);
    expect(!e.open && e.why).toMatch(/^Order routing is off for Rithmic Paper Trading/);
    expect(orderEntryOf(acct('rithmic-paper-trading', 'sim'), [paperOn])).toEqual({ open: true });
  });

  it('no connection list, or an account on a connection it does not describe, keeps entry open', () => {
    expect(orderEntryOf(acct('rithmic-apex'), undefined)).toEqual({ open: true });
    expect(orderEntryOf(acct('paper', 'paper'), [dataOnly, apex])).toEqual({ open: true });
    expect(orderEntryOf(acct('rithmic-data', 'paper'), [dataOnly])).toEqual({ open: true });
    expect(orderEntryOf(null, [apex])).toEqual({ open: true });
  });

  it('an account takes orders only once the user turns its order entry on (decisions 0009, 0017)', () => {
    const off = connection('rithmic-apex', 'Apex · Rithmic', apex.broker, []);
    expect(orderEntryOf(acct('rithmic-apex'), [off])).toEqual({
      open: false,
      why: 'Order entry is off for this Apex account; turn it on to send it orders.',
      canTurnOn: true,
    });
    expect(orderEntrySwitchOf(acct('rithmic-apex'), [off])).toEqual({
      connectionId: 'rithmic-apex',
      system: 'Apex',
      on: false,
    });
    const on = connection('rithmic-apex', 'Apex · Rithmic', broker({ brackets: true, environments: ['eval'] }), [
      'rithmic-apex-a1',
    ]);
    expect(orderEntryOf(acct('rithmic-apex'), [on])).toEqual({ open: true });
    expect(orderEntrySwitchOf(acct('rithmic-apex'), [on])?.on).toBe(true);
    const other = acct('rithmic-apex', 'eval', 'rithmic-apex-a2');
    expect(orderEntryOf(other, [on])).toMatchObject({ open: false, canTurnOn: true });
  });

  it('funded and live accounts have the same switch and take orders the same way', () => {
    const funded = acct('rithmic-apex', 'funded', 'rithmic-apex-pa');
    const apexOn = connection('rithmic-apex', 'Apex · Rithmic', broker({ environments: ['eval'] }), [
      'rithmic-apex-pa',
    ]);
    expect(orderEntryOf(funded, [apexOn])).toEqual({ open: true });
    expect(orderEntrySwitchOf(funded, [apexOn])?.on).toBe(true);
    const live = acct('rithmic-01', 'live');
    const liveOff = connection(
      'rithmic-01',
      'Rithmic 01 · Rithmic',
      broker({ readOnly: true, orderTypes: [], environments: ['live'] }),
      [],
    );
    expect(orderEntryOf(live, [liveOff])).toEqual({
      open: false,
      why: 'Order entry is off for this Rithmic 01 account; turn it on to send it orders.',
      canTurnOn: true,
    });
    expect(orderEntrySwitchOf(live, [liveOff])).toEqual({
      connectionId: 'rithmic-01',
      system: 'Rithmic 01',
      on: false,
    });
    const liveOn = connection('rithmic-01', 'Rithmic 01 · Rithmic', broker({ environments: ['live'] }), [live.id]);
    expect(orderEntryOf(live, [liveOn])).toEqual({ open: true });
  });

  it('a connection without the per-account list has no switch', () => {
    const ro = connection('tradovate', 'Tradovate', broker({ readOnly: true, orderTypes: [], environments: ['live'] }));
    const e = orderEntryOf(acct('tradovate', 'live'), [ro]);
    expect(e.open).toBe(false);
    expect(!e.open && e.canTurnOn).toBeFalsy();
    expect(orderEntrySwitchOf(acct('tradovate', 'live'), [ro])).toBeNull();
    expect(orderEntrySwitchOf(acct('paper', 'eval'), [dataOnly])).toBeNull();
    expect(orderEntrySwitchOf(null, [ro])).toBeNull();
  });

  it('no order types reads as read-only even when the flag is not set', () => {
    const odd = connection('x', 'Odd · Rithmic', broker({ orderTypes: [], environments: ['funded'] }));
    expect(orderEntryOf(acct('x', 'funded'), [odd]).open).toBe(false);
  });
});

describe('read-only brackets on the chart', () => {
  const math: ChartMath = { decimals: 2, tick: 0.25, multiplier: 20 };
  const pal = bracketPalette(TOKENS);
  const NQ = 'NQZ6.CME-RITHMIC';
  const stop: Order = {
    id: 's1',
    brokerOrderId: null,
    draftId: null,
    request: {
      accountId: 'APEX-1',
      instrument: NQ,
      side: 'sell',
      qty: 1,
      orderType: 'stop',
      limitPrice: null,
      stopPrice: 20640,
      tif: 'gtc',
      bracket: null,
      clientOrderId: null,
      reduceOnly: true,
    },
    role: 'stop_loss',
    parentId: null,
    status: 'working',
    filledQty: 0,
    avgFillPrice: null,
    queueAhead: null,
    triggeredAt: null,
    environment: 'eval',
    reason: null,
    createdAt: 1_759_430_000_000,
    updatedAt: 1_759_430_000_000,
  };
  const position: Position = {
    accountId: 'APEX-1',
    instrument: NQ,
    qty: 1,
    avgPrice: 20650,
    realizedPnl: { amount: 0, currency: 'USD' },
    unrealizedPnl: { amount: 100, currency: 'USD' },
    mark: 20655,
    openedAt: 1_759_430_000_000,
  };

  it('keep what the tags say and drop what they do', () => {
    const brackets = groupBrackets([stop], [position], [], new Set([NQ]));
    const live = bracketTags(brackets, math, pal, { fanned: null, preview: null });
    expect(live.some((t) => t.close !== null)).toBe(true);
    expect(live.some((t) => t.drag.length > 0)).toBe(true);
    const ro = readOnlyTags(live);
    expect(ro.map((t) => t.text)).toEqual(live.map((t) => t.text));
    expect(ro.every((t) => t.close === null && t.drag.length === 0)).toBe(true);
  });
});

describe('an exit of several sends', () => {
  it('says the first refusal, and nothing when every send went', () => {
    expect(firstFailure([{ tone: 'ok', text: 'Flat NQ Z6' }])).toBeNull();
    expect(
      firstFailure([
        { tone: 'ok', text: 'Flat NQ Z6' },
        { tone: 'err', text: 'The link is down' },
        { tone: 'err', text: 'second' },
      ])?.text,
    ).toBe('The link is down');
    expect(firstFailure([])).toBeNull();
  });
});
