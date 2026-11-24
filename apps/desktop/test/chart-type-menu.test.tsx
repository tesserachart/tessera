import type { ChartLayer, Layout } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIEW, defaultChartState, putLayout, setStageView } from '../src/state/layouts.ts';
import type { FakeClient } from './support/runtime.tsx';

let current: ChartLayer[] = [];
vi.mock('../src/workspace/controller.ts', () => ({
  layoutSaved: () => Promise.resolve(),
  setChartType: () => Promise.resolve(),
  setChartTimeframe: () => Promise.resolve(),
  updateChart: (_layout: string, _tile: string, fn: (c: { layers: ChartLayer[] }) => { layers: ChartLayer[] }) => {
    current = fn({ layers: current }).layers;
    return Promise.resolve();
  },
}));

const { ChartTypeMenu } = await import('../src/chart/ChartTools.tsx');
const { TestRuntime } = await import('./support/runtime.tsx');

const chart = { layoutId: 'types', tileId: 'chart-1', instrument: 'NQZ6.CME', tf: '5m' as const, printBars: null };
const layer = (kind: string, visible = true): ChartLayer => ({
  id: `${kind}-1`,
  kind,
  params: {},
  visible,
  namespace: 'user',
  sessionId: null,
});

function mount(layers: ChartLayer[], client: FakeClient = {}) {
  current = layers;
  const layout: Layout = {
    id: chart.layoutId,
    name: 'Scalp',
    revision: 1,
    updatedAt: 0,
    activeChartId: chart.tileId,
    dock: null,
    trade: null,
    charts: { [chart.tileId]: { ...defaultChartState(chart.tileId, 'NQ', chart.instrument, '5m', null), layers } },
  };
  putLayout(layout);
  setStageView(chart.layoutId, { ...DEFAULT_VIEW, v: 3 });
  render(
    <TestRuntime client={client}>
      <TooltipProvider>
        <ChartTypeMenu chart={chart} />
      </TooltipProvider>
    </TestRuntime>,
  );
  fireEvent.keyDown(screen.getByRole('button', { name: 'Chart type: Candles' }), { key: 'Enter' });
}

const item = (name: string) => screen.getByRole('menuitemcheckbox', { name: new RegExp(`^${name}`) });

afterEach(cleanup);

describe('the chart-type menu', () => {
  it('shows Footprint and Volume profile as drawn on a chart that draws them, and turns them off and on', () => {
    mount([layer('footprint'), layer('volume_profile'), layer('vwap')]);
    expect(document.body.textContent).not.toContain('not in this build');
    expect(item('Footprint').getAttribute('aria-checked')).toBe('true');
    expect(item('Volume profile').getAttribute('aria-checked')).toBe('true');
    expect(item('Footprint').getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(item('Footprint'));
    expect(current.find((l) => l.kind === 'footprint')?.visible).toBe(false);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('adds a footprint to a chart that has none', () => {
    mount([layer('vwap')]);
    expect(item('Footprint').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item('Footprint'));
    expect(current.map((l) => l.kind)).toEqual(['vwap', 'footprint']);
  });

  it('greys one out only when the runtime says the connection cannot draw it, and says what it needs', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 'ok',
        callId: 'c',
        durationMs: 1,
        error: null,
        output: {
          kinds: [
            {
              kind: 'footprint',
              title: 'Footprint',
              description: '',
              drawn: true,
              available: false,
              requires: 'footprint',
              reason: 'no aggressor',
              paramsSchema: {},
              indicator: null,
            },
          ],
        },
      }),
    );
    mount([layer('vwap')], { request });
    await act(async () => {
      await Promise.resolve();
    });
    expect(item('Footprint').getAttribute('aria-disabled')).toBe('true');
    expect(item('Footprint').textContent).toContain('Needs trades with aggressor');
    expect(item('Volume profile').getAttribute('aria-disabled')).toBeNull();
    expect(request).toHaveBeenCalledWith(
      'tools.invoke',
      expect.objectContaining({ name: 'chart.list_layer_kinds', input: { layoutId: 'types', tileId: 'chart-1' } }),
      expect.anything(),
    );
  });
});
