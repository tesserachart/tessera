import type {
  AccountUpdate,
  AgentSessionSummary,
  ChartLayer,
  Level,
  Position,
  ProviderHealth,
} from '@tessera/protocol';
import { LEVEL_STYLES, SeriesStore, SessionModel, Weight, timeLabel } from '@tessera/chart';
import { RequestTimeout, ToolFailed } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { loadErrorAction, loadErrorWords } from '../src/chart/chartNotice.ts';
import { areaStore } from '../src/areas/store.ts';
import { currentSession, reduceSessions } from '../src/app/agentSessions.ts';
import { reduceAccounts, reducePositions } from '../src/app/portfolio.ts';
import {
  groupLevels,
  isLevelShown,
  levelsForLayer,
  levelTitle,
  toggleLevel,
  toLevelSpecs,
  vendorChip,
} from '../src/chart/levels.ts';
import { displaySymbol, guessSessionOptions, sessionOptionsFor } from '../src/market/instruments.ts';
import { ordinal } from '../src/shell/deskWords.ts';
import { exposedPositions, healthProblems } from '../src/shell/health.ts';
import { groupSessions, orderSessions, relTime } from '../src/shell/sessions.ts';
import {
  applyChartResult,
  defaultChartState,
  layoutsStore,
  patchChart,
  putLayout,
  setActiveChart,
  setLayoutRevision,
} from '../src/state/layouts.ts';
import { dockShape, isLoadableDock, newWorkspaceLayout, stableStringify } from '../src/workspace/layouts.ts';
import { applyTrade, currentTrade, readWorkspaceTrade } from '../src/state/workspaceTrade.ts';
import { rememberOco, tradeSettingsStore } from '../src/state/tradeSettings.ts';
import { resolveOco } from '../src/shell/tradeContext.ts';
import { DEFAULT_OCO, type OcoConfig } from '../src/shell/oco.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import {
  DEFAULT_TICKET,
  MAX_STOP_LIMIT_TICKS,
  readTicketSetup,
  resolveTicketAccount,
  ticketOf,
  replaceTickets,
  patchTicket,
  ticketsStore,
} from '../src/state/tickets.ts';
import { uiStore, setTradeAccount } from '../src/state/ui.ts';
import { accountsUiStore } from '../src/accounts/accountsUi.ts';
import { pickTicketAccount } from '../src/chart/ticket/useTicketTrade.ts';
import { patch, read, write } from '../src/app/store.ts';
import { providerHealth } from './support/providers.ts';

const NS = 1e6;

const session = (id: string, status: AgentSessionSummary['status'], updatedMs = 0): AgentSessionSummary => ({
  id,
  title: id,
  preset: 'Trader',
  provider: 'codex',
  model: null,
  mode: 'supervised',
  status,
  origin: { kind: 'agent', sessionId: id, provider: 'codex' },
  sourceLabel: null,
  createdAt: 0,
  updatedAt: updatedMs * NS,
});

describe('a chart that could not load', () => {
  it('says so in the trader’s words, without the tool’s hints to an agent', () => {
    const unknown = new ToolFailed({
      tool: 'market.get_candles',
      code: 'not_found',
      message: 'unknown instrument NQZ6.CME-RITHMIC; try market.search_instruments',
      details: null,
      callId: 'c1',
    });
    expect(loadErrorWords('NQZ6.CME-RITHMIC', unknown)).toBe('No connection serves NQ Z6 now');
    const down = new ToolFailed({
      tool: 'market.get_candles',
      code: 'unavailable',
      message: 'rithmic-apex is reconnecting; try again shortly',
      details: null,
      callId: 'c2',
    });
    expect(loadErrorWords('NQZ6.CME-RITHMIC', down)).toBe('NQ Z6 did not load: rithmic-apex is reconnecting');
    const timeout = new RequestTimeout({ method: 'tools.invoke', timeoutMs: 20_000 });
    const stalled = loadErrorWords('NQZ6.CME', timeout);
    expect(stalled).toMatch(/NQ Z6/);
    expect(stalled).not.toMatch(/tools\.invoke/i);
    expect(stalled).not.toMatch(/20000ms/i);
  });

  it('offers the way to a connection when none serves the symbol, and nothing for a passing failure', () => {
    const unknown = new ToolFailed({
      tool: 'market.get_candles',
      code: 'not_found',
      message: 'unknown instrument RTYZ6.CME',
      details: null,
      callId: 'c1',
    });
    const down = new ToolFailed({
      tool: 'market.get_candles',
      code: 'unavailable',
      message: 'rithmic-apex is reconnecting',
      details: null,
      callId: 'c2',
    });
    expect(loadErrorAction(unknown, false)?.label).toBe('Connect Rithmic');
    expect(loadErrorAction(unknown, true)?.label).toBe('Connections');
    expect(loadErrorAction(down, false)).toBeNull();
    loadErrorAction(unknown, false)!.run();
    expect(read(areaStore).area).toBe('settings');
    expect(read(uiStore).settingsSection).toBe('connections');
    expect(read(accountsUiStore).focus).toEqual({ kind: 'add', provider: 'rithmic' });
  });
});

