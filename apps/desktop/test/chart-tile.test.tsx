import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Loaded } from '@tessera/ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedMeta } from '../src/chart/feed.ts';
import { defaultChartState, putLayout } from '../src/state/layouts.ts';
import { ChartTile } from '../src/workspace/tiles/ChartTile.tsx';
import { connectionInfo, providerHealth } from './support/providers.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

const feed = vi.hoisted(() => ({
  onMeta: null as ((meta: FeedMeta) => void) | null,
  onLoading: null as ((loading: boolean) => void) | null,
  onError: null as ((error: Error | null) => void) | null,
}));
vi.mock('../src/chart/ChartView.tsx', () => ({
  ChartView: (props: {
    onMeta?: (meta: FeedMeta) => void;
    onLoading?: (loading: boolean) => void;
    onError?: (error: Error | null) => void;
  }) => {
    feed.onMeta = props.onMeta ?? null;
    feed.onLoading = props.onLoading ?? null;
    feed.onError = props.onError ?? null;
    return <div className="chart-host" style={{ position: 'absolute', inset: 0 }} />;
  },
}));

const apex = connectionInfo(providerHealth({ providerId: 'rithmic-apex', displayName: 'Apex · Rithmic' }));

beforeEach(() => {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
});

afterEach(() => {
  cleanup();
  feed.onMeta = null;
  feed.onLoading = null;
  feed.onError = null;
});

async function renderChart(wrap: (chart: ReactNode) => ReactNode = (chart) => chart) {
  const { client } = answeringClient({
    'connections.list': () => ({ connections: [apex], dataSource: 'rithmic-apex' }),
  });
  setTestServices(client);
  seedTools(['connections.list']);
  putLayout({
    id: 'trade',
    name: 'Trade',
    revision: 1,
    updatedAt: 0,
    activeChartId: 'c1',
    dock: null,
    trade: null,
    charts: { c1: defaultChartState('c1', 'c1', 'NQZ6.CME', '5m', null) },
  });
  const api = {
    isVisible: true,
    onDidVisibilityChange: () => ({ dispose: () => undefined }),
    setTitle: () => undefined,
  };
  const props = { params: { layoutId: 'trade', tileId: 'c1' }, api } as unknown as Parameters<typeof ChartTile>[0];
  render(<TestRuntime client={client}>{wrap(<ChartTile {...props} />)}</TestRuntime>);
  await vi.waitFor(() => expect(feed.onMeta).not.toBeNull());
}

async function chartFedBy(provider: string) {
  await renderChart();
  act(() => {
    feed.onLoading?.(false);
    feed.onMeta?.({ instrument: 'NQZ6.CME', tf: '5m', source: { provider }, precision: 2, bars: 1500, contracts: [] });
  });
  return screen.getByRole('toolbar', { name: 'Layers' });
}

describe('the layer strip of a chart', () => {
  it('counts the bars with a thousands separator and names the connection as the trader knows it', async () => {
    const strip = await chartFedBy('rithmic-apex');
    await vi.waitFor(() => expect(strip.textContent).toMatch(/1,500 bars · Apex · Rithmic$/));
  });

  it('leaves out a connection it cannot name rather than show its id', async () => {
    const strip = await chartFedBy('rithmic-elsewhere');
    await vi.waitFor(() => expect(strip.textContent).toMatch(/1,500 bars$/));
  });
});

describe('the loading state of a chart', () => {
  it('keeps the chart on its own ground with no words until the bars are drawn, and leaves the footer empty', async () => {
    await renderChart();
    const status = screen.getByRole('status', { name: 'Loading bars' });
    expect(status.textContent).toBe('');
    expect(status.className).toContain('chart-status');
    expect(screen.getByRole('toolbar', { name: 'Layers' }).textContent).not.toMatch(/loading/i);
    act(() => feed.onLoading?.(false));
    expect(screen.queryByRole('status', { name: 'Loading bars' })).toBeNull();
  });

  it('shows the load error in the same place once loading is over, never beneath the cover', async () => {
    await renderChart();
    act(() => feed.onError?.(new Error('unknown instrument')));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Loading bars' }).textContent).toBe('');
    act(() => feed.onLoading?.(false));
    expect(screen.getByRole('status').textContent).toMatch(/unknown instrument/);
  });

  it('never holds back the desk around it while its bars load', async () => {
    await renderChart((chart) => <Loaded label="Loading the desk around the chart">{chart}</Loaded>);
    await vi.waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Loading the desk around the chart' })).toBeNull(),
    );
    expect(screen.getByRole('status', { name: 'Loading bars' })).toBeTruthy();
  });

  it('stands a chart-shaped skeleton in for the bars, and lands them without moving or remounting the chart', async () => {
    const stage = document.createElement('style');
    stage.textContent = readFileSync(join(import.meta.dirname, '../src/styles/stage.css'), 'utf8');
    document.head.append(stage);
    await renderChart();
    const canvas = document.querySelector('.chart-canvas')!;
    const host = canvas.querySelector('.chart-host');
    const status = screen.getByRole('status', { name: 'Loading bars' });
    expect(status.querySelector('.chart-sketch [data-axis="price"]')).not.toBeNull();
    expect(getComputedStyle(status).position).toBe('absolute');
    expect(getComputedStyle(status.querySelector('.chart-sketch')!).position).toBe('absolute');
    const inFlow = () => [...canvas.children].filter((c) => getComputedStyle(c).position !== 'absolute');
    const before = inFlow();
    act(() => {
      feed.onLoading?.(false);
      feed.onMeta?.({
        instrument: 'NQZ6.CME',
        tf: '5m',
        source: { provider: 'mock' },
        precision: 2,
        bars: 1500,
        contracts: [],
      });
    });
    expect(screen.queryByRole('status', { name: 'Loading bars' })).toBeNull();
    expect(canvas.querySelector('.chart-host')).toBe(host);
    expect(inFlow()).toEqual(before);
    stage.remove();
  });

  it('leaves its canvas out of the desk skeleton, since the chart draws by itself', async () => {
    await renderChart();
    expect(document.querySelector('.chart-canvas')?.hasAttribute('skullet-ignore')).toBe(true);
  });
});
