import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BigTradesLayer, groupingKey, type BigTrade, type BigTradeTier } from '@tessera/chart';
import type { ChartLayer } from '@tessera/protocol';
import { INDICATOR_SPECS } from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { describe, expect, it } from 'vitest';
import {
  addIndicator,
  analystPlot,
  defaultSettings,
  engineStyle,
  indicatorLabel,
  indicatorParams,
  indicatorSpec,
  indicatorSummary,
  isDefault,
  layerOfPane,
  migrateLegacy,
  removeLayer,
  resolveIndicator,
  showLayer,
  withPaneHeights,
  withSettings,
} from '../src/chart/indicators.ts';
import {
  autoMinNote,
  bigTradeFilter,
  bigTradeGrouping,
  bigTradeLegend,
  tierNotes,
} from '../src/chart/layers/orderflow/bigTrades.ts';
import { passes, sameFilter } from '../src/market/flow/bigTrades.ts';
import { catalogGroups, searchIndicators } from '../src/chart/settings/catalog.ts';
import {
  indicatorName,
  inputRows,
  shownUnder,
  legendPanes,
  paneOf,
  parseNumber,
  stepDecimals,
  stepNumber,
  valueInk,
} from '../src/chart/settings/model.ts';

const layer = (id: string, kind: string, params: unknown, visible = true): ChartLayer => ({
  id,
  kind,
  params: params as ChartLayer['params'],
  visible,
  namespace: 'user',
  sessionId: null,
});

const spec = (kind: string) => indicatorSpec(kind)!;

