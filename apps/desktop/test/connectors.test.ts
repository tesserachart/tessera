import type { AccountUpdate, ConnectionInfo, ProviderHealth } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_LOGIN,
  KNOWN_SYSTEMS,
  brokerRule,
  connectionOf,
  connectionRows,
  defaultGateway,
  healthWords,
  loginProblem,
  rowAction,
  systemOptions,
} from '../src/accounts/connections.ts';
import { contractLimitWords, dailyLeftLow, dailyLossLeft, lockedWords, trailLow } from '../src/accounts/figures.ts';
import { connectionInfo, providerHealth } from './support/providers.ts';

function health(
  providerId: string,
  status: ProviderHealth['status'],
  over: Partial<ProviderHealth> = {},
): ProviderHealth {
  return providerHealth({ providerId, displayName: 'Apex · Rithmic', status, ...over });
}

function info(id: string, running: boolean, over: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return connectionInfo(health(id, running ? 'ok' : 'down'), {
    market: running ? ({ depthLevels: null } as unknown as ConnectionInfo['market']) : null,
    credential: running ? null : 'missing',
    ...over,
  });
}

const READ_ONLY = {
  orderTypes: [],
  timeInForce: [],
  brackets: false,
  oco: false,
  modify: false,
  readOnly: true,
  environments: ['eval', 'funded'],
  fractionalQty: false,
  stopRules: false,
} as ConnectionInfo['broker'];

describe('the connections list', () => {
  it('lists the user’s logins first, then paper on its own, and leaves the AI providers out', () => {
    const rows = connectionRows(
      [
        health('paper', 'ok', { kind: 'broker', latencyMs: 0 }),
        health('rithmic-apex', 'ok'),
        health('codex', 'ok', { kind: 'agent' }),
        health('runtime', 'ok', { kind: 'runtime' }),
      ],
      [],
    );
    expect(rows.map((r) => [r.id, r.name])).toEqual([
      ['rithmic-apex', 'Apex · Rithmic'],
      ['paper', 'Paper trading'],
    ]);
    expect(rows[1]).toMatchObject({ paper: true, grants: ['Accounts', 'Orders', 'Fills'] });
  });

  it('says what the owner’s Apex login grants, and that Tessera only reads it', () => {
    const rows = connectionRows(
      [health('rithmic-apex', 'ok', { latencyMs: 12.4 })],
      [info('rithmic-apex', true, { broker: READ_ONLY })],
    );
    expect(rows[0]).toMatchObject({
      id: 'rithmic-apex',
      name: 'Apex · Rithmic',
      grants: ['Prices', 'Depth by order', 'Accounts', 'Fills'],
      rule: 'Read only',
      health: '12 ms',
      login: 'rithmic',
      system: 'Apex',
      action: null,
    });
  });

  it('marks a paper-only broker, and an account finds its connection', () => {
    expect(brokerRule({ ...READ_ONLY!, readOnly: false, orderTypes: ['limit'], environments: ['sim'] })).toBe(
      'Orders: paper only',
    );
    expect(brokerRule({ ...READ_ONLY!, readOnly: false, orderTypes: ['limit'], environments: ['live'] })).toBeNull();
    const rows = connectionRows([health('paper', 'ok', { kind: 'broker' })], []);
    expect(connectionOf(rows, 'paper')?.name).toBe('Paper trading');
    expect(connectionOf(rows, 'nowhere')).toBeNull();
  });

  it('leaves the user’s providers of levels to Settings › Levels: their own sections there, no row here', () => {
    const intel = (id: string, vendor: string, name: string) =>
      info(id, true, {
        kind: 'intelligence',
        displayName: name,
        market: null,
        intel: { vendor } as ConnectionInfo['intel'],
        health: health(id, 'ok', { kind: 'intelligence', displayName: name }),
      });
    const rows = connectionRows(
      [health('zeta', 'ok', { kind: 'intelligence', displayName: 'Zeta' }), health('paper', 'ok', { kind: 'broker' })],
      [intel('zeta', 'Zeta', 'Zeta'), intel('acme', 'Acme', 'Acme levels')],
    );
    expect(rows.map((r) => [r.id, r.login, r.grants.join(', ')])).toEqual([['paper', null, 'Accounts, Orders, Fills']]);
  });

  it('lists a configured login the health has not reported yet', () => {
    const rows = connectionRows([], [info('rithmic-test', false, { displayName: 'Rithmic Test' })]);
    expect(rows[0]).toMatchObject({ id: 'rithmic-test', login: 'rithmic', action: { kind: 'login' } });
  });
});

