import type { ChartHours, Layout, SessionsOutput } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultChartState, putLayout } from '../src/state/layouts.ts';
import { ns } from './support/time.ts';

const setChartHours = vi.fn((_hours: ChartHours, _tile: { layoutId: string; tileId: string }) => Promise.resolve());
vi.mock('../src/workspace/controller.ts', () => ({ setChartHours }));

const { HoursPill } = await import('../src/chart/HoursPill.tsx');
const { TestRuntime, answeringClient, seedTools, setTestServices } = await import('./support/runtime.tsx');

const ny = (at: string) => Date.parse(`2026-10-02T${at}:00-04:00`);
const ES: SessionsOutput = {
  instrument: 'ESZ6.CME',
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
    {
      calendar: 'cme_equity_index',
      tradeDate: '2026-10-02',
      open: ns(Date.parse('2026-10-01T18:00:00-04:00')),
      close: ns(ny('17:00')),
      segments: [{ start: ns(Date.parse('2026-10-01T18:00:00-04:00')), end: ns(ny('17:00')) }],
      rth: { start: ns(ny('09:30')), end: ns(ny('16:00')) },
      earlyClose: false,
    },
  ],
  holidays: [],
};
const BTC: SessionsOutput = { ...ES, instrument: 'BTC-USD', hours: { ...ES.hours, calendar: 'crypto24x7', rth: null } };

const tile = { layoutId: 'hours', tileId: 'chart-1' };

function mount(sessions: SessionsOutput, hours?: ChartHours, printBars = false) {
  const chart = {
    ...defaultChartState(tile.tileId, 'ES', sessions.instrument, '5m', null),
    ...(hours ? { hours } : {}),
  };
  const layout: Layout = {
    id: tile.layoutId,
    name: 'Hours',
    revision: 1,
    updatedAt: 0,
    activeChartId: tile.tileId,
    dock: null,
    trade: null,
    charts: { [tile.tileId]: chart },
  };
  putLayout(layout);
  const { client } = answeringClient({ 'market.get_sessions': () => sessions });
  setTestServices(client);
  seedTools(['market.get_sessions']);
  render(
    <TestRuntime client={client}>
      <TooltipProvider>
        <HoursPill
          chart={{
            ...tile,
            instrument: sessions.instrument,
            tf: '5m',
            printBars: printBars ? { kind: 'tick', size: 500 } : null,
          }}
        />
      </TooltipProvider>
    </TestRuntime>,
  );
}

afterEach(() => {
  cleanup();
  setChartHours.mockClear();
});

describe('the chart’s hours pill', () => {
  it('shows the hours the chart draws and switches them for that chart', async () => {
    mount(ES, 'rth');
    const pill = await screen.findByRole('button', { name: 'Chart hours: Regular hours' });
    expect(pill.textContent).toBe('RTH');
    fireEvent.keyDown(pill, { key: 'Enter' });
    const regular = screen.getByRole('menuitemradio', { name: /^Regular hours/ });
    expect(regular.getAttribute('aria-checked')).toBe('true');
    expect(regular.textContent).toContain('09:30–16:00');
    const extended = screen.getByRole('menuitemradio', { name: /^Extended hours/ });
    expect(extended.textContent).toContain('18:00–17:00');
    fireEvent.click(extended);
    expect(setChartHours).toHaveBeenCalledWith('eth', tile);
  });

  it('reads every hour on a chart never set', async () => {
    mount(ES);
    expect((await screen.findByRole('button', { name: 'Chart hours: Extended hours' })).textContent).toBe('ETH');
  });

  it('is not shown where hours have no meaning: a market open around the clock, or bars built from prints', async () => {
    mount(BTC, 'rth');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /^Chart hours/ })).toBeNull();
    cleanup();
    mount(ES, 'rth', true);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /^Chart hours/ })).toBeNull();
  });
});