describe('indicator settings', () => {
  it('fill every input and style from the declaration', () => {
    const s = resolveIndicator(spec('rsi'), {});
    expect(s.inputs).toEqual({ length: 14, source: 'close', upper: 70, lower: 30 });
    expect(s.plots.rsi).toMatchObject({ color: 'mist', width: 1.25, line: 'solid', visible: true });
    expect(s.fills.zone).toMatchObject({ visible: true });
    expect(s.height).toBe(0.16);
    expect(resolveIndicator(spec('sma'), {}).height).toBeNull();
  });

  it('keep valid values and default invalid ones, like the runtime', () => {
    const s = resolveIndicator(spec('rsi'), {
      inputs: { length: 21, source: 'hlc3', upper: 120, lower: 'x' },
      style: { plots: { rsi: { color: '#ff8800', width: 9, line: 'dot' } }, fills: { zone: { visible: false } } },
      height: 0.3,
    });
    expect(s.inputs).toEqual({ length: 21, source: 'hlc3', upper: 70, lower: 30 });
    expect(s.plots.rsi).toMatchObject({ color: '#ff8800', width: 1.25, line: 'dot' });
    expect(s.fills.zone!.visible).toBe(false);
    expect(s.height).toBe(0.3);
    expect(resolveIndicator(spec('rsi'), { inputs: { length: 14.5 } }).inputs.length).toBe(14);
    expect(resolveIndicator(spec('rsi'), { style: { plots: { rsi: { color: 'aqua' } } } }).plots.rsi!.color).toBe(
      'mist',
    );
  });

  it('read params written before the registry', () => {
    expect(resolveIndicator(spec('sma'), { period: 50 }).inputs.length).toBe(50);
    const vwap = resolveIndicator(spec('vwap'), { bands: [2, 1.5] }).inputs;
    expect(vwap).toMatchObject({ band1: false, mult1: 1.5, band2: false, mult2: 2, band3: false, mult3: 3 });
    expect(resolveIndicator(spec('volume'), { mode: 'pane' }).inputs).toEqual({ maLength: 20 });
  });

  it('migrate legacy params the way the runtime does (the shared vectors)', () => {
    const file = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../crates/tessera-protocol/testdata/legacy-params.json',
    );
    const { cases } = JSON.parse(readFileSync(file, 'utf8')) as {
      cases: { kind: string; params: unknown; migrated: unknown }[];
    };
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) expect(migrateLegacy(c.kind, c.params), JSON.stringify(c)).toEqual(c.migrated);
  });

  it('round-trip through the params they store', () => {
    for (const s of INDICATOR_SPECS) {
      const settings = resolveIndicator(s, {});
      expect(resolveIndicator(s, indicatorParams(settings))).toEqual(settings);
    }
  });

  it('name an indicator by its short name, its labelled inputs and a source that is not the default', () => {
    expect(indicatorLabel(spec('sma'), resolveIndicator(spec('sma'), {}).inputs)).toBe('SMA 20');
    expect(indicatorLabel(spec('sma'), resolveIndicator(spec('sma'), { inputs: { source: 'hl2' } }).inputs)).toBe(
      'SMA 20 hl2',
    );
    expect(indicatorLabel(spec('bollinger'), resolveIndicator(spec('bollinger'), {}).inputs)).toBe('BB 20 2');
    expect(indicatorLabel(spec('stochastic'), resolveIndicator(spec('stochastic'), {}).inputs)).toBe('Stoch 14 1 3');
    expect(indicatorLabel(spec('vwap'), resolveIndicator(spec('vwap'), {}).inputs)).toBe('VWAP');
    const footprint = { mode: 'trades', maxLevel: 'trades', dimBelow: 40 };
    expect(indicatorLabel(spec('footprint'), resolveIndicator(spec('footprint'), { inputs: footprint }).inputs)).toBe(
      'Footprint trades max trades 3:1',
    );
    expect(indicatorLabel(spec('vwap'), resolveIndicator(spec('vwap'), { inputs: { period: 'week' } }).inputs)).toBe(
      'VWAP week',
    );
    expect(indicatorLabel(spec('atr'), resolveIndicator(spec('atr'), { inputs: { smoothing: 'ema' } }).inputs)).toBe(
      'ATR 14 ema',
    );
    expect(resolveIndicator(spec('atr'), { inputs: { smoothing: 'hma' } }).inputs.smoothing).toBe('rma');
  });

  it('resolve swatches to the tokens, and draw an agent indicator in aqua', () => {
    const s = resolveIndicator(spec('macd'), { style: { plots: { signal: { color: '#123456' } } } });
    const st = engineStyle(spec('macd'), s);
    expect(st.plots.macd!.color).toBe(TOKENS.mist);
    expect(st.plots.signal!.color).toBe('#123456');
    expect(st.plots.hist).toMatchObject({ color: TOKENS.up, downColor: TOKENS.down, opacity: 0.5 });
    expect(engineStyle(spec('macd'), s, { agent: true }).plots.macd!.color).toBe(TOKENS.aqua);
    const brass = resolveIndicator(spec('sma'), { style: { plots: { ma: { color: 'brass' } } } });
    expect(engineStyle(spec('sma'), brass, { agent: true }).plots.ma!.color).toBe(TOKENS.brass);
    expect(analystPlot(spec('sma'), brass, true)).toBeNull();
    expect(analystPlot(spec('sma'), resolveIndicator(spec('sma'), {}), true)).toBe('ma');
    expect(analystPlot(spec('sma'), resolveIndicator(spec('sma'), {}), false)).toBeNull();
  });

  it('read in the legend by the inputs that name them, and a source or choice only when not the default', () => {
    const at = (kind: string, params: unknown = {}) =>
      indicatorSummary(spec(kind), resolveIndicator(spec(kind), params).inputs);
    expect(at('ema', { inputs: { length: 21 } })).toBe('21');
    expect(at('ema', { inputs: { source: 'hl2' } })).toBe('9 hl2');
    expect(at('macd')).toBe('12 26 9');
    expect(at('bollinger')).toBe('20 2');
    expect(at('atr')).toBe('14');
    expect(at('atr', { inputs: { smoothing: 'ema' } })).toBe('14 ema');
    expect(at('vwap')).toBe('');
    expect(at('volume')).toBe('');
    expect(at('volume_profile', { inputs: { show: 'delta', hours: 'rth', extendLines: true } })).toBe('RTH delta');
    expect(at('volume_profile', { inputs: { period: 'composite', show: 'volumeDelta', hours: 'split' } })).toBe(
      'RTH/ETH volume+delta',
    );
    const vp = spec('volume_profile');
    expect(indicatorLabel(vp, resolveIndicator(vp, { inputs: { period: 'range' } }).inputs)).toBe('VP range');
    expect(at('volume_profile'), 'a profile on the chart’s hours names none of its own').toBe('');
    expect(at('volume_profile', { inputs: { hours: 'all' } })).toBe('ETH');
    for (const s of INDICATOR_SPECS) {
      const inputs = resolveIndicator(s, { inputs: {} }).inputs;
      expect(indicatorLabel(s, inputs)).toBe([s.short, indicatorSummary(s, inputs)].filter(Boolean).join(' '));
    }
    expect(indicatorName(layer('ema-1', 'ema', {}))).toBe('EMA 9');
    expect(indicatorName(layer('vol-1', 'volume', {}))).toBe('Vol');
    expect(indicatorName(layer('lv', 'levels', {}))).toBeNull();
  });

  it('add, show, hide, edit and remove layers by id', () => {
    const base = [layer('ema-1', 'ema', {}), layer('levels-1', 'levels', {})];
    const { layers: added, id } = addIndicator(base, 'ema');
    expect(id).toBe('ema-2');
    expect(added.at(-1)).toMatchObject({ id: 'ema-2', kind: 'ema', params: {}, visible: true, namespace: 'user' });
    const hidden = showLayer(added, 'ema-2', false);
    expect(hidden.at(-1)!.visible).toBe(false);
    expect(hidden[0]).toBe(added[0]);
    expect(showLayer(hidden, 'ema-2', false)[2]).toBe(hidden[2]);
    const s = resolveIndicator(spec('ema'), {});
    const edited = withSettings(hidden, 'ema-2', { ...s, inputs: { ...s.inputs, length: 50 } });
    expect(resolveIndicator(spec('ema'), edited.at(-1)!.params).inputs.length).toBe(50);
    expect(removeLayer(edited, 'ema-1').map((l) => l.id)).toEqual(['levels-1', 'ema-2']);
  });

  it('reset to the defaults but keep the pane height the user dragged', () => {
    const rsi = spec('rsi');
    const s = resolveIndicator(rsi, { inputs: { length: 21 }, height: 0.3 });
    expect(isDefault(rsi, s)).toBe(false);
    const d = defaultSettings(rsi, s);
    expect(d.inputs.length).toBe(14);
    expect(d.height).toBe(0.3);
    expect(isDefault(rsi, d)).toBe(true);
    expect(isDefault(rsi, resolveIndicator(rsi, { height: 0.4 }))).toBe(true);
  });
});