describe('a login’s health and its one action', () => {
  it('reads the latency while it serves and the runtime’s own words when not', () => {
    expect(healthWords(health('r', 'ok', { latencyMs: 4 }))).toBe('4 ms');
    expect(healthWords(health('r', 'ok'))).toBe('Connected');
    expect(
      healthWords(
        health('r', 'degraded', {
          connection: { state: 'reconnecting', attempt: 3, reason: 'heartbeat timeout' },
        }),
      ),
    ).toBe('Connection lost. Reconnecting, 3rd try.');
    expect(healthWords(health('r', 'down', { message: 'Cannot reach Rithmic: refused' }))).toBe(
      'Cannot reach Rithmic: refused.',
    );
    expect(
      healthWords(
        health('r', 'down', {
          message: 'Cannot reach Rithmic: connection failed: IO error: Connection refused (os error 111)',
        }),
      ),
    ).not.toMatch(/os error|IO error|Connection refused/i);
    expect(healthWords(health('r', 'disconnected'))).toBe('Off');
  });

  it('reads the prices’ phase, then the accounts’ own phase when it differs', () => {
    expect(
      healthWords(
        health('r', 'degraded', {
          latencyMs: 18,
          connection: { state: 'live' },
          accounts: { state: 'reconnecting', attempt: 4, reason: 'connection closed' },
        }),
      ),
    ).toBe('Connected. Accounts: Connection lost. Reconnecting, 4th try.');
    expect(
      healthWords(
        health('r', 'degraded', {
          connection: { state: 'reconnecting', attempt: 1, reason: 'connection closed' },
          accounts: { state: 'unreachable', reason: 'connection closed' },
        }),
      ),
    ).toBe('Connection lost. Reconnecting. Accounts: Cannot connect. Check the network, then reconnect.');
    expect(healthWords(health('r', 'degraded', { connection: { state: 'live' }, message: 'No depth for NQ.' }))).toBe(
      'No depth for NQ.',
    );
  });

  it('offers nothing while the login serves, Reconnect when it is down, the login again when it is missing', () => {
    expect(rowAction(health('r', 'ok'), info('r', true))).toBeNull();
    expect(rowAction(health('r', 'down'), info('r', true))).toEqual({ kind: 'reconnect', label: 'Reconnect' });
    expect(rowAction(health('r', 'disconnected'), undefined)?.kind).toBe('reconnect');
    expect(rowAction(health('r', 'down'), info('r', false))).toEqual({ kind: 'login', label: 'Log in again' });
  });

  it('never asks for a saved login the keyring is still reading or did not let Tessera read', () => {
    const reading = info('r', false, { credential: null, health: health('r', 'unknown') });
    expect(rowAction(reading.health, reading)).toBeNull();
    const unreadable = info('r', false, { credential: 'unreadable' });
    expect(rowAction(unreadable.health, unreadable)).toEqual({ kind: 'reconnect', label: 'Try again' });
  });
});

describe('a firm’s rules in words (Accounts only)', () => {
  const money = (amount: number) => ({ amount, currency: 'USD' as const });
  const risk = (over: Partial<NonNullable<AccountUpdate['risk']>> = {}): NonNullable<AccountUpdate['risk']> => ({
    accountId: 'eval-50k',
    dailyLossLimit: money(1000),
    dailyLossRemaining: money(690),
    trailingThreshold: money(48_200),
    trailingRoom: money(3040),
    highWaterMark: money(51_240),
    room: money(690),
    locked: false,
    lockedUntil: null,
    breach: null,
    asOf: 0,
    ...over,
  });

  it('says what is left, brass under a quarter of the allowance', () => {
    expect(dailyLeftLow(risk({ dailyLossRemaining: money(249) }))).toBe(true);
    expect(dailyLeftLow(risk())).toBe(false);
    expect(trailLow(risk({ trailingRoom: money(700) }))).toBe(true);
    expect(trailLow(risk())).toBe(false);
  });

  it('the Accounts table’s daily loss left: the trader’s own limit while it is on, else the firm’s, else nothing', () => {
    const u = (over: Partial<AccountUpdate>): AccountUpdate =>
      ({ account: { id: 'eval-50k' }, risk: null, ...over }) as unknown as AccountUpdate;
    expect(dailyLossLeft(u({}))).toBeNull();
    expect(dailyLossLeft(u({ risk: risk() }))).toEqual({ left: money(690), low: false });
    const limits = {
      accountId: 'eval-50k',
      own: false,
      dailyLossLimit: money(500),
      dailyLossLeft: money(100),
      maxRiskPerTrade: null,
      maxOrderQty: null,
      maxPositionQty: null,
      maxTradesPerDay: null,
      tradesToday: null,
      firmRoom: null,
      locked: false,
      lockedWhy: null,
      asOf: 0,
    };
    expect(dailyLossLeft(u({ risk: risk(), limits }))).toEqual({ left: money(100), low: true });
  });

  it('says a lock with when it lifts, and that exits still work', () => {
    expect(lockedWords(risk())).toBeNull();
    expect(contractLimitWords(risk())).toBeNull();
    expect(contractLimitWords(risk({ contractLimits: { buy: 4, sell: 4, perOrder: 8 } }))).toBe(
      '4 long · 4 short · 8 an order',
    );
    expect(contractLimitWords(risk({ contractLimits: { buy: 4, sell: null, perOrder: null } }))).toBe('4 long');
    expect(lockedWords(risk({ locked: true, lockedUntil: Date.parse('2026-10-05T13:30:00Z') * 1e6 }))).toBe(
      'Locked until 09:30 · exits work',
    );
    expect(lockedWords(risk({ locked: true }))).toBe('Locked · exits work');
  });
});

