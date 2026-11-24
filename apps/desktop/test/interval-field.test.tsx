import type { PrintBars, Timeframe } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseInterval, printBarChoices, savedIntervalTexts, withPresets } from '../src/market/instruments.ts';
import { patch, read } from '../src/app/store.ts';
import { readPreferences } from '../src/state/settingsSync.ts';
import { DEFAULT_UI, uiStore } from '../src/state/ui.ts';

const picked: { tf: Timeframe; printBars: PrintBars | null }[] = [];
vi.mock('../src/workspace/controller.ts', () => ({
  layoutSaved: () => Promise.resolve(),
  setChartType: () => Promise.resolve(),
  updateChart: () => Promise.resolve(),
  activateChart: () => undefined,
  setChartTimeframe: (tf: Timeframe, _chart: unknown, printBars: PrintBars | null) => {
    picked.push({ tf, printBars });
    return Promise.resolve();
  },
}));

const { IntervalTools } = await import('../src/chart/ChartTools.tsx');

describe('reading a typed interval', () => {
  it('reads any timeframe and any tick, range, volume, delta or renko size', () => {
    expect(parseInterval('15s')).toEqual({ tf: '15s', printBars: null });
    expect(parseInterval(' 2 days ')).toEqual({ tf: '2D', printBars: null });
    expect(parseInterval('90')).toEqual({ tf: '90m', printBars: null });
    expect(parseInterval('120s')).toEqual({ tf: '2m', printBars: null });
    expect(parseInterval('377T')).toEqual({ tf: null, printBars: { kind: 'tick', size: 377 } });
    expect(parseInterval('1,500 ticks')).toEqual({ tf: null, printBars: { kind: 'tick', size: 1500 } });
    expect(parseInterval('6r')).toEqual({ tf: null, printBars: { kind: 'range', size: 6 } });
    expect(parseInterval('2500 volume')).toEqual({ tf: null, printBars: { kind: 'volume', size: 2500 } });
    expect(parseInterval('300Δ')).toEqual({ tf: null, printBars: { kind: 'delta', size: 300 } });
    expect(parseInterval('1,000 delta')).toEqual({ tf: null, printBars: { kind: 'delta', size: 1000 } });
    expect(parseInterval('8Rk')).toEqual({ tf: null, printBars: { kind: 'renko', size: 8 } });
    expect(parseInterval('12 renko')).toEqual({ tf: null, printBars: { kind: 'renko', size: 12 } });
    expect(parseInterval('3d')).toEqual({ tf: '3D', printBars: null });
    for (const bad of ['', 'soon', '0t', '25h', '100001t', '1W']) expect(parseInterval(bad), bad).toBeNull();
  });

  it('lists a custom timeframe among the presets, in order', () => {
    expect(withPresets(['7m', '2D', '1m', null])).toEqual([
      '1s',
      '15s',
      '30s',
      '1m',
      '5m',
      '7m',
      '15m',
      '30m',
      '1h',
      '4h',
      '1D',
      '2D',
    ]);
    const ticks377 = { tf: null, printBars: { kind: 'tick', size: 377 } } as const;
    expect(printBarChoices('tick', [ticks377]).map((b) => b.size)).toEqual([100, 377, 500, 1000]);
    expect(printBarChoices('range', [ticks377]).map((b) => b.size)).toEqual([4, 10, 20]);
    const renko8 = { tf: null, printBars: { kind: 'renko', size: 8 } } as const;
    expect(printBarChoices('renko', [renko8]).map((b) => b.size)).toEqual([4, 8, 10, 20]);
    expect(printBarChoices('delta', [renko8]).map((b) => b.size)).toEqual([100, 300, 500]);
  });

  it('keeps saved intervals as one canonical text each, time before print bars', () => {
    expect(savedIntervalTexts(['8rk', '377t', '120s', '300 delta', '1h', '2 days', 'soon', '2m', '6R'])).toEqual([
      '2m',
      '1h',
      '2D',
      '377T',
      '6R',
      '300Δ',
      '8Rk',
    ]);
    expect(readPreferences({ favouriteIntervals: ['15s', '377T', 'junk', '60m'] }).favouriteIntervals).toEqual([
      '15s',
      '1h',
      '377T',
    ]);
  });
});