describe('the Add-indicator catalog', () => {
  it('groups the registry by family and hides a family with nothing in it', () => {
    const groups = catalogGroups();
    expect(groups.map((g) => g.label)).toEqual(['Trend', 'Momentum', 'Volatility', 'Volume', 'Order flow', 'Special']);
    expect(groups.at(-1)!.specs.map((s) => s.kind)).toEqual(['effort']);
    expect(groups.flatMap((g) => g.specs).length).toBe(INDICATOR_SPECS.length);
    expect(groups[0]!.specs.map((s) => s.short)).toEqual(['SMA', 'EMA', 'WMA']);
  });

  it('finds by short name first, then words, initials and family', () => {
    expect(searchIndicators('rsi')[0]!.kind).toBe('rsi');
    expect(searchIndicators('ema')[0]!.kind).toBe('ema');
    expect(searchIndicators('ma').map((s) => s.kind)).toEqual(['macd', 'market_profile', 'sma', 'ema', 'wma']);
    expect(searchIndicators('tpo')[0]!.kind).toBe('market_profile');
    expect(searchIndicators('bb')[0]!.kind).toBe('bollinger');
    expect(searchIndicators('moving exp').map((s) => s.kind)).toEqual(['ema']);
    expect(
      searchIndicators('momentum')
        .map((s) => s.kind)
        .sort(),
    ).toEqual(['macd', 'rsi', 'stochastic']);
    expect(searchIndicators('zzz')).toEqual([]);
    expect(searchIndicators('  ').length).toBe(INDICATOR_SPECS.length);
  });
});

