import type { ChartApi, IndicatorLayer, LevelSpec } from '@tessera/chart';
import type { ChartLayer, DrawnLayerKind, Level } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { LayerReconciler, layerFactory, registeredLayerKinds, type LevelsSink } from '../src/chart/layers/index.ts';

const DRAWN: Record<DrawnLayerKind, true> = {
  volume: true,
  vwap: true,
  sma: true,
  ema: true,
  wma: true,
  levels: true,
  rsi: true,
  atr: true,
  bollinger: true,
  macd: true,
  stochastic: true,
  footprint: true,
  volume_profile: true,
  market_profile: true,
  delta: true,
  effort: true,
  stacked_imbalance: true,
  opening_range: true,
  big_trades: true,
  custom: true,
};

function fakeChart() {
  const added: { id: string; label?: string; layer: IndicatorLayer }[] = [];
  const chart = {
    addLayer: vi.fn((layer: IndicatorLayer) => {
      added.push({ id: layer.id, label: layer.label, layer });
      return {} as never;
    }),
    removeLayer: vi.fn((id: string) => {
      const i = added.findIndex((a) => a.id === id);
      if (i >= 0) added.splice(i, 1);
      return i >= 0;
    }),
    setLayerVisible: vi.fn(),
    setOptions: vi.fn(),
  };
  return { chart: chart as unknown as ChartApi, fns: chart, added };
}

function sink() {
  const byLayer = new Map<string, readonly LevelSpec[]>();
  const s: LevelsSink = {
    set: (id, specs) => byLayer.set(id, specs),
    remove: (id) => byLayer.delete(id),
  };
  return { s, byLayer };
}

const layer = (id: string, kind: string, params: unknown, visible = true): ChartLayer => ({
  id,
  kind,
  params: params as ChartLayer['params'],
  visible,
  namespace: 'user',
  sessionId: null,
});

const pdh: Level = {
  key: 'tessera.concepts.pdh',
  instrument: 'QQQ',
  label: 'Prior high',
  short: 'PDH',
  group: 'pd',
  price: 490,
  unavailableReason: null,
  nativePrice: null,
  source: {
    vendor: 'Tessera',
    package: 'Concepts',
    field: 'pdh',
    basis: 'QQQ',
    endpoint: null,
    asOf: 0,
    conversion: null,
  },
  concept: null,
};

describe('chart layer factories', () => {
  it('every kind the runtime marks drawn has a factory, and only those', () => {
    expect(registeredLayerKinds()).toEqual(Object.keys(DRAWN).sort());
    expect(layerFactory('sessions')).toBeNull();
    expect(layerFactory('footprint')?.label(layer('f', 'footprint', {}))).toBe('Footprint 3:1');
    expect(layerFactory('delta')?.label(layer('d', 'delta', { inputs: { mode: 'bar' } }))).toBe('Δ');
    expect(layerFactory('volume_profile')?.label(layer('p', 'volume_profile', { inputs: { period: 'visible' } }))).toBe(
      'VP visible',
    );
    expect(layerFactory('vwap')?.label(layer('v', 'vwap', { bands: [1, 2] }))).toBe('VWAP');
    expect(layerFactory('sma')?.label(layer('s', 'sma', { period: 50 }))).toBe('SMA 50');
    expect(layerFactory('rsi')?.label(layer('r', 'rsi', {}))).toBe('RSI 14');
    expect(layerFactory('macd')?.label(layer('m', 'macd', { inputs: { fast: 8 } }))).toBe('MACD 8 26 9');
  });

  it('reconciles model layers into chart drawings, params and visibility included', () => {
    const { chart, fns, added } = fakeChart();
    const { s, byLayer } = sink();
    const r = new LayerReconciler();
    const ctx = { chart, levels: [pdh], levelsSink: s };
    r.reconcile(
      [
        layer('vol', 'volume', { mode: 'pane' }),
        layer('v', 'vwap', { bands: [1] }),
        layer('pd', 'levels', { group: 'pd' }),
        layer('r', 'rsi', {}),
        layer('x', 'sessions', {}),
      ],
      ctx,
    );
    expect(r.drawn().sort()).toEqual(['pd', 'r', 'v', 'vol']);
    expect(added.map((a) => [a.id, a.label])).toEqual([
      ['model:vol', 'Vol'],
      ['model:v', 'VWAP'],
      ['model:r', 'RSI 14'],
    ]);
    expect(added[0]!.layer.pane).toBe('pane:model:vol');
    expect(added[0]!.layer.paneHeight).toBe(0.1);
    expect(added[1]!.layer.pane).toBe('main');
    expect(byLayer.get('pd')?.map((x) => x.id)).toEqual(['tessera.concepts.pdh']);
    const rsi = added[2]!.layer;
    const setInputs = vi.spyOn(rsi, 'setInputs');
    const setStyle = vi.spyOn(rsi, 'setStyle');
    r.reconcile(
      [
        layer('vol', 'volume', {}, false),
        layer('v', 'vwap', { bands: [1, 2] }),
        layer('pd', 'levels', { group: 'pd' }, false),
        layer('r', 'rsi', { inputs: { length: 21 }, height: 0.25 }),
        layer('e', 'ema', { period: 21 }),
      ],
      ctx,
    );
    expect(setInputs).toHaveBeenCalledTimes(1);
    expect(setInputs.mock.calls[0]![0]).toMatchObject({ length: 21 });
    expect(rsi.label).toBe('RSI 21');
    expect(rsi.paneHeight).toBe(0.25);
    expect(added[0]!.layer.paneOrder).toBe(0);
    expect(rsi.paneOrder).toBe(3);
    expect(added.map((a) => a.layer.label)).toEqual(['Vol', 'VWAP', 'RSI 21', 'EMA 21']);
    expect(fns.setLayerVisible).toHaveBeenCalledWith('model:vol', false);
    expect(byLayer.get('pd')).toEqual([]);
    r.reconcile([layer('r', 'rsi', { inputs: { length: 21 }, style: { plots: { rsi: { color: 'brass' } } } })], ctx);
    expect(setInputs).toHaveBeenCalledTimes(1);
    expect(setStyle).toHaveBeenCalled();
    expect(rsi.plotStyle('rsi').color).toBe('#d8b26a');
    expect(rsi.paneOrder).toBe(0);
    expect(added.map((a) => a.id)).toEqual(['model:r']);
    expect(byLayer.has('pd')).toBe(false);
    r.dispose();
    expect(added).toEqual([]);
  });
});