describe('loginProblem', () => {
  const full = { system: 'Apex', gateway: 'wss://gateway.invalid:443', user: 'someone', password: 'pw' };

  it('lets a complete login with an encrypted gateway go', () => {
    expect(loginProblem(full)).toBeNull();
  });

  it('holds a half-typed form back', () => {
    expect(loginProblem(EMPTY_LOGIN)).toBe('Fill in all four fields');
    expect(loginProblem({ ...full, password: '' })).toBe('Fill in all four fields');
  });

  it('sends a password only over wss://, or plain ws:// to this machine', () => {
    expect(loginProblem({ ...full, gateway: 'ws://gateway.invalid:443' })).toBe('The gateway is a wss:// address');
    expect(loginProblem({ ...full, gateway: 'https://gateway.invalid' })).toBe('The gateway is a wss:// address');
    expect(loginProblem({ ...full, gateway: 'ws://localhost:9000' })).toBeNull();
    expect(loginProblem({ ...full, gateway: 'ws://127.0.0.1:9000/x' })).toBeNull();
    expect(loginProblem({ ...full, gateway: 'ws://[::1]:9000' })).toBeNull();
    expect(loginProblem({ ...full, gateway: 'ws://localhost.evil.invalid:9000' })).toBe(
      'The gateway is a wss:// address',
    );
  });
});

describe('a login by Rithmic’s lists', () => {
  const full = { system: 'Apex', gateway: 'Chicago Area', user: 'someone', password: 'pw' };

  it('names its gateway as Rithmic lists it, or types an address', () => {
    expect(loginProblem(full)).toBeNull();
    expect(loginProblem({ ...full, gateway: 'wss://gateway.invalid:443' })).toBeNull();
    expect(loginProblem({ ...full, gateway: 'ws://gateway.invalid:443' })).toBe('The gateway is a wss:// address');
  });

  it('offers every system Rithmic lists, by name, with no firm first', () => {
    const listed = ['TheTradingPit', 'Rithmic 01', 'BluSky', 'Apex', 'bulenox', 'HOLAPRIME', 'Apex'];
    expect(systemOptions(listed).map((o) => o.value)).toEqual([
      'Apex',
      'BluSky',
      'bulenox',
      'HOLAPRIME',
      'Rithmic 01',
      'TheTradingPit',
    ]);
    expect(systemOptions(listed).every((o) => o.group === undefined)).toBe(true);
  });

  it('offers the known systems by name while Rithmic cannot be asked', () => {
    const known = systemOptions([]).map((o) => o.value);
    expect(known).toEqual([...KNOWN_SYSTEMS]);
    expect(known).toEqual([...known].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
    expect(known).toContain('TopstepTrader');
  });

  it('starts on the Chicago gateway, else the first listed', () => {
    expect(defaultGateway(['Seoul', 'Chicago Area', 'Europe'])).toBe('Chicago Area');
    expect(defaultGateway(['Europe', 'Frankfurt'])).toBe('Europe');
    expect(defaultGateway([])).toBeNull();
  });
});

describe('a saved login switched off', () => {
  it('reads Off, offers nothing but its switch, and keeps its row', () => {
    const off = info('rithmic-apex', false, {
      enabled: false,
      health: health('rithmic-apex', 'disconnected', { message: 'Off.' }),
    });
    const [row] = connectionRows([], [off]);
    expect(row).toMatchObject({ id: 'rithmic-apex', enabled: false, health: 'Off', status: 'disconnected' });
    expect(row?.action).toBeNull();
  });

  it('a connected one says its switch is on; the paper broker has none', () => {
    const rows = connectionRows(
      [health('paper', 'ok', { kind: 'broker' })],
      [info('rithmic-apex', true, { enabled: true })],
    );
    expect(rows.map((r) => [r.id, r.enabled])).toEqual([
      ['rithmic-apex', true],
      ['paper', null],
    ]);
  });
});