describe('the interval menu', () => {
  beforeEach(() => {
    picked.length = 0;
    patch(uiStore, { favouriteIntervals: DEFAULT_UI.favouriteIntervals });
  });
  afterEach(cleanup);

  function mount(tf: Timeframe) {
    render(
      <TooltipProvider>
        <IntervalTools chart={{ layoutId: 'l', tileId: 't', instrument: 'NQZ6.CME', tf, printBars: null }} />
      </TooltipProvider>,
    );
  }

  function open(tf: Timeframe = '5m') {
    mount(tf);
    fireEvent.keyDown(screen.getByRole('button', { name: 'All intervals' }), { key: 'Enter' });
    return screen.getByRole('textbox', { name: 'Interval' });
  }

  it('shows any interval the trader types', () => {
    const field = open();
    fireEvent.change(field, { target: { value: '15s' } });
    expect(within(screen.getByRole('group', { name: 'Any interval' })).getByText('15 seconds')).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(picked).toEqual([{ tf: '15s', printBars: null }]);
  });

  it('draws tick bars of any size', () => {
    const field = open();
    fireEvent.change(field, { target: { value: '377t' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(picked).toEqual([{ tf: '5m', printBars: { kind: 'tick', size: 377 } }]);
  });

  it('says plainly when the text is not an interval', () => {
    const field = open();
    fireEvent.change(field, { target: { value: 'soon' } });
    expect(screen.getByRole('alert').textContent).toBe('Not an interval');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(picked).toEqual([]);
  });

  it('keeps a custom timeframe in the tab row while it is shown', () => {
    mount('7m');
    const tabs = screen.getByRole('group', { name: 'Timeframe' });
    expect(within(tabs).getByRole('button', { name: '7m', pressed: true })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'All intervals' }), { key: 'Enter' });
    expect(screen.getByRole('menuitemradio', { name: /7 minutes/ }).getAttribute('aria-checked')).toBe('true');
  });

  const tabRow = () =>
    within(screen.getByRole('group', { name: 'Timeframe' }))
      .getAllByRole('button')
      .map((b) => b.textContent);

  it('saves a typed interval to the tab row, where it stays after the chart moves on', () => {
    const field = open();
    fireEvent.change(field, { target: { value: '15s' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(picked).toEqual([{ tf: '15s', printBars: null }]);
    expect(read(uiStore).favouriteIntervals).toContain('15s');
    cleanup();
    mount('5m');
    expect(tabRow()).toEqual(['15s', '1m', '5m', '15m', '1h', '1D']);
  });

  it('saves tick bars of any size too, with Ctrl or Cmd and Enter', () => {
    const field = open();
    fireEvent.change(field, { target: { value: '377 ticks' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(picked).toEqual([{ tf: '5m', printBars: { kind: 'tick', size: 377 } }]);
    cleanup();
    mount('5m');
    expect(tabRow()).toContain('377T');
    fireEvent.click(within(screen.getByRole('group', { name: 'Timeframe' })).getByRole('button', { name: '377T' }));
    expect(picked.at(-1)).toEqual({ tf: '5m', printBars: { kind: 'tick', size: 377 } });
  });

  it('lists delta and renko bars beside tick, range and volume bars', () => {
    open();
    const groups = screen.getAllByRole('menuitemradio').map((i) => i.textContent);
    expect(groups).toEqual(expect.arrayContaining(['300 delta300Δ', '10 ticks renko10Rk']));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /300 delta/ }));
    expect(picked.at(-1)).toEqual({ tf: '5m', printBars: { kind: 'delta', size: 300 } });
    cleanup();
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /10 ticks renko/ }));
    expect(picked.at(-1)).toEqual({ tf: '5m', printBars: { kind: 'renko', size: 10 } });
  });

  it('shows without saving on a plain Enter', () => {
    const field = open();
    fireEvent.change(field, { target: { value: '45s' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(read(uiStore).favouriteIntervals).not.toContain('45s');
  });

  it('takes a saved interval back out from its tab-row tick', () => {
    patch(uiStore, { favouriteIntervals: ['1m', '90m'] });
    open();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '90m' }));
    expect(read(uiStore).favouriteIntervals).toEqual(['1m']);
  });
});
