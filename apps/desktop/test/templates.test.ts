import type { ChartLayer, ChartTemplate } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  chartMatches,
  chartTemplateNow,
  chipWords,
  copyName,
  defaultTemplate,
  newChartSetup,
  readTemplates,
  ORDER_FLOW,
  renameProblem,
  templateNamed,
  templateSummary,
} from '../src/chart/templates/model.ts';
import { putTemplates, templatesStore } from '../src/chart/templates/store.ts';
import { chartTypeOf, DEFAULT_VIEW, layersOfSetup } from '../src/state/layouts.ts';
import { readPreferences } from '../src/state/settingsSync.ts';
import { migrateUi } from '../src/state/ui.ts';
import { read } from '../src/app/store.ts';

const layer = (id: string, kind: string, params: Record<string, unknown> = {}, visible = true): ChartLayer => ({
  id,
  kind,
  params: params as ChartLayer['params'],
  visible,
  namespace: 'user',
  sessionId: null,
});

const scalp: ChartTemplate = {
  id: 'scalp',
  name: 'Scalp',
  chartType: 'bars',
  layers: [
    { kind: 'volume', params: {}, visible: true },
    { kind: 'ema', params: { inputs: { length: 9 } }, visible: true },
  ],
};

describe('chart templates as the UI reads them', () => {
  it('reads a stored value leniently, like the runtime', () => {
    const t = readTemplates({
      templates: [
        { id: 'a', name: ' Scalp ', chartType: 'bars', layers: [{ kind: 'ema' }, { kind: 'levels' }, 'x'] },
        { id: 'a', name: 'Again' },
        { id: 'b', name: '   ' },
        { name: 'No id' },
        { id: 'c', name: 'Swing', chartType: 'renko' },
      ],
      defaultId: 'gone',
    });
    expect(t.templates.map((x) => x.name)).toEqual(['Scalp', 'Swing']);
    expect(t.templates[0]?.layers).toEqual([{ kind: 'ema', params: {}, visible: true }]);
    expect(t.templates[0]?.chartType).toBe('bars');
    expect(t.templates[1]?.chartType).toBeUndefined();
    expect(t.defaultId).toBeUndefined();
    expect(readTemplates(null)).toEqual({ templates: [] });
    expect(readTemplates({ templates: [{ id: 'c', name: 'Swing' }], defaultId: 'c' }).defaultId).toBe('c');
  });

  it('finds by name in any case, and refuses a taken or empty name on rename', () => {
    const all = { templates: [scalp, { ...scalp, id: 'swing', name: 'Swing' }], defaultId: 'swing' };
    expect(templateNamed(all, ' SCALP')?.id).toBe('scalp');
    expect(templateNamed(all, 'nope')).toBeNull();
    expect(defaultTemplate(all)?.name).toBe('Swing');
    expect(renameProblem(all, 'scalp', 'swing')).toBe('swing is taken');
    expect(renameProblem(all, 'scalp', '  ')).toBe('A template needs a name');
    expect(renameProblem(all, 'scalp', 'x'.repeat(49))).toBe('At most 48 characters');
    expect(renameProblem(all, 'scalp', 'scalp')).toBeNull();
  });

  it('says whether a chart is set up as a template: same indicators, order, values, visibility and type', () => {
    const chart = [
      layer('volume-1', 'volume'),
      layer('lv', 'levels'),
      layer('ema-1', 'ema', { inputs: { length: 9 } }),
    ];
    expect(chartMatches(chart, 'bars', scalp)).toBe(true);
    const complete = chart.map((l) =>
      l.kind === 'ema' ? { ...l, params: { inputs: { length: 9, source: 'close' } } } : l,
    );
    expect(chartMatches(complete, 'bars', scalp)).toBe(true);
    expect(chartMatches(chart, 'line', scalp)).toBe(false);
    expect(chartMatches(chart, 'line', { ...scalp, chartType: undefined })).toBe(true);
    expect(chartMatches([...chart].reverse(), 'bars', scalp)).toBe(false);
    expect(chartMatches([chart[0]!, layer('ema-1', 'ema', { inputs: { length: 21 } })], 'bars', scalp)).toBe(false);
    expect(chartMatches([chart[0]!, layer('ema-1', 'ema', { inputs: { length: 9 } }, false)], 'bars', scalp)).toBe(
      false,
    );
    expect(chartMatches([chart[0]!], 'bars', scalp)).toBe(false);
  });

  it('starts a new chart from the default template, or with no studies until the runtime answers', () => {
    expect(newChartSetup({ templates: [scalp], defaultId: 'scalp' }, true)).toBe(scalp);
    expect(newChartSetup({ templates: [scalp] }, true)).toBeNull();
    expect(newChartSetup({ templates: [] }, false)).toBeNull();
    expect(layersOfSetup({ layers: [...scalp.layers, { kind: 'ema', params: {}, visible: false }] })).toEqual([
      layer('volume-1', 'volume'),
      layer('ema-1', 'ema', { inputs: { length: 9 } }),
      layer('ema-2', 'ema', {}, false),
    ]);
    expect(layersOfSetup(null)).toEqual([]);
  });

  it('fills the window store from the setting', () => {
    putTemplates({ templates: [scalp], defaultId: 'scalp' });
    expect(read(templatesStore)).toMatchObject({ loaded: true, defaultId: 'scalp' });
    putTemplates({ templates: [scalp] });
    expect(read(templatesStore).defaultId).toBeUndefined();
  });
});

