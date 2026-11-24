import type { ChartApi } from '@tessera/chart';
import type { CandlesOutput, ChartLayer, CustomIndicator, IndicatorObjects, IndicatorSpec } from '@tessera/protocol';
import { INDICATOR_SPECS } from '@tessera/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addCustomIndicator,
  layerSpec,
  resolveIndicator,
  withPaneHeights,
  withSettings,
} from '../src/chart/indicators.ts';
import { drawnLineLabels, engineObjects, objectInk } from '../src/chart/layers/custom.ts';
import { LayerReconciler, type LayerContext } from '../src/chart/layers/registry.ts';
import { catalogGroups } from '../src/chart/settings/catalog.ts';
import { readTemplates } from '../src/chart/templates/model.ts';
import { problemOf, retainCatalog, setCatalog, setProblem, customStore } from '../src/indicators/custom.ts';
import { NEW_INDICATOR_CODE, retitle } from '../src/areas/indicators/model.ts';
import { patch, read } from '../src/app/store.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { pause } from './support/pause.ts';
import { seriesSnapshot } from './support/series.ts';

const SPEC: IndicatorSpec = {
  kind: 'custom',
  title: 'Stretch',
  short: 'STR',
  group: 'custom',
  placement: 'pane',
  inputs: [
    {
      key: 'length',
      label: 'Length',
      type: 'int',
      default: 20,
      min: 2,
      max: 500,
      step: 1,
      options: null,
      inLabel: true,
    },
  ],
  plots: [
    {
      key: 'pct',
      label: 'Pct',
      kind: 'histogram',
      colorBy: 'sign',
      value: null,
      valueInput: null,
      shownBy: null,
      default: { color: 'mist', downColor: 'down', width: 1.5, line: 'solid', opacity: 1, visible: true },
    },
  ],
  fills: [],
  range: null,
  height: 0.2,
  sessionReset: false,
  format: 'number',
};

const CUSTOM: CustomIndicator = {
  id: 'ci_1',
  version: 1,
  latest: 1,
  spec: SPEC,
  description: null,
  createdAt: 0,
  updatedAt: 0,
  createdBy: 'user',
};

const NS = 1_000_000;
const T = (k: number) => 1_700_000_000_000 + k * 300_000;

function candles(ks: readonly number[]): CandlesOutput {
  return {
    instrument: 'QQQ',
    tf: '5m',
    priceDecimals: 2,
    tz: 'America/New_York',
    columns: ['t', 'o', 'h', 'l', 'c', 'v'],
    bars: ks.map((k) => [T(k) * NS, 100, 101, 99, 100.5, 10]),
    lastBarOpen: true,
    provider: 'mock-market',
  };
}

const update = (rev: number, times: number[], values: number[]) =>
  seriesSnapshot(rev, times, { pct: values }, { indicator: 'ci_1', version: 1 });

afterEach(() => {
  patch(customStore, { byId: {}, list: [], loaded: false, problems: {} });
});