describe('the indicator settings form', () => {
  it('takes a typed number only once it is whole, in bounds and complete', () => {
    expect(parseNumber('21', { min: 1, max: 500, integer: true })).toBe(21);
    expect(parseNumber('21.5', { integer: true })).toBeNull();
    expect(parseNumber('0', { min: 1 })).toBeNull();
    expect(parseNumber('', {})).toBeNull();
    expect(parseNumber('-', {})).toBeNull();
    expect(parseNumber('1.', {})).toBe(1);
    expect(parseNumber('−2.5', {})).toBe(-2.5);
    expect(parseNumber('1,000', {})).toBe(1000);
  });

  it('steps by the input step, in bounds, without float dust', () => {
    expect(stepDecimals(0.1)).toBe(1);
    expect(stepDecimals(1)).toBe(0);
    expect(stepNumber(2, 1, { step: 0.1 })).toBe(2.1);
    expect(stepNumber(0.3, -1, { step: 0.1, min: 0.1 })).toBe(0.2);
    expect(stepNumber(499, 10, { step: 1, max: 500 })).toBe(500);
  });

  it('puts a switch and the number it governs on one row', () => {
    const rows = inputRows(spec('vwap').inputs);
    expect(rows.map((r) => [r.input.key, r.paired?.key ?? null])).toEqual([
      ['period', null],
      ['band1', 'mult1'],
      ['band2', 'mult2'],
      ['band3', 'mult3'],
    ]);
    expect(inputRows(spec('rsi').inputs).every((r) => !r.paired)).toBe(true);
  });

  it('sets Big trades by Auto with a tier or a fixed band, each under the switch that shows it', () => {
    const bt = spec('big_trades');
    const rows = inputRows(bt.inputs);
    expect(rows.map((r) => r.input.key)).toEqual([
      'size',
      'showSize',
      'price',
      'joinOrders',
      'reachLimit',
      'zones',
      'daysToLoad',
    ]);
    const size = rows[0]!;
    expect([size.input.label, size.input.segmented]).toEqual(['Min size', true]);
    expect(shownUnder(size, undefined).map((i) => i.key)).toEqual(['tier']);
    expect(shownUnder(size, 'auto').map((i) => [i.label, i.segmented])).toEqual([['Auto shows', true]]);
    expect(shownUnder(size, 'fixed').map((i) => [i.key, i.label, i.zeroLabel])).toEqual([
      ['minSize', 'At least', undefined],
      ['maxSize', 'At most', 'None'],
    ]);
    const zones = rows.find((r) => r.input.key === 'zones')!;
    expect(zones.input.hint).toMatch(/a buy in an up bar or a sell in a down bar/);
    expect(shownUnder(zones, 'on').map((i) => i.key)).toEqual(['zoneBars', 'zoneBiggest', 'zoneBody', 'zoneWick']);
    expect(shownUnder(zones, undefined)).toEqual([]);
    expect(indicatorSummary(bt, resolveIndicator(bt, { inputs: { size: 'fixed', minSize: 50 } }).inputs)).toBe('');
    expect(indicatorSummary(bt, resolveIndicator(bt, { inputs: { price: 'start', zones: 'on' } }).inputs)).toBe(
      'first print',
    );
  });
});

