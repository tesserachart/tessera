import { afterEach, describe, expect, it } from 'vitest';
import {
  addCustomIndicator,
  addIndicator,
  engineStyle,
  indicatorParams,
  indicatorSpec,
  resolveIndicator,
} from '../src/chart/indicators.ts';
import {
  currentPreset,
  indicatorOf,
  matches,
  readPresets,
  renameProblem,
  resetSettings,
  sameSettings,
  settingsFrom,
  startParams,
} from '../src/chart/presets/model.ts';
import { putPresets, presetsStore } from '../src/chart/presets/store.ts';
import { applySetting } from '../src/state/settingsSync.ts';
import { patch, read } from '../src/app/store.ts';

const ema = indicatorSpec('ema')!;
const rsi = indicatorSpec('rsi')!;
const volume = indicatorSpec('volume')!;

afterEach(() => {
  patch(presetsStore, { presets: [], defaults: {}, loaded: false });
});

describe('labels on an indicator’s lines', () => {
  it('start where the chart has always drawn them and are kept with its style', () => {
    expect(resolveIndicator(rsi, {}).labels).toEqual({ priceScale: true, name: false, value: false });
    expect(resolveIndicator(ema, {}).labels).toEqual({ priceScale: false, name: false, value: false });
    const s = resolveIndicator(ema, { style: { labels: { name: true, value: 'yes' } } });
    expect(s.labels).toEqual({ priceScale: false, name: true, value: false });
    const p = indicatorParams(s) as { style: { labels: unknown } };
    expect(p.style.labels).toEqual({ priceScale: false, name: true, value: false });
    expect(engineStyle(ema, s).labels).toEqual(s.labels);
  });

  it('are none on an indicator without a line', () => {
    const hist = { ...volume, plots: volume.plots.filter((p) => p.kind !== 'line') };
    const s = resolveIndicator(hist, { style: { labels: { name: true } } });
    expect(s.labels).toBeNull();
    expect((indicatorParams(s) as { style: object }).style).not.toHaveProperty('labels');
    expect(engineStyle(hist, s)).not.toHaveProperty('labels');
  });
});

describe('indicator presets', () => {
  const stored = {
    presets: [
      { id: 'fast', name: ' Fast ', indicator: 'ema', params: { inputs: { length: 9 } } },
      { id: 'fast', name: 'Dup', indicator: 'ema', params: {} },
      { id: 'fast-2', name: 'FAST', indicator: 'ema', params: {} },
      {
        id: 'slow',
        name: 'Slow',
        indicator: 'ema',
        params: { inputs: { length: 50 }, style: { labels: { name: true } } },
      },
      { id: 'mine', name: 'Mine', indicator: 'ci_1', params: {} },
      { id: 'x', name: 'No params', indicator: 'ema', params: 3 },
      { id: 'y', name: 'Custom kind', indicator: 'custom', params: {} },
      'junk',
    ],
    defaults: { rsi: { inputs: { length: 7 } }, ema: 4 },
  };

  it('are read leniently, as the runtime reads them', () => {
    const all = readPresets(stored);
    expect(all.presets.map((p) => p.id)).toEqual(['fast', 'slow', 'mine']);
    expect(all.presets[0]!.name).toBe('Fast');
    expect(Object.keys(all.defaults)).toEqual(['rsi']);
    expect(readPresets(null)).toEqual({ presets: [], defaults: {} });
  });

  it('are kept per indicator: a built-in by kind, a custom one by its id', () => {
    expect(indicatorOf({ kind: 'ema', params: {} })).toBe('ema');
    expect(indicatorOf({ kind: 'custom', params: { indicator: 'ci_1' } })).toBe('ci_1');
    expect(indicatorOf({ kind: 'custom', params: {} })).toBeNull();
  });

  it('reset to the saved default, else the indicator’s own, keeping the pane where the user put it', () => {
    const all = readPresets(stored);
    const now = { ...resolveIndicator(rsi, { inputs: { length: 30 } }), height: 0.33 };
    const reset = resetSettings(all, 'rsi', rsi, now);
    expect(reset.inputs.length).toBe(7);
    expect(reset.height).toBe(0.33);
    const own = resetSettings(all, 'macd', indicatorSpec('macd')!, resolveIndicator(indicatorSpec('macd')!, {}));
    expect(own.inputs).toEqual(resolveIndicator(indicatorSpec('macd')!, {}).inputs);
  });

  it('apply as settings fitted to the indicator, and say which one the indicator is set as', () => {
    const all = readPresets(stored);
    const now = resolveIndicator(ema, { inputs: { length: 20 } });
    const slow = settingsFrom(ema, all.presets[1]!.params, now);
    expect(slow.inputs.length).toBe(50);
    expect(slow.labels?.name).toBe(true);
    expect(currentPreset(all, 'ema', ema, slow)?.id).toBe('slow');
    expect(currentPreset(all, 'ema', ema, now)).toBeNull();
    expect(matches(ema, slow, { inputs: { length: 50 }, style: { labels: { name: true } } })).toBe(true);
    expect(sameSettings(ema, slow, { ...slow, height: 0.5 })).toBe(true);
    expect(settingsFrom(ema, { inputs: { length: -3, gone: 1 } }, now).inputs).toEqual(
      resolveIndicator(ema, {}).inputs,
    );
  });

  it('refuse a name another of the indicator’s presets has', () => {
    const all = readPresets(stored);
    const fast = all.presets[0]!;
    expect(renameProblem(all, fast, ' ')).toBe('A preset needs a name');
    expect(renameProblem(all, fast, 'slow')).toBe('slow is taken');
    expect(renameProblem(all, fast, 'fast')).toBeNull();
    expect(renameProblem(all, fast, 'Mine')).toBeNull();
    expect(renameProblem(all, fast, 'x'.repeat(49))).toMatch(/At most/);
  });

  it('start a new indicator from the saved default', () => {
    putPresets(stored);
    const params = startParams(read(presetsStore), 'rsi');
    const { layers } = addIndicator([], 'rsi', params);
    expect(resolveIndicator(rsi, layers[0]!.params).inputs.length).toBe(7);
    expect(startParams(read(presetsStore), 'ema')).toBeNull();
    const custom = addCustomIndicator([], 'ci_1', { inputs: { n: 3 } });
    expect(custom.layers[0]!.params).toEqual({ inputs: { n: 3 }, indicator: 'ci_1' });
  });

  it('arrive from the runtime’s setting', () => {
    applySetting('chart.indicatorPresets', stored);
    const s = read(presetsStore);
    expect(s.loaded).toBe(true);
    expect(s.presets).toHaveLength(3);
  });
});