describe('custom indicators on the chart', () => {
  it('reads a custom layer by the catalog, and keeps naming its indicator as its settings change', () => {
    const { layers, id } = addCustomIndicator([], 'ci_1');
    expect(id).toBe('custom-1');
    expect(layers[0]!.params).toEqual({ indicator: 'ci_1' });
    expect(layerSpec(layers[0]!)).toBeNull();
    expect(layerSpec(layers[0]!, { ci_1: CUSTOM })?.title).toBe('Stretch');
    setCatalog([CUSTOM]);
    const spec = layerSpec(layers[0]!)!;
    expect(spec.title).toBe('Stretch');
    expect(layerSpec(layers[0]!, {})).toBeNull();
    const settings = resolveIndicator(spec, layers[0]!.params);
    const next = withSettings(layers, 'custom-1', { ...settings, inputs: { length: 50 } });
    expect(next[0]!.params).toMatchObject({ indicator: 'ci_1', inputs: { length: 50 } });
    const dragged = withPaneHeights(next, [{ id: 'pane:model:custom-1', height: 0.3 }]);
    expect(dragged?.[0]!.params).toMatchObject({ indicator: 'ci_1', height: 0.3 });
  });

  it('draws objects in their colour, a label in its line’s, and the indicator’s or the analyst’s where none is given', () => {
    const palette = { t2: '#c0c0c0', aqua: '#00e5ff', teal: '#18849a' };
    const o: IndicatorObjects = {
      lines: [
        {
          time1: T(1) * NS,
          price1: 1,
          time2: T(3) * NS,
          price2: 2,
          color: '#9d8cf2',
          width: 1,
          line: 'dash',
          extend: 'right',
          label: { text: 'Asia H', at: 'end', side: 'above', color: null },
        },
        {
          time1: T(1) * NS,
          price1: 1,
          time2: null,
          price2: 1,
          color: null,
          width: 1,
          line: 'solid',
          extend: 'none',
          label: { text: 'x', at: 'start', side: 'below', color: 'teal' },
        },
      ],
      labels: [{ time: T(2) * NS, price: 3, text: 'L', color: null, size: 'small', side: 'at' }],
      boxes: [
        {
          time1: T(1) * NS,
          price1: 1,
          time2: null,
          price2: 2,
          color: 'teal',
          width: 0,
          line: 'solid',
          fill: null,
          opacity: 0.1,
          extend: 'none',
          label: null,
        },
      ],
    };
    const e = engineObjects(o, '#e0a64a', palette);
    expect(e.lines[0]).toMatchObject({ t1: T(1), t2: T(3), color: '#9d8cf2', extend: 'right', line: 'dash' });
    expect(e.lines[0]!.label).toEqual({ text: 'Asia H', at: 'end', side: 'above', color: '#9d8cf2' });
    expect(e.lines[1]).toMatchObject({ t2: null, color: '#e0a64a' });
    expect(e.lines[1]!.label!.color).toBe('#18849a');
    expect(e.labels[0]).toMatchObject({ t: T(2), color: '#e0a64a', size: 'small', side: 'at' });
    expect(e.boxes[0]).toMatchObject({ color: '#18849a', fill: '#18849a', t2: null });
    expect(engineObjects(null, '#fff').lines).toEqual([]);

    const line = { color: '#e0a64a', width: 1, line: 'solid' as const, opacity: 1, visible: true };
    const withLine: IndicatorSpec = {
      ...SPEC,
      plots: [{ ...SPEC.plots[0]!, key: 'v', kind: 'line', colorBy: null }],
    };
    expect(objectInk(withLine, { plots: { v: line }, fills: {} }, false, palette)).toBe('#e0a64a');
    expect(objectInk(withLine, { plots: { v: line }, fills: {} }, true, palette)).toBe('#00e5ff');
    expect(objectInk({ ...SPEC, plots: [] }, { plots: {}, fills: {} }, false, palette)).toBe('#c0c0c0');
  });

  it('says why a custom layer draws nothing, once', () => {
    setProblem('custom-1', { message: "line 3: TypeError: cannot read property 'x' of undefined", line: 3 });
    expect(problemOf('custom-1')?.line).toBe(3);
    setProblem('custom-1', null);
    expect(problemOf('custom-1')).toBeNull();
  });
});