describe('Big trades’ filter', () => {
  const bt = spec('big_trades');
  const settings = (inputs: Record<string, unknown>) => resolveIndicator(bt, { inputs });

  it('reads Auto with its tier, or a fixed band, a max of 0 being none', () => {
    expect(bigTradeFilter(settings({}))).toEqual({ kind: 'auto', tier: 'low' });
    expect(bigTradeFilter(settings({ tier: 'medium' }))).toEqual({ kind: 'auto', tier: 'medium' });
    expect(bigTradeFilter(settings({ tier: 'nope' }))).toEqual({ kind: 'auto', tier: 'low' });
    expect(bigTradeFilter(settings({ size: 'auto', minSize: 12, maxSize: 80, tier: 'high' }))).toEqual({
      kind: 'auto',
      tier: 'high',
    });
    expect(bigTradeFilter(settings({ size: 'fixed' }))).toEqual({ kind: 'size', min: 60, max: null });
    expect(bigTradeFilter(settings({ size: 'fixed', minSize: 12 }))).toEqual({ kind: 'size', min: 12, max: null });
    expect(bigTradeFilter(settings({ size: 'fixed', minSize: 12, maxSize: 80 }))).toEqual({
      kind: 'size',
      min: 12,
      max: 80,
    });
    expect(settings({}).inputs).toMatchObject({ size: 'auto', tier: 'low', minSize: 60, maxSize: 0, showSize: true });
  });

  it('opens a layout saved before the size switch on the mode it read as', () => {
    const saved = (inputs: Record<string, unknown>) => bigTradeFilter(settings(inputs));
    expect(saved({ mode: 'auto', high: true, medium: false, low: true, minSize: 40 })).toEqual({
      kind: 'auto',
      tier: 'low',
    });
    expect(saved({ high: true, medium: true, low: false })).toEqual({ kind: 'auto', tier: 'medium' });
    expect(saved({ mode: 'auto', high: true, medium: false, low: false })).toEqual({ kind: 'auto', tier: 'high' });
    expect(saved({ mode: 'manual', low: false, minSize: 25, maxSize: 300 })).toEqual({
      kind: 'size',
      min: 25,
      max: 300,
    });
    expect(saved({ mode: 'manual', minSize: 0 })).toEqual({ kind: 'size', min: 60, max: null });
    expect(saved({ minSize: 0, maxSize: 80 })).toEqual({ kind: 'auto', tier: 'low' });
    expect(saved({ minSize: 25 })).toEqual({ kind: 'size', min: 25, max: null });
  });

  it('keeps a tier above another', () => {
    const trade = (tier: BigTrade['tier']): BigTrade => ({
      t: 1,
      price: 10,
      size: 100,
      side: 1,
      prints: 1,
      ref: 'r',
      tier,
    });
    const passing = (tier: BigTradeTier) =>
      (['low', 'medium', 'high'] as const).filter((t) => passes({ kind: 'auto', tier }, trade(t)));
    expect(passing('low')).toEqual(['low', 'medium', 'high']);
    expect(passing('medium')).toEqual(['medium', 'high']);
    expect(passing('high')).toEqual(['high']);
    expect(passes({ kind: 'auto', tier: 'low' }, trade(null))).toBe(false);
    expect(passes({ kind: 'auto', tier: 'low' }, trade(undefined))).toBe(false);
    expect(sameFilter({ kind: 'auto', tier: 'low' }, { kind: 'auto', tier: 'high' })).toBe(false);
    expect(sameFilter({ kind: 'auto', tier: 'low' }, { kind: 'auto', tier: 'low' })).toBe(true);
    expect(sameFilter({ kind: 'auto', tier: 'low' }, { kind: 'size', min: 1, max: null })).toBe(false);
  });

  it('groups by its two settings, both on unless turned off, one feed key for each pair', () => {
    expect(bigTradeGrouping(settings({}))).toEqual({ joinOrders: true, reachLimit: true });
    expect(bigTradeGrouping(settings({ joinOrders: false }))).toEqual({ joinOrders: false, reachLimit: true });
    expect(bigTradeGrouping(settings({ reachLimit: false }))).toEqual({ joinOrders: true, reachLimit: false });
    const keys = [true, false].flatMap((joinOrders) =>
      [true, false].map((reachLimit) => groupingKey(bigTradeGrouping(settings({ joinOrders, reachLimit })))),
    );
    expect(new Set(keys).size).toBe(4);
  });

  it('words a size by its band and Auto by its tier and the size it starts at', () => {
    expect(bigTradeLegend({ kind: 'size', min: 60, max: null }, 63, true)).toBe('≥ 60');
    expect(bigTradeLegend({ kind: 'size', min: 1500, max: 3000 }, null, false)).toBe('1,500–3,000');
    expect(bigTradeLegend({ kind: 'auto', tier: 'low' }, 63, false)).toBe('Auto low ≥ 63');
    expect(bigTradeLegend({ kind: 'auto', tier: 'high' }, 180, false)).toBe('Auto high ≥ 180');
    expect(bigTradeLegend({ kind: 'auto', tier: 'medium' }, null, false)).toBe('Auto medium');
    expect(bigTradeLegend({ kind: 'auto', tier: 'low' }, null, true), 'under an hour of history').toBe('Auto low');
  });

  it('hands the settings every tier’s cut, and nothing while Auto is still sizing', () => {
    expect(autoMinNote({ kind: 'auto', tier: 'high' }, 180, false)).toBe('≥ 180');
    expect(autoMinNote({ kind: 'auto', tier: 'high' }, 180, true)).toBeNull();
    expect(autoMinNote({ kind: 'size', min: 60, max: null }, 63, false)).toBeNull();
    expect(tierNotes({ low: 63, medium: 120, high: 1800 })).toEqual({
      'tier.low': '≥ 63',
      'tier.medium': '≥ 120',
      'tier.high': '≥ 1,800',
    });
    expect(tierNotes(null)).toBeNull();
    const layer = new BigTradesLayer({ id: 'bt', options: { notes: { 'tier.low': '≥ 63' } } });
    expect(layer.optionNotes()).toEqual({ 'tier.low': '≥ 63' });
  });
});

