import type { ConnectionState, Layout, Position, ProviderHealth, SessionsOutput } from '@tessera/protocol';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeClock } from '../src/app/clock.ts';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import { Annunciator } from '../src/shell/Annunciator.tsx';
import { defaultChartState, putLayout } from '../src/state/layouts.ts';
import { setActiveChartRef } from '../src/state/workspace.ts';
import {
  TestRuntime,
  answeringClient,
  seedTools,
  setTestServices,
  topicFeed,
  type FakeClient,
} from './support/runtime.tsx';
import { nsAt } from './support/time.ts';

const DOWN: ConnectionState = {
  status: 'reconnecting',
  attempt: 3,
  everConnected: true,
  server: null,
  lastError: null,
  lastErrorCode: null,
  nextRetryAt: null,
  connectedAt: 1,
  endpoint: null,
};

const LONG_NQ: Position = {
  accountId: 'paper-1',
  instrument: 'NQZ6.CME',
  qty: 1,
  avgPrice: 29845.75,
  realizedPnl: { amount: 0, currency: 'USD' },
  unrealizedPnl: null,
  mark: null,
  openedAt: 0,
};

const holding = (positions: readonly Position[]): FakeClient => ({
  request: () => new Promise(() => undefined),
  state: { getSnapshot: () => DOWN, subscribe: () => () => undefined },
  subscribe: topicFeed({ positions: positions.map((position) => ({ position })) }).subscribe,
});

afterEach(() => {
  cleanup();
  setActiveChartRef(null);
});

describe('the status line with a position while the runtime is down', () => {
  it('keeps the open position out of the outage sentence', async () => {
    render(
      <TestRuntime client={holding([LONG_NQ])}>
        <ShellDataContext.Provider value={EMPTY_SHELL_DATA}>
          <Annunciator />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
    const line = screen.getByRole('status');
    await waitFor(() => expect(within(line).getByText('Long 1 NQ Z6 open.')).toBeTruthy());
    expect(line.querySelector('.src')?.textContent).toBe('Runtime');
    expect(line.querySelector('.t-annun-message')?.textContent).toMatch(/dropped/);
    expect(line.querySelector('.t-annun-message')?.textContent ?? '').not.toMatch(/Long 1 NQ Z6 open/);
    expect(line.textContent).not.toMatch(/Runtime\s+Long/);
  });

  it('does not keep an empty exposure slot when nothing is open', () => {
    render(
      <TestRuntime client={holding([])}>
        <ShellDataContext.Provider value={EMPTY_SHELL_DATA}>
          <Annunciator />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
    const line = screen.getByRole('status');
    expect(within(line).queryByText(/ open\.$/)).toBeNull();
    expect(line.querySelector('.src')?.textContent).toBe('Runtime');
    expect(line.querySelector('.t-annun-message')?.textContent).toMatch(/dropped/);
  });
});

const NQ = 'NQZ6.CME-RITHMIC';

const globexDay = (tradeDate: string, open: string, close: string) => ({
  calendar: 'cme_equity_index' as const,
  tradeDate,
  open: nsAt(open),
  close: nsAt(close),
  segments: [{ start: nsAt(open), end: nsAt(close) }],
  rth: { start: nsAt(`${tradeDate}T09:30:00-05:00`), end: nsAt(`${tradeDate}T16:00:00-05:00`) },
  earlyClose: false,
});

const NQ_WEEK: SessionsOutput = {
  instrument: NQ,
  hours: {
    calendar: 'cme_equity_index',
    market: 'CME equity index',
    tz: 'America/New_York',
    days: 'Sun–Fri',
    opens: '18:00',
    opensDayBefore: true,
    closes: '17:00',
    rth: { start: '09:30', end: '16:00' },
  },
  sessions: [
    globexDay('2026-11-05', '2026-11-04T18:00:00-05:00', '2026-11-05T17:00:00-05:00'),
    globexDay('2026-11-06', '2026-11-05T18:00:00-05:00', '2026-11-06T17:00:00-05:00'),
  ],
  holidays: [],
};

const APEX_STALE: ProviderHealth = {
  providerId: 'apex',
  kind: 'market_data',
  displayName: 'Apex · Rithmic',
  status: 'degraded',
  latencyMs: null,
  lastMessageAt: null,
  message: 'Connection lost (timeout). Reconnecting, attempt 2.',
  checkedAt: 0,
};

function chartingNq(at: string, providers: ProviderHealth[] = []) {
  const layout: Layout = {
    id: 'desk',
    name: 'Desk',
    revision: 1,
    updatedAt: 0,
    activeChartId: 'chart-1',
    dock: null,
    trade: null,
    charts: { 'chart-1': defaultChartState('chart-1', 'NQ', NQ, '1m', null) },
  };
  putLayout(layout);
  setActiveChartRef({ layoutId: 'desk', tileId: 'chart-1', source: null });
  const { client } = answeringClient({ 'market.get_sessions': () => NQ_WEEK });
  setTestServices(client);
  seedTools(['market.get_sessions']);
  const clock = new RuntimeClock();
  clock.now = () => Date.parse(at);
  render(
    <TestRuntime client={client} clock={clock}>
      <ShellDataContext.Provider value={{ ...EMPTY_SHELL_DATA, providers }}>
        <Annunciator />
      </ShellDataContext.Provider>
    </TestRuntime>,
  );
}

describe('the status line while the charted market is closed', () => {
  it('says the daily halt and when it reopens, not that the feed is reconnecting', async () => {
    chartingNq('2026-11-05T17:05:00-05:00');
    const line = await screen.findByRole('status');
    await waitFor(() =>
      expect(line.querySelector('.t-annun-message')?.textContent).toBe('Daily halt · opens 18:00 ET'),
    );
    expect(line.querySelector('.src')?.textContent).toBe('NQ Z6');
    expect(line.textContent).not.toMatch(/Reconnecting|No data/);
  });

  it('says nothing while the market is open and nothing is wrong', async () => {
    chartingNq('2026-11-05T18:05:00-05:00');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('still puts a connection that is really in trouble first', async () => {
    chartingNq('2026-11-05T17:05:00-05:00', [APEX_STALE]);
    const line = await screen.findByRole('status');
    expect(line.querySelector('.src')?.textContent).toBe('Apex · Rithmic');
    expect(line.textContent).not.toMatch(/Daily halt/);
  });
});