describe('agent sessions', () => {
  it('groups Needs you / Running / Recent, each session once', () => {
    const groups = groupSessions([
      session('a', 'idle'),
      session('b', 'running'),
      session('c', 'needs_you'),
      session('d', 'closed'),
    ]);
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ['Needs you', ['c']],
      ['Running', ['b']],
      ['Recent', ['a', 'd']],
    ]);
  });

  it('lists the sessions that need you first, then the running ones, then the rest', () => {
    const list = [session('a', 'idle'), session('b', 'running'), session('c', 'needs_you'), session('d', 'closed')];
    expect(orderSessions(list).map((s) => s.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('shows the picked session in the analyst column while it exists, else the busiest', () => {
    const list = [session('a', 'idle'), session('b', 'running'), session('c', 'needs_you')];
    expect(currentSession(list)?.id).toBe('c');
    expect(currentSession(list, 'a')?.id).toBe('a');
    expect(currentSession(list, 'gone')?.id).toBe('c');
    expect(currentSession([session('a', 'idle'), session('b', 'running')])?.id).toBe('b');
    expect(currentSession([])).toBeNull();
  });

  it('applies snapshot / upsert / removed events', () => {
    let m = reduceSessions(new Map(), {
      type: 'snapshot',
      sessions: [session('S1', 'idle'), session('S2', 'running')],
    });
    expect([...m.keys()]).toEqual(['S1', 'S2']);
    m = reduceSessions(m, { type: 'upsert', session: session('S2', 'needs_you') });
    expect(m.get('S2')?.status).toBe('needs_you');
    m = reduceSessions(m, { type: 'removed', sessionId: 'S1' });
    expect([...m.keys()]).toEqual(['S2']);
    m = reduceSessions(m, { type: 'snapshot', sessions: [] });
    expect(m.size).toBe(0);
  });

  it('ages of runtime (ns) timestamps in exchange time and the desk’s short forms', () => {
    const now = Date.parse('2026-10-02T14:42:00-04:00');
    expect(relTime(Date.parse('2026-10-02T14:41:30-04:00') * NS, now)).toBe('now');
    expect(relTime(Date.parse('2026-10-02T09:36:00-04:00') * NS, now)).toBe('09:36');
    expect(relTime(Date.parse('2026-10-01T15:00:00-04:00') * NS, now)).toBe('Thu');
    expect(relTime(Date.parse('2026-09-29T10:00:00-04:00') * NS, now)).toBe('Tue');
    expect(relTime(Date.parse('2026-09-20T10:00:00-04:00') * NS, now)).toBe('20 Sep');
    expect(relTime(Number.NaN, now)).toBe('');
  });
});

describe('portfolio reducers', () => {
  const money = (amount: number) => ({ amount, currency: 'USD' as const });
  const pos = (instrument: string, qty: number): Position => ({
    accountId: 'paper-main',
    instrument,
    qty,
    avgPrice: 100,
    realizedPnl: money(0),
    unrealizedPnl: money(5),
    mark: 101,
    openedAt: 0,
  });

  it('keeps one position per account and instrument; flat positions disappear', () => {
    let m = reducePositions(new Map(), { position: pos('QQQ', 100) });
    m = reducePositions(m, { position: pos('SPY', 25) });
    m = reducePositions(m, { position: pos('QQQ', 125) });
    expect([...m.values()].map((p) => [p.instrument, p.qty])).toEqual([
      ['QQQ', 125],
      ['SPY', 25],
    ]);
    m = reducePositions(m, { position: pos('SPY', 0) });
    expect([...m.keys()]).toEqual(['paper-main|QQQ']);
  });

  it('keeps the latest summary per account', () => {
    const summary = (net: number) => ({
      accountId: 'paper-main',
      balance: money(net),
      netLiq: money(net),
      dayPnl: money(1),
      realizedToday: money(0),
      feesToday: money(0),
      unrealizedToday: money(1),
      openPnl: money(1),
      buyingPower: money(1),
      asOf: 0,
    });
    const account = {
      id: 'paper-main',
      displayName: 'paper-main',
      environment: 'paper' as const,
      brokerId: 'tessera-paper',
      connectionId: 'paper',
      programId: null,
      ruleSetId: null,
      currency: 'USD' as const,
      restrictions: { noCopyTrading: false, blockedInstruments: [], loosenNextSession: false },
      groupId: null,
      externalRefMasked: null,
    };
    let m = reduceAccounts(new Map(), { account, summary: summary(1), risk: null });
    m = reduceAccounts(m, { account, summary: summary(2), risk: null });
    expect(m.get('paper-main')?.netLiq.amount).toBe(2);
  });
});

describe('annunciator lines', () => {
  const provider = (over: Partial<ProviderHealth>): ProviderHealth =>
    providerHealth({ providerId: 'p', displayName: 'Apex · Rithmic', ...over });
  const open = { status: 'open' as const, everConnected: true, attempt: 0 };

  it('says nothing while the runtime and every provider are fine, or not set up', () => {
    expect(
      healthProblems(open, [
        provider({ providerId: 'm' }),
        provider({ providerId: 'ai', kind: 'agent', displayName: 'Codex', status: 'disconnected' }),
        provider({ providerId: 'r', kind: 'runtime', displayName: 'Runtime' }),
      ]),
    ).toEqual([]);
    expect(
      healthProblems(open, [
        provider({
          providerId: 'codex',
          kind: 'agent',
          displayName: 'Codex',
          status: 'down',
          message: 'not installed',
        }),
      ]),
    ).toEqual([]);
    expect(healthProblems({ status: 'connecting', everConnected: false, attempt: 1 }, [])).toEqual([]);
  });

  it('names what is down or stale, worst first, each with its door', () => {
    const problems = healthProblems(open, [
      provider({ providerId: 'g', kind: 'intelligence', displayName: 'Zeta', status: 'degraded' }),
      provider({
        providerId: 'b',
        kind: 'broker',
        displayName: 'Paper broker',
        status: 'down',
        message: 'login refused',
      }),
    ]);
    expect(problems).toEqual([
      {
        key: 'b',
        severity: 'down',
        text: 'Paper broker: login refused.',
        src: 'Paper broker',
        fact: 'login refused.',
        action: 'connections',
      },
      {
        key: 'g',
        severity: 'stale',
        text: 'Zeta: Data is late',
        src: 'Zeta',
        fact: 'Data is late',
        action: 'connections',
      },
    ]);
  });

  it('says a login’s prices and accounts in plain sentences, the retry as its try, with no status word', () => {
    const facts = healthProblems(open, [
      provider({
        providerId: 'rithmic-apex',
        status: 'degraded',
        connection: { state: 'live' },
        accounts: { state: 'unreachable', reason: 'connection closed' },
      }),
      provider({
        providerId: 'rithmic-topstep',
        displayName: 'Topstep · Rithmic',
        status: 'degraded',
        connection: { state: 'reconnecting', attempt: 4, reason: 'connection closed' },
        accounts: { state: 'waiting' },
      }),
    ]).map((p) => [p.src, p.fact]);
    expect(facts).toEqual([
      ['Apex · Rithmic', 'Connected. Accounts: Cannot connect. Check the network, then reconnect.'],
      ['Topstep · Rithmic', 'Connection lost. Reconnecting, 4th try. Accounts: Logged out. Logging in again.'],
    ]);
  });

  it('names a position as exposed only when its own connection, or the runtime, is down', () => {
    const position = (accountId: string, qty: number) =>
      ({ accountId, instrument: 'NQZ6.CME', qty, avgPrice: 1, realizedPnl: { amount: 0, currency: 'USD' } }) as never;
    const account = (id: string, connectionId: string) => ({ id, connectionId }) as never;
    const accounts = [account('paper-1', 'paper'), account('apex-1', 'rithmic-apex')];
    const positions = [position('paper-1', 1), position('apex-1', 0)];
    const apexDown = [provider({ providerId: 'rithmic-apex', status: 'down' }), provider({ providerId: 'paper' })];
    expect(exposedPositions(false, apexDown, positions, accounts)).toEqual([]);
    const paperDown = [provider({ providerId: 'paper', kind: 'broker', status: 'down' })];
    expect(exposedPositions(false, paperDown, positions, accounts)).toEqual([positions[0]]);
    expect(exposedPositions(true, [], positions, accounts)).toEqual([positions[0]]);
  });

  it('says only that the runtime dropped while the link is down, with the try in words', () => {
    const problems = healthProblems({ status: 'reconnecting', everConnected: true, attempt: 3 }, [
      provider({ status: 'down' }),
    ]);
    expect(problems).toEqual([
      {
        key: 'runtime',
        severity: 'down',
        src: 'Runtime',
        fact: 'dropped.',
        next: 'Reconnecting, 3rd try.',
        action: 'retry',
        text: 'Runtime dropped. Reconnecting, 3rd try.',
      },
    ]);
    expect(healthProblems({ status: 'reconnecting', everConnected: true, attempt: 1 }, [])[0]?.text).toBe(
      'Runtime dropped. Reconnecting.',
    );
    expect(
      healthProblems(
        { status: 'reconnecting', everConnected: true, attempt: 2, lastErrorCode: 'session_expired' },
        [],
      )[0]?.text,
    ).toBe('Runtime restarted with a new token. Open the latest link it printed (…/#ticket=…).');
    const refused = healthProblems(open, [
      provider({
        status: 'down',
        message: 'Cannot reach Rithmic: connection failed: IO error: Connection refused (os error 111)',
      }),
    ]);
    expect(refused[0]?.text).toMatch(/Apex · Rithmic/);
    expect(refused[0]?.text).not.toMatch(/os error/i);
    expect(refused[0]?.text).not.toMatch(/IO error/i);
    expect(refused[0]?.text).not.toMatch(/Connection refused/i);
    const forced = healthProblems(open, [
      provider({
        status: 'down',
        message: 'ForcedLogout: Rithmic ended the session. Reconnect to continue.',
      }),
    ]);
    expect(forced[0]?.text).not.toMatch(/ForcedLogout/i);
    expect(forced[0]?.text).not.toMatch(/\.\./);
    expect(forced[0]?.fact).not.toMatch(/^down:/);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '101st',
    ]);
  });
});