describe('the indicator legend', () => {
  it('puts overlays, hidden and unplaced pane indicators on the price, each shown pane indicator in its pane', () => {
    const entries = [
      layer('ema-1', 'ema', {}),
      layer('rsi-1', 'rsi', {}),
      layer('macd-1', 'macd', {}, false),
      layer('atr-1', 'atr', {}),
    ].map((l) => ({ layer: l, spec: spec(l.kind) }));
    const panes = legendPanes(entries, [paneOf('rsi-1'), 'volume']);
    expect(panes).toEqual([
      { pane: 'main', ids: ['ema-1', 'macd-1', 'atr-1'] },
      { pane: 'pane:model:rsi-1', ids: ['rsi-1'] },
    ]);
  });

  it('writes a value in its line colour, lifted to t2 when the line is in a label grey', () => {
    expect(valueInk(TOKENS.mist)).toBe(TOKENS.mist);
    expect(valueInk(TOKENS.t1)).toBe(TOKENS.t1);
    expect(valueInk('#d2b06c')).toBe('#d2b06c');
    expect(valueInk(TOKENS.t3)).toBe(TOKENS.t2);
    expect(valueInk(TOKENS.t4.toUpperCase())).toBe(TOKENS.t2);
  });

  it('keep dragged pane heights in the indicators they belong to', () => {
    expect(layerOfPane('pane:model:rsi-1')).toBe('rsi-1');
    expect(layerOfPane('volume')).toBeNull();
    const ls = [layer('rsi-1', 'rsi', { inputs: { length: 21 } }), layer('sma-1', 'sma', {})];
    const next = withPaneHeights(ls, [{ id: 'pane:model:rsi-1', height: 0.2345 }])!;
    expect(resolveIndicator(spec('rsi'), next[0]!.params)).toMatchObject({ height: 0.235, inputs: { length: 21 } });
    expect(next[1]).toBe(ls[1]);
    expect(withPaneHeights(next, [{ id: 'pane:model:rsi-1', height: 0.235 }])).toBeNull();
  });
});