describe('the template a chart shows', () => {
  const scalpChart = [layer('volume-1', 'volume'), layer('ema-1', 'ema', { inputs: { length: 9 } })];
  const clean: ChartTemplate = { id: 'clean', name: 'Clean', layers: [] };

  it('is the template it follows while the chart still matches it', () => {
    const twin = { ...scalp, id: 'twin', name: 'Twin' };
    expect(chartTemplateNow([scalp, twin], scalpChart, 'bars', 'twin')).toEqual({ template: twin, modified: false });
    expect(chartTemplateNow([scalp, twin], scalpChart, 'bars', null)).toEqual({ template: scalp, modified: false });
  });

  it('is the followed template, modified, once the chart differs from it and matches no other', () => {
    const edited = [...scalpChart, layer('rsi-1', 'rsi')];
    const now = chartTemplateNow([scalp], edited, 'bars', 'scalp');
    expect(now).toEqual({ template: scalp, modified: true });
    expect(chipWords(now)).toBe('Scalp · modified');
  });

  it('is whichever template the chart matches after something else set it up', () => {
    expect(chartTemplateNow([scalp, clean], [], 'bars', 'scalp')).toEqual({ template: clean, modified: false });
  });

  it('is the built-in Order flow when the chart draws it, and none when the chart matches nothing it followed', () => {
    const flow = ['footprint', 'volume_profile', 'big_trades', 'delta'].map((k) => layer(`${k}-1`, k));
    expect(chartTemplateNow([scalp], flow, 'candles', null)?.template).toBe(ORDER_FLOW);
    expect(chartTemplateNow([scalp], [layer('rsi-1', 'rsi')], 'bars', null)).toBeNull();
    expect(chartTemplateNow([scalp], [layer('rsi-1', 'rsi')], 'bars', 'gone')).toBeNull();
    expect(chipWords(null)).toBe('None');
  });

  it('sums a template up in one line: its type, then its indicators', () => {
    expect(templateSummary(scalp)).toBe('Bars · Vol · EMA 9');
    expect(templateSummary(clean)).toBe('No indicators');
    expect(templateSummary(ORDER_FLOW)).toBe('Footprint 3:1 · VP · Big trades · CVD');
  });

  it('names a copy after the template, numbered past the names taken, within the name limit', () => {
    expect(copyName({ templates: [scalp] }, 'Scalp')).toBe('Scalp copy');
    const taken = { templates: [scalp, { ...scalp, id: 'c', name: 'scalp COPY' }] };
    expect(copyName(taken, 'Scalp')).toBe('Scalp copy 2');
    const long = 'x'.repeat(48);
    expect(copyName({ templates: [] }, long)).toBe(`${'x'.repeat(43)} copy`);
  });
});

describe('the chart type lives on the chart', () => {
  it('reads the chart model first, then an older stage view, then the window default', () => {
    const view = { ...DEFAULT_VIEW, chartTypes: { 'chart-1': 'line' as const } };
    expect(chartTypeOf(view, 'chart-1', 'candles', { chartType: 'bars' })).toBe('bars');
    expect(chartTypeOf(view, 'chart-1', 'candles', {})).toBe('line');
    expect(chartTypeOf(view, 'chart-2', 'candles', null)).toBe('candles');
  });
});

describe('newChartLayers is retired', () => {
  it('is dropped from the local snapshot and ignored in the synced preferences', () => {
    expect(migrateUi({ workspace: 'w', newChartLayers: ['vwap'] }, 8)).toEqual({ workspace: 'w' });
    expect(migrateUi({ workspace: 'w', newChartLayers: ['vwap'] }, 7)).not.toHaveProperty('newChartLayers');
    expect(migrateUi({ workspace: 'w', newChartLayers: ['vwap'] }, 5)).not.toHaveProperty('newChartLayers');
    expect(readPreferences({ newChartLayers: ['vwap'], panelOpen: false, favouriteIntervals: ['1h'] })).toEqual({
      favouriteIntervals: ['1h'],
    });
  });
});