describe('instrument helpers', () => {
  it('display symbols', () => {
    expect(displaySymbol('NQZ6.CME')).toBe('NQ Z6');
    expect(displaySymbol('BTC-USD.COINBASE')).toBe('BTCUSD');
    expect(displaySymbol('QQQ')).toBe('QQQ');
  });

  it('maps session calendars to chart session layouts: the axis in the user’s zone, the day in the exchange’s', () => {
    expect(sessionOptionsFor('us_equities', 'Europe/London')).toEqual({
      mode: 'collapse',
      timezone: 'Europe/London',
      dayStartMinutes: 0,
      dayStartZone: 'America/New_York',
    });
    for (const cme of [
      'cme_equity_index',
      'cme_interest_rates',
      'cme_fx',
      'cme_energy',
      'cme_gold',
      'cme_silver',
      'cme_copper',
      'cme_platinum',
      'cme_globex',
    ] as const) {
      expect(sessionOptionsFor(cme, 'Asia/Tokyo')).toEqual({
        mode: 'continuous',
        timezone: 'Asia/Tokyo',
        dayStartMinutes: 1080,
        dayStartZone: 'America/New_York',
      });
    }
    expect(sessionOptionsFor('crypto24x7', 'UTC')).toMatchObject({ mode: 'continuous', dayStartZone: 'UTC' });
    expect(guessSessionOptions('ESZ6.CME').dayStartMinutes).toBe(1080);
    expect(guessSessionOptions('NQZ6.CME-RITHMIC').mode).toBe('continuous');
    expect(guessSessionOptions('BTC-USD.COINBASE').mode).toBe('continuous');
    expect(guessSessionOptions('AAPL').mode).toBe('collapse');
  });

  it('takes the axis zone from the user’s time zone setting', () => {
    putRuntimeSettings({ 'display.timeZone': 'Asia/Tokyo' }, false);
    expect(guessSessionOptions('ESZ6.CME').timezone).toBe('Asia/Tokyo');
    putRuntimeSettings({ 'display.timeZone': 'Not/AZone' }, false);
    expect(guessSessionOptions('ESZ6.CME').timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    putRuntimeSettings({ 'display.timeZone': 'Europe/London' }, false);
    expect(guessSessionOptions('ESZ6.CME').timezone).toBe('Europe/London');
    putRuntimeSettings({ 'display.timeZone': null }, false);
    expect(guessSessionOptions('ESZ6.CME').timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('starts a CME trading day at the Globex open in New York, whatever zone the axis reads', () => {
    const t = (iso: string) => Date.parse(iso);
    const bars = ['2026-10-07T21:58:00Z', '2026-10-07T21:59:00Z', '2026-10-07T22:00:00Z', '2026-10-07T22:01:00Z'];
    for (const zone of ['America/New_York', 'Europe/London', 'Asia/Tokyo']) {
      const m = new SessionModel(sessionOptionsFor('cme_globex', zone), 60_000);
      const store = new SeriesStore();
      store.setData(bars.map((b) => ({ t: t(b), o: 1, h: 1, l: 1, c: 1, v: 1 })));
      m.apply(store, { kind: 'set', from: 0 });
      expect([...m.day.subarray(0, 4)]).toEqual([20261007, 20261007, 20261008, 20261008]);
      expect([...m.brk.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    }
    const hourIn = (zone: string) =>
      new SessionModel(sessionOptionsFor('cme_globex', zone), 60_000).clock.parts(t('2026-10-07T22:00:00Z')).hour;
    expect([hourIn('America/New_York'), hourIn('Europe/London'), hourIn('Asia/Tokyo')]).toEqual([18, 23, 7]);
  });

  it('labels the axis in London and Tokyo across London’s clock change', () => {
    const label = (zone: string, iso: string) =>
      timeLabel(
        new SessionModel(sessionOptionsFor('cme_globex', zone), 60_000).clock,
        Date.parse(iso),
        Weight.Hour1,
        0,
        60_000,
      );
    expect(label('Europe/London', '2026-10-23T13:30:00Z')).toBe('14:30');
    expect(label('Europe/London', '2026-10-26T13:30:00Z')).toBe('13:30');
    expect(label('Asia/Tokyo', '2026-10-23T13:30:00Z')).toBe('22:30');
    expect(label('Asia/Tokyo', '2026-10-26T13:30:00Z')).toBe('22:30');
    expect(label('America/New_York', '2026-10-26T13:30:00Z')).toBe('09:30');
  });

  it('starts a crypto trading day at midnight UTC while the axis reads the user’s zone', () => {
    const m = new SessionModel(sessionOptionsFor('crypto24x7', 'Asia/Tokyo'), 3_600_000);
    const store = new SeriesStore();
    const bars = ['2026-10-07T23:00:00Z', '2026-10-08T00:00:00Z'];
    store.setData(bars.map((b) => ({ t: Date.parse(b), o: 1, h: 1, l: 1, c: 1, v: 1 })));
    m.apply(store, { kind: 'set', from: 0 });
    expect([...m.day.subarray(0, 2)]).toEqual([20261007, 20261008]);
    expect(m.clock.parts(Date.parse('2026-10-08T00:00:00Z')).hour).toBe(9);
  });
});

describe('levels from the chart model', () => {
  const level = (field: string, vendor = 'Zeta', group = 'gamma', price: number | null = 490): Level => ({
    key: `${vendor.toLowerCase()}.${field}`,
    instrument: 'NQZ6.CME',
    label: field,
    short: field.slice(0, 2).toUpperCase(),
    group,
    price,
    unavailableReason: price === null ? 'vendor n/a' : null,
    nativePrice: null,
    source: {
      vendor,
      package: vendor === 'Tessera' ? 'concepts' : 'Classic',
      field,
      basis: 'NDX',
      endpoint: null,
      asOf: 0,
      conversion:
        vendor === 'Tessera'
          ? null
          : { id: 'c', from: 'NDX', to: 'NQZ6.CME', ratio: 1.00208, additive: 0, method: 'spot_ratio', asOf: 0 },
    },
    concept: null,
  });
  const layers: ChartLayer[] = [
    {
      id: 'levels-zeta',
      kind: 'levels',
      params: { vendor: 'Zeta', package: 'Classic', fields: ['major_pos_oi', 'zero_gamma'] },
      visible: true,
      namespace: 'user',
      sessionId: null,
    },
    {
      id: 'levels-pd',
      kind: 'levels',
      params: { group: 'pd', fields: ['pdh'] },
      visible: true,
      namespace: 'user',
      sessionId: null,
    },
  ];
  const mg: Level = { ...level('major_pos_oi'), concept: { concept: 'positive_gex_extreme', equivalence: 'alias' } };
  const cw = level('major_pos_vol');
  const pdh = level('pdh', 'Tessera', 'pd');
  const pdl = level('pdl', 'Tessera', 'pd');

  it('shows levels selected by scoped layers', () => {
    expect(isLevelShown(layers, mg)).toBe(true);
    expect(isLevelShown(layers, cw)).toBe(false);
    expect(isLevelShown(layers, pdh)).toBe(true);
    expect(isLevelShown(layers, pdl)).toBe(false);
    expect(isLevelShown([{ ...layers[0]!, visible: false }], mg)).toBe(false);
  });

  it('toggles fields on the matching layer, or adds a scoped layer', () => {
    const on = toggleLevel(layers, cw);
    expect((on[0]!.params as { fields: string[] }).fields).toEqual(['major_pos_oi', 'zero_gamma', 'major_pos_vol']);
    const off = toggleLevel(on, mg);
    expect((off[0]!.params as { fields: string[] }).fields).toEqual(['zero_gamma', 'major_pos_vol']);
    const added = toggleLevel([], pdl);
    expect(added).toEqual([
      {
        id: 'levels-pd',
        kind: 'levels',
        params: { group: 'pd', fields: ['pdl'] },
        visible: true,
        namespace: 'user',
        sessionId: null,
      },
    ]);
  });

  it('keeps vendor identity in specs and skips levels without a price', () => {
    const specs = toLevelSpecs([mg, cw, pdh, level('zero_gamma', 'Zeta', 'gamma', null)], layers);
    expect(specs.map((s) => s.id)).toEqual(['zeta.major_pos_oi', 'tessera.pdh']);
    expect(specs[0]).toMatchObject({
      vendor: 'Zeta · Classic · NDX→NQZ6',
      style: 'solid',
      color: LEVEL_STYLES.callWall.line,
      short: 'MA',
    });
    expect(specs[1]).toMatchObject({ vendor: null, style: 'dot', dash: [2, 3], color: LEVEL_STYLES.pdh.line });
    expect(vendorChip(pdh)).toBeNull();
    expect(groupLevels([mg, cw, pdh]).map((g) => [g.label, g.levels.length])).toEqual([
      ['Zeta · Classic', 2],
      ['Levels', 1],
    ]);
    const poc = level('poc', 'Tessera', 'vp');
    const tessera: ChartLayer = { ...layers[0]!, params: { vendor: 'Tessera' } };
    expect(isLevelShown([tessera], pdh)).toBe(true);
    expect(isLevelShown([tessera], poc)).toBe(false);
    expect(isLevelShown([{ ...tessera, params: { group: 'vp' } }], poc)).toBe(true);
    expect(groupLevels([mg, level('poc', 'Tessera', 'vp'), pdh]).map((g) => g.label)).toEqual([
      'Zeta · Classic',
      'Levels',
    ]);
  });

  it('orders layer-strip groups the same whichever topic answered first', () => {
    const label = (g: { label: string }) => g.label;
    expect(groupLevels([pdh, mg, cw], layers).map(label)).toEqual(['Zeta · Classic', 'Levels']);
    expect(groupLevels([mg, cw, pdh], layers).map(label)).toEqual(['Zeta · Classic', 'Levels']);
    const reversed = [layers[1]!, layers[0]!];
    expect(groupLevels([mg, pdh], reversed).map(label)).toEqual(['Levels', 'Zeta · Classic']);
    const spx = { ...level('hvl', 'Acme', 'gamma'), source: { ...mg.source, vendor: 'Acme', package: 'Flow' } };
    expect(groupLevels([pdh, mg, spx]).map(label)).toEqual(['Acme · Flow', 'Zeta · Classic', 'Levels']);
    expect(groupLevels([spx, pdh, mg]).map(label)).toEqual(['Acme · Flow', 'Zeta · Classic', 'Levels']);
  });

  it('gives each levels layer the levels of its own scope', () => {
    const all = [mg, cw, pdh, pdl];
    expect(levelsForLayer(layers[0]!, all).map((s) => s.id)).toEqual(['zeta.major_pos_oi']);
    expect(levelsForLayer(layers[1]!, all).map((s) => s.id)).toEqual(['tessera.pdh']);
    const wholeGroup = { ...layers[1]!, params: { group: 'pd' } };
    expect(levelsForLayer(wholeGroup, all).map((s) => s.id)).toEqual(['tessera.pdh', 'tessera.pdl']);
  });

  it('titles a level with the vendor’s own package, field and endpoint, and the conversion applied', () => {
    const converted = { ...level('zero_gamma', 'Zeta', 'gamma', 20652.75), nativePrice: 20610 };
    expect(vendorChip(converted)).toBe('Zeta · Classic · NDX→NQZ6');
    expect(groupLevels([mg, converted])).toHaveLength(1);
    expect(levelTitle(converted)).toBe(
      'zero_gamma 20652.75 · Zeta Classic field zero_gamma · converted from NDX 20610 × 1.00208 (spot_ratio)',
    );
    const gex: Level = {
      ...level('zero_gamma', 'Zeta', 'gamma', 30926.25),
      nativePrice: 30776.18,
    };
    gex.source = {
      ...gex.source,
      endpoint: 'classic/gex_full',
      conversion: { id: 'g', from: 'NDX', to: 'NQZ6.CME', ratio: 1, additive: 150, method: 'additive', asOf: 0 },
    };
    expect(levelTitle(gex)).toBe(
      'zero_gamma 30926.25 · Zeta Classic field zero_gamma (classic/gex_full) · converted from NDX 30776.18 × 1 + 150 (additive)',
    );
    expect(levelTitle(level('pdh', 'Tessera', 'pd', null))).toBe('pdh: vendor n/a · Tessera concepts field pdh');
  });
});

describe('layout model store', () => {
  const layout = () => ({ ...newWorkspaceLayout('default', 0, { instrument: 'NQ' }), revision: 3 });

  it('never rolls back to an older revision', () => {
    write(layoutsStore, { layouts: {}, chartToolRevision: {}, views: {} });
    expect(putLayout(layout())).toBe(true);
    expect(putLayout({ ...layout(), revision: 2, name: 'old' })).toBe(false);
    expect(read(layoutsStore).layouts.default?.revision).toBe(3);
    applyChartResult('default', 4, { ...defaultChartState('chart-1', 'Chart 1', 'NQ', '1m') });
    expect(read(layoutsStore).layouts.default?.charts['chart-1']?.instrument).toBe('NQ');
    applyChartResult('default', 1, { ...defaultChartState('chart-1', 'Chart 1', 'SPY', '1m') });
    expect(read(layoutsStore).layouts.default?.charts['chart-1']?.instrument).toBe('NQ');
  });

  it('patches charts locally and records save revisions', () => {
    write(layoutsStore, { layouts: {}, chartToolRevision: {}, views: {} });
    putLayout(layout());
    const next = patchChart('default', 'chart-1', (c) => ({ ...c, timeframe: '15m' }));
    expect(next?.timeframe).toBe('15m');
    expect(patchChart('default', 'nope', (c) => c)).toBeNull();
    setLayoutRevision('default', 9);
    expect(read(layoutsStore).layouts.default?.revision).toBe(9);
    setActiveChart('default', 'chart-1');
    expect(read(layoutsStore).layouts.default?.activeChartId).toBe('chart-1');
  });

  it('seeds a new workspace with one chart, from the defaults it is given', () => {
    const w = newWorkspaceLayout('ws-1', 5, {
      name: 'Scalp',
      instrument: 'NQ',
      timeframe: '1m',
      setup: { layers: [{ kind: 'vwap', params: {}, visible: true }], chartType: 'bars' },
    });
    expect(w).toMatchObject({ id: 'ws-1', name: 'Scalp', revision: 0, dock: null, activeChartId: 'chart-1' });
    expect(w.charts['chart-1']).toMatchObject({ instrument: 'NQ', timeframe: '1m' });
    expect(w.charts['chart-1']?.layers.map((l) => l.kind)).toEqual(['vwap']);
    expect(w.charts['chart-1']?.chartType).toBe('bars');
    const clean = newWorkspaceLayout('default', 0, { instrument: 'NQ' }).charts['chart-1'];
    expect(clean).toMatchObject({ instrument: 'NQ', timeframe: '5m' });
    expect(clean?.layers).toEqual([]);
    expect(clean?.chartType).toBeUndefined();
    expect(newWorkspaceLayout('x', 0, { instrument: 'NQ', setup: null }).charts['chart-1']?.layers).toEqual([]);
  });

  it('opens on the empty desk when no instrument was chosen', () => {
    const empty = newWorkspaceLayout('empty', 0);
    expect(empty).toMatchObject({ activeChartId: null, charts: {} });
    expect(newWorkspaceLayout('blank', 0, { instrument: '  ' }).charts).toEqual({});
  });
});

describe('dock JSON helpers', () => {
  it('compares two windows by shape: their pixel sizes never count as a change (no remount, no flicker)', () => {
    const tree = (w: number, h: number, a: number) => ({
      activeGroup: 'g-chart-1',
      grid: {
        width: w,
        height: h,
        orientation: 'VERTICAL',
        root: {
          type: 'branch',
          size: w,
          data: [{ type: 'leaf', size: a, data: { id: 'g-chart-1', views: ['chart-1'] } }],
        },
      },
      panels: { 'chart-1': { id: 'chart-1', contentComponent: 'chart' } },
      floatingGroups: [{ data: { id: 'g-2', views: ['w'] }, position: { left: 10, top: 20, width: 300, height: 200 } }],
    });
    expect(dockShape(tree(1080, 873, 873))).toBe(dockShape(tree(760, 844, 844)));
    const moved = tree(1080, 873, 873);
    moved.grid.orientation = 'HORIZONTAL';
    expect(dockShape(moved)).not.toBe(dockShape(tree(1080, 873, 873)));
  });

  it('compares dock trees independently of key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it('accepts only dockview-shaped trees', () => {
    expect(isLoadableDock({ grid: {}, panels: {} })).toBe(true);
    expect(isLoadableDock(null)).toBe(false);
    expect(isLoadableDock([])).toBe(false);
    expect(isLoadableDock({ grid: {} })).toBe(false);
  });
});

describe('the workspace’s trade setup', () => {
  it('reads a v1 setup as the base every chart’s ticket starts from (spec §10.5)', () => {
    expect(readWorkspaceTrade(null)).toBeNull();
    const t = readWorkspaceTrade({
      accountId: 'eval-50k',
      qty: 3,
      entry: 'limit',
      oco: { 'eval-50k|NQ': {} },
    });
    expect(t?.v).toBe(2);
    expect(t?.tickets['*']).toMatchObject({ accountId: 'eval-50k', qty: 3, entry: 'market', bracket: 'open' });
    expect(Object.keys(t!.oco)).toEqual(['eval-50k|NQ']);
    expect(readWorkspaceTrade({ qty: -2, entry: 'teleport' })?.tickets['*']).toMatchObject({
      accountId: null,
      qty: 1,
      entry: 'market',
    });
  });

  it('reads v2 tickets per chart, and a chart without its own starts from the base', () => {
    const t = readWorkspaceTrade({
      v: 2,
      tickets: {
        'chart-1': { accountId: 'paper-main', qty: 2, entry: 'market', sizing: 'risk', risk: 400, bracketOpen: true },
        'chart-2': { accountId: 'eval-50k', qty: 'x' },
      },
      oco: {},
    })!;
    expect(t.tickets['chart-1']).toEqual({
      accountId: 'paper-main',
      qty: 2,
      entry: 'market',
      sizing: 'risk',
      risk: 400,
      bracket: 'open',
      rules: 'closed',
      stopLimitTicks: 2,
      execute: 'chart',
    });
    expect(t.tickets['chart-2']).toMatchObject({ accountId: 'eval-50k', qty: 1 });
    expect(ticketOf(t.tickets, 'chart-3')).toEqual(DEFAULT_TICKET);
    expect(ticketOf({ ...t.tickets, '*': { ...DEFAULT_TICKET, qty: 5 } }, 'chart-3').qty).toBe(5);
  });

  it('keeps the trade panel’s bracket on or off, with its distances, across a reload; none saved is off', () => {
    const reload = () => {
      const saved = JSON.parse(JSON.stringify(currentTrade())) as unknown;
      patch(tradeSettingsStore, { lastOco: {} });
      applyTrade(readWorkspaceTrade(saved)!);
      return resolveOco(read(tradeSettingsStore), 'paper-main', 'NQ');
    };
    patch(tradeSettingsStore, { lastOco: {} });
    expect(reload().on).toBe(false);
    const on: OcoConfig = {
      ...DEFAULT_OCO,
      on: true,
      stop: { on: true, unit: 'ticks', value: 12 },
      target: { on: true, unit: 'points', value: 6 },
    };
    rememberOco('paper-main|NQ', on);
    expect(reload()).toEqual(on);
    rememberOco('paper-main|NQ', { ...on, on: false });
    expect(reload()).toEqual({ ...on, on: false });
    expect(
      readWorkspaceTrade({ v: 2, tickets: {}, oco: { 'paper-main|NQ': { stop: { value: 20 } } } })!.oco['paper-main|NQ']
        ?.on,
    ).toBe(false);
    patch(tradeSettingsStore, { lastOco: {} });
    replaceTickets({});
  });

  it('shows the bracket and its rules as the user left them: the bracket open and its rules folded until then', () => {
    expect(readTicketSetup({ bracketOpen: false }).bracket).toBe('open');
    expect(readTicketSetup({ bracket: 'auto' }).bracket).toBe('open');
    expect(readTicketSetup({ bracket: 'closed', bracketOpen: true }).bracket).toBe('closed');
    expect(readTicketSetup({ bracket: 'sideways' }).bracket).toBe('open');
    expect(readTicketSetup({}).rules).toBe('closed');
    expect(readTicketSetup({ rules: 'auto' }).rules).toBe('closed');
    expect(readTicketSetup({ rules: 'open' }).rules).toBe('open');
  });

  it('keeps a stop limit’s offset in whole ticks from its stop, at the stop or past it', () => {
    expect(readTicketSetup({}).stopLimitTicks).toBe(2);
    expect(readTicketSetup({ stopLimitTicks: 0 }).stopLimitTicks).toBe(0);
    expect(readTicketSetup({ stopLimitTicks: 3.4 }).stopLimitTicks).toBe(3);
    expect(readTicketSetup({ stopLimitTicks: -1 }).stopLimitTicks).toBe(2);
    expect(readTicketSetup({ stopLimitTicks: 'x' }).stopLimitTicks).toBe(2);
    expect(readTicketSetup({ stopLimitTicks: 1e6 }).stopLimitTicks).toBe(MAX_STOP_LIMIT_TICKS);
  });

  it('a chart’s ticket trades its own account while the runtime has it, else the one new tickets start with', () => {
    const u = (id: string) => ({ account: { id } }) as AccountUpdate;
    const all = [u('paper-main'), u('eval-50k')];
    expect(resolveTicketAccount(all, 'eval-50k', null, 'paper-main')?.account.id).toBe('eval-50k');
    expect(resolveTicketAccount(all, 'gone', null, 'eval-50k')?.account.id).toBe('eval-50k');
    expect(resolveTicketAccount(all, null, null, null)?.account.id).toBe('paper-main');
    expect(resolveTicketAccount(all, null, 'eval-50k', 'paper-main')?.account.id).toBe('eval-50k');
    expect(resolveTicketAccount(all, 'paper-main', 'eval-50k', null)?.account.id).toBe('paper-main');
    expect(resolveTicketAccount(all, null, 'gone', 'paper-main')?.account.id).toBe('paper-main');
    expect(resolveTicketAccount([], 'eval-50k', null, null)).toBeNull();
  });

  it('a change to one chart’s ticket leaves the others as they were', () => {
    replaceTickets({ '*': { ...DEFAULT_TICKET, qty: 3 } });
    patchTicket('chart-1', { accountId: 'eval-50k' });
    const { tickets } = read(ticketsStore);
    expect(ticketOf(tickets, 'chart-1')).toMatchObject({ accountId: 'eval-50k', qty: 3 });
    expect(ticketOf(tickets, 'chart-2')).toMatchObject({ accountId: null, qty: 3 });
    replaceTickets({});
  });

  it('a pick on one chart keeps every chart that never picked on the account it trades now', () => {
    const u = (id: string) => ({ account: { id } }) as AccountUpdate;
    const all = [u('paper-main'), u('eval-50k')];
    const trades = (tile: string) =>
      resolveTicketAccount(all, ticketOf(read(ticketsStore).tickets, tile).accountId, null, read(uiStore).tradeAccount)
        ?.account.id;
    replaceTickets({ 'chart-1': { ...DEFAULT_TICKET }, 'chart-2': { ...DEFAULT_TICKET } });
    setTradeAccount(null);
    expect([trades('chart-1'), trades('chart-2')]).toEqual(['paper-main', 'paper-main']);
    pickTicketAccount(
      'chart-1',
      'eval-50k',
      all.map((x) => x.account),
    );
    expect([trades('chart-1'), trades('chart-2')]).toEqual(['eval-50k', 'paper-main']);
    expect(trades('chart-3')).toBe('eval-50k');
    replaceTickets({});
    setTradeAccount(null);
  });
});