describe('custom indicators from the runtime', () => {
  it('holds one catalog subscription while anything holds it, and takes each catalog it sends', async () => {
    const rt = fakeRuntime();
    const first = retainCatalog();
    const second = retainCatalog();
    const sub = await vi.waitFor(() => rt.sub('indicators.catalog'));
    sub.event({ custom: [CUSTOM] });
    await vi.waitFor(() => expect(read(customStore).loaded).toBe(true));
    expect(read(customStore).list).toEqual([CUSTOM]);
    expect(read(customStore).byId.ci_1?.spec.title).toBe('Stretch');
    first();
    first();
    await pause();
    expect(sub.open).toBe(true);
    second();
    await vi.waitFor(() => expect(sub.open).toBe(false));
    const again = retainCatalog();
    await vi.waitFor(() => expect(rt.subscriptions).toHaveLength(2));
    expect(rt.sub('indicators.catalog')).not.toBe(sub);
    again();
  });

  it('draws a custom layer by the values the runtime computes while it shows, and says why it cannot', async () => {
    const rt = fakeRuntime({ answers: { 'market.get_candles': () => candles([1, 2, 3]) } });
    setCatalog([CUSTOM]);
    const chart = {
      addLayer: vi.fn(),
      removeLayer: vi.fn(() => true),
      setLayerVisible: vi.fn(),
    } as unknown as ChartApi;
    const ctx: LayerContext = {
      chart,
      levels: [],
      levelsSink: { set: () => undefined, remove: () => undefined },
      instrument: 'QQQ',
      tf: '5m',
    };
    const model: ChartLayer = {
      id: 'custom-1',
      kind: 'custom',
      params: { indicator: 'ci_1' },
      visible: true,
      namespace: 'user',
      sessionId: null,
    };
    const r = new LayerReconciler();
    r.reconcile([model], ctx);
    const series = await vi.waitFor(() => rt.sub('indicators.series'));
    expect(series.params).toEqual({
      indicator: 'ci_1',
      inputs: { length: 20 },
      instrument: 'QQQ',
      tf: '5m',
    });
    const catalog = rt.sub('indicators.catalog');
    const asia: IndicatorObjects = {
      lines: [
        {
          time1: T(1) * NS,
          price1: 100,
          time2: null,
          price2: 100,
          color: null,
          width: 1,
          line: 'solid',
          extend: 'none',
          label: { text: 'Asia H', at: 'end', side: 'above', color: null },
        },
      ],
      labels: [],
      boxes: [],
    };
    series.event({ ...update(1, [T(1), T(2)], [1, 2]), objects: asia });
    await vi.waitFor(() => expect(drawnLineLabels('custom-1')).toEqual(['Asia H']));
    series.event({ ...update(2, [], []), error: { message: 'line 3: boom', line: 3 } });
    await vi.waitFor(() => expect(problemOf('custom-1')?.line).toBe(3));
    r.reconcile([model], ctx);
    await pause();
    expect(rt.subscriptions.filter((s) => s.topic === 'indicators.series')).toHaveLength(1);
    r.reconcile([{ ...model, visible: false }], ctx);
    await pause();
    expect(series.open, 'a hidden study stays warm').toBe(true);
    r.reconcile([model], ctx);
    await pause();
    expect(rt.subscriptions.filter((s) => s.topic === 'indicators.series')).toHaveLength(1);
    series.refuse('unknown indicator ci_1');
    await vi.waitFor(() => expect(problemOf('custom-1')?.message).toBe('unknown indicator ci_1'));
    r.dispose();
    await vi.waitFor(() => expect(catalog.open).toBe(false));
    expect(problemOf('custom-1')).toBeNull();
    expect(drawnLineLabels('custom-1')).toEqual([]);
  });
});

describe('custom indicators in templates and the catalog', () => {
  it('keeps custom layers in a template', () => {
    const t = readTemplates({
      templates: [
        {
          id: 'a',
          name: 'Mine',
          layers: [
            { kind: 'custom', params: { indicator: 'ci_1' }, visible: true },
            { kind: 'nope', params: {}, visible: true },
          ],
        },
      ],
    });
    expect(t.templates[0]!.layers.map((l) => l.kind)).toEqual(['custom']);
  });

  it('lists the user’s own indicators first, as Yours', () => {
    const groups = catalogGroups([SPEC, ...INDICATOR_SPECS]);
    expect(groups[0]).toMatchObject({ group: 'custom', label: 'Yours' });
    expect(groups[0]!.specs).toEqual([SPEC]);
    expect(catalogGroups()[0]!.group).toBe('trend');
  });

  it('retitles a copy', () => {
    expect(retitle("export const indicator = {\n  title: 'EMA cross',\n  plots: [],\n};", 'EMA cross copy')).toBe(
      "export const indicator = {\n  title: 'EMA cross copy',\n  plots: [],\n};",
    );
    expect(retitle('export const indicator = { title: "It\\"s", plots: [] };', "Bo's")).toBe(
      "export const indicator = { title: 'Bo\\'s', plots: [] };",
    );
    expect(retitle('export const indicator = {\n  plots: [],\n};', 'A')).toBe(
      "export const indicator = {\n  title: 'A',\n  plots: [],\n};",
    );
    expect(NEW_INDICATOR_CODE).toContain('export function compute(bars, inputs)');
    expect(retitle(NEW_INDICATOR_CODE, 'Mine')).toContain("title: 'Mine',");
  });
});
