import { type BigTradesLayer, type ChartApi, type Grouping } from '@tessera/chart';
import type { ChartLayer } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { layerFactory, type LayerContext } from '../src/chart/layers/index.ts';
import type { BigTradeFilter } from '../src/market/flow/bigTrades.ts';
import type { FlowHub } from '../src/market/flow/hub.ts';

const CUTS = { low: 63, medium: 120, high: 180 };

function countingFlow() {
  const counts = { acquired: 0, released: 0, uses: 0, usesReleased: 0, dropped: 0 };
  const filters: BigTradeFilter[] = [];
  const groupings: Grouping[] = [];
  const feed = {
    cuts: CUTS,
    cutFor: (tier: keyof typeof CUTS) => CUTS[tier],
    sizing: false,
    statusFor: () => null,
    gaps: [],
    changed: { on: () => () => undefined },
    demand: (filter: BigTradeFilter) => {
      filters.push(filter);
      return { set: (next: BigTradeFilter) => filters.push(next), drop: () => counts.dropped++ };
    },
  };
  const flow = {
    info: { aggressorSource: null },
    clock: { now: () => 0 },
    useBigTrades: (grouping: Grouping) => {
      counts.uses++;
      groupings.push(grouping);
      return { feed, release: () => counts.usesReleased++ };
    },
  };
  const hub = {
    acquire: () => {
      counts.acquired++;
      return { flow, release: () => counts.released++ };
    },
  };
  return { hub: hub as unknown as FlowHub, counts, filters, groupings };
}

function fakeChart(): ChartApi {
  return {
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    setLayerVisible: vi.fn(),
    getViewport: () => ({ fromTime: 1_000, toTime: 2_000 }),
    on: () => () => undefined,
  } as unknown as ChartApi;
}

const model: ChartLayer = {
  id: 'bt',
  kind: 'big_trades',
  params: {},
  visible: true,
  namespace: 'user',
  sessionId: null,
};

const ctxFor = (hub: FlowHub, chart: ChartApi, instrument: string, tf: LayerContext['tf']): LayerContext => ({
  chart,
  levels: [],
  levelsSink: { set: () => undefined, remove: () => undefined },
  instrument,
  tf,
  spec: { tickSize: 0.25, priceDecimals: 2 } as LayerContext['spec'],
  flow: hub,
});

describe('big trades settings on a linked chart', () => {
  it('keeps its feed through a change of size, Auto or Show size, and moves to another feed for another grouping', () => {
    const { hub, counts, filters, groupings } = countingFlow();
    const chart = fakeChart();
    const ctx = ctxFor(hub, chart, 'NQZ6.CME', '1m');
    const withInputs = (inputs: Record<string, number | boolean | string>): ChartLayer => ({
      ...model,
      params: { inputs },
    });
    const binding = layerFactory('big_trades')!.create(model, ctx);
    binding.update(withInputs({ size: 'fixed', minSize: 60 }), ctx, 0);
    const layer = vi.mocked(chart.addLayer).mock.calls[0]![0] as BigTradesLayer;
    expect(layer.options.legend).toBe('≥ 60');
    binding.update(withInputs({ size: 'fixed', minSize: 60, maxSize: 200 }), ctx, 0);
    expect(layer.options.legend).toBe('60–200');
    binding.update(withInputs({ size: 'fixed', minSize: 60, maxSize: 200, showSize: false }), ctx, 0);
    binding.update(withInputs({ size: 'auto', showSize: false }), ctx, 0);
    expect(layer.options.legend).toBe('Auto low ≥ 63');
    binding.update(withInputs({ size: 'auto', tier: 'high', showSize: false }), ctx, 0);
    expect(layer.options.legend).toBe('Auto high ≥ 180');
    expect(layer.optionNotes()).toEqual({ 'tier.low': '≥ 63', 'tier.medium': '≥ 120', 'tier.high': '≥ 180' });
    expect(counts.uses).toBe(1);
    expect(filters).toEqual([
      { kind: 'size', min: 60, max: null },
      { kind: 'size', min: 60, max: 200 },
      { kind: 'auto', tier: 'low' },
      { kind: 'auto', tier: 'high' },
    ]);
    binding.update(withInputs({ size: 'auto', tier: 'high', joinOrders: false }), ctx, 0);
    expect(counts).toMatchObject({ uses: 2, usesReleased: 1, dropped: 1 });
    expect(groupings).toEqual([
      { joinOrders: true, reachLimit: true },
      { joinOrders: false, reachLimit: true },
    ]);
    binding.dispose();
    expect(counts).toMatchObject({ usesReleased: 2, dropped: 2 });
  });
});

describe('big trades across a change of timeframe', () => {
  it('keeps the trades it holds when the timeframe changes, and reads again for another instrument', () => {
    const { hub, counts } = countingFlow();
    const chart = fakeChart();
    const ctx = (instrument: string, tf: LayerContext['tf']) => ctxFor(hub, chart, instrument, tf);
    const binding = layerFactory('big_trades')!.create(model, ctx('NQZ6.CME', '1m'));
    binding.update(model, ctx('NQZ6.CME', '1m'), 0);
    expect(counts.uses).toBe(1);

    binding.update(model, ctx('NQZ6.CME', '5m'), 0);
    binding.update(model, ctx('NQZ6.CME', '15m'), 0);
    expect(counts.uses).toBe(1);
    expect(counts.usesReleased).toBe(0);

    binding.update(model, ctx('ESZ6.CME', '15m'), 0);
    expect(counts.uses).toBe(2);
    expect(counts.usesReleased).toBe(1);

    binding.dispose();
    expect(counts.usesReleased).toBe(2);
  });
});
