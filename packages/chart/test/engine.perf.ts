import { mkdirSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AggTape,
  BigTradesLayer,
  BookStore,
  DeltaLayer,
  FootprintLayer,
  VolumeProfileLayer,
  FOOTPRINT_TEXT,
  FootprintStore,
  GlyphAtlas,
  IndicatorLayer,
  LevelsLayer,
  TESSERA_THEME,
  TickGrid,
  TradeTape,
  footprintProfile,
  formatCount,
  type Ctx2D,
  type DepthMessage,
  type FrameEvent,
  type IndicatorDef,
  type PlotStyle,
  type BigTrade,
  type Bar,
  type FootprintInput,
  type SessionProfileData,
} from '../src/index.ts';
import { FOOTPRINT_FIGURE_SIZES } from '../src/layers/footprint.ts';
import { equityBars, headless, rng, threadMs, valuesOf, vwapLayer } from './fixtures.ts';
import { ManualTimers } from './gpu.ts';

const REPORT = process.env.TESSERA_PERF_REPORT === '1';
const outDir = join(import.meta.dirname, '../.perf');

interface Budget {
  loose: number;
  strict: number | null;
  target: string;
  stat?: 'median' | 'p95';
}

const BUDGETS = {
  setData50k: { loose: 1_500, strict: null, target: 'none (load time)' },
  prepend40k: { loose: 1_500, strict: null, target: 'none (history read back)' },
  panAfterPrepend: { loose: 25, strict: 16.7, target: '§8: 60 fps pan/zoom (50k bars, 40k of them prepended)' },
  frame50kVisible: { loose: 60, strict: 16.7, target: '§8: 60 fps pan/zoom over 50k bars' },
  panFrame1000: { loose: 25, strict: 16.7, target: '§8: 60 fps pan/zoom' },
  candles1000: { loose: 10, strict: 2.5, target: '§8: < 2 ms per frame for 1,000 candles' },
  crosshair: { loose: 15, strict: 16.7, target: '§8: 60 fps' },
  update: { loose: 1, strict: 0.1, target: 'updates stay far below a 60 fps frame' },
  panIndicators1000: { loose: 30, strict: 16.7, target: '§8: 60 fps pan/zoom with indicator panes' },
  updateIndicators: { loose: 1, strict: 0.15, target: 'updates with five indicators stay far below a frame' },
  bookDelta: {
    loose: 3,
    strict: 0.3,
    target: 'orderflow §12: parse and apply one depth message ≤ 0.3 ms',
    stat: 'p95',
  },
  ingestBurst5000: { loose: 3, strict: 0.3, target: 'orderflow §12: one 125-print burst batch ≤ 0.3 ms', stat: 'p95' },
  profileVisible: {
    loose: 20,
    strict: 2,
    target: 'orderflow §12: inside the 6 ms live frame (on settle)',
    stat: 'p95',
  },
  footprintText1560: {
    loose: 40,
    strict: 4.5,
    target: 'orderflow §12: full footprint LOD 2 (~1,560 strings) ≤ 4.5 ms',
    stat: 'p95',
  },
  footprintL2: {
    loose: 60,
    strict: 4.5,
    target: 'orderflow §12: the footprint’s share of a LOD 2 frame ≤ 4.5 ms',
    stat: 'p95',
  },
  footprintPan: {
    loose: 80,
    strict: 8,
    target: 'orderflow §12: pan/zoom frame with a full footprint ≤ 8 ms',
    stat: 'p95',
  },
  footprintNumbersOn: {
    loose: 80,
    strict: 16.7,
    target: '§8: a zoom step where footprint numbers switch on, off or change size stays a 60 fps frame',
    stat: 'p95',
  },
  bubbles500: { loose: 30, strict: 3, target: 'orderflow §12: 500 bubbles inside the 6 ms live frame', stat: 'p95' },
  liveFrame: {
    loose: 60,
    strict: 6,
    target: 'orderflow §12: live frame (footprint LOD 2 forming bar + profile + delta + 500 bubbles) ≤ 6 ms',
    stat: 'p95',
  },
  zoomedOutOrderFlow: {
    loose: 60,
    strict: 16.7,
    target: '§8: 60 fps pan fully zoomed out on 14 sessions of 1m (footprint + profiles + CVD + big trades)',
  },
} satisfies Record<string, Budget>;

type CaseName = keyof typeof BUDGETS;

interface Measured {
  median: number;
  p95: number;
  limit: number;
  mode: 'loose' | 'strict';
  target: string;
}

const results: Partial<Record<CaseName, Measured>> = {};

function check(name: CaseName, s: { median: number; p95: number }): void {
  const b: Budget = BUDGETS[name];
  const strict = REPORT && b.strict !== null;
  const limit = strict && b.strict !== null ? b.strict : b.loose;
  results[name] = { median: s.median, p95: s.p95, limit, mode: strict ? 'strict' : 'loose', target: b.target };
  const p95 = strict && b.stat === 'p95';
  const v = p95 ? s.p95 : s.median;
  expect(
    v,
    `${name}: ${p95 ? 'p95' : 'median'} ${v.toFixed(3)}ms over the ${strict ? 'strict' : 'loose'} limit`,
  ).toBeLessThan(limit);
}

function share(withLayer: { median: number; p95: number }, bare: { median: number; p95: number }) {
  return { median: Math.max(0, withLayer.median - bare.median), p95: Math.max(0, withLayer.p95 - bare.median) };
}

afterAll(() => {
  const rows = Object.entries(results).map(([name, r]) => ({
    case: name,
    'median ms': Number(r.median.toFixed(3)),
    'p95 ms': Number(r.p95.toFixed(3)),
    'limit ms': r.limit,
    mode: r.mode,
  }));
  console.info('[perf] chart engine, 1600×900 (order flow at 1920×1080, dpr 2), Skia CPU');
  console.table(rows);
  if (!REPORT) return;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'report.json'),
    `${JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2)}\n`,
  );
});

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { median: q(0.5), p95: q(0.95), max: s.at(-1)! };
}

function timeFrames(n: number, step: (i: number) => void, render: () => void): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    step(i);
    const t0 = threadMs();
    render();
    out.push(threadMs() - t0);
  }
  return out;
}

const perfStyle = (color: string, extra: Partial<PlotStyle> = {}): PlotStyle => ({
  color,
  downColor: null,
  width: 1,
  line: 'solid',
  opacity: 1,
  visible: true,
  ...extra,
});

function tick(layers: readonly IndicatorLayer[], t: number, value: number): void {
  for (const layer of layers) {
    const columns: Record<string, Float64Array> = {};
    for (const key of layer.values.keys()) columns[key] = Float64Array.of(value);
    layer.values.replaceSpan(t, t, Float64Array.of(t), columns);
    layer.valuesChanged({ kind: 'span', from: t, to: t });
  }
}

function cvdRows(footprints: readonly FootprintInput[]) {
  let cvd = 0;
  return footprints.map((f) => {
    let d = 0;
    let v = 0;
    for (const c of f.cells) {
      d += c[2] - c[1];
      v += c[1] + c[2];
    }
    const open = cvd;
    cvd += d;
    return { d, v, open, close: cvd };
  });
}

function cvdValues(bars: readonly Bar[], rows: ReturnType<typeof cvdRows>) {
  return valuesOf(bars, {
    delta: (_b, i) => rows[i]!.d,
    volume: (_b, i) => rows[i]!.v,
    open: (_b, i) => rows[i]!.open,
    high: (_b, i) => Math.max(rows[i]!.open, rows[i]!.close),
    low: (_b, i) => Math.min(rows[i]!.open, rows[i]!.close),
    close: (_b, i) => rows[i]!.close,
    candle: () => 0,
  });
}

function snapshot(chart: ReturnType<typeof headless>, name: string) {
  if (!REPORT) return;
  mkdirSync(outDir, { recursive: true });
  const shot = chart.snapshot() as unknown as Canvas;
  writeFileSync(join(outDir, `${name}.png`), shot.toBuffer('image/png'));
}

describe('perf: 50k bars headless', () => {
  const bars = equityBars(642);
  const width = 1600;
  const height = 900;

  it('renders 50k bars fully zoomed out within budget', () => {
    const chart = headless({ width, height });
    const t0 = threadMs();
    chart.setData('main', bars);
    const setDataMs = threadMs() - t0;
    chart.addLayer(vwapLayer(bars));
    chart.setViewport({ fitAll: true });
    chart.render(true);
    expect(chart.getViewport().to - chart.getViewport().from + 1).toBeGreaterThan(49_000);
    const frames = timeFrames(
      30,
      (i) => chart.engine.wheel(i % 2 ? 3 : -3, 0, 800, 400),
      () => chart.render(true),
    );
    const s = stats(frames);
    snapshot(chart, 'fit-50k');
    check('setData50k', { median: setDataMs, p95: setDataMs });
    check('frame50kVisible', s);
    chart.destroy();
  });

  it('renders 1,000 visible candles (of 50k) within budget, and pans', () => {
    const chart = headless({ width, height });
    chart.setData('main', bars);
    chart.addLayer(vwapLayer(bars));
    chart.addLayer(
      new LevelsLayer({
        id: 'gex',
        provider: 'Zeta · Classic',
        levels: [
          { id: 'mg', price: 490, label: 'Max +Gamma', short: 'MG', vendor: 'Zeta · Classic', color: '#BAB6AC' },
          { id: 'gf', price: 485.4, label: 'Gamma Flip', short: 'GF', vendor: 'Zeta · Classic', color: '#E8E4DA' },
        ],
      }),
    );
    chart.setViewport({ lastBars: 1000 });
    chart.render(true);
    const vis = chart.getViewport();
    expect(vis.to - vis.from + 1).toBeGreaterThanOrEqual(990);
    const frames: FrameEvent[] = [];
    const off = chart.on('frame', (f) => frames.push(f));
    const pan = timeFrames(
      60,
      () => chart.engine.wheel(-12, 0, 800, 400),
      () => chart.render(),
    );
    const s = stats(pan);
    const mainMs = stats(frames.map((f) => f.timings.main ?? 0));
    console.info(`[perf] pan frame main surface: median ${mainMs.median.toFixed(2)}ms`);
    check('panFrame1000', s);

    off();
    for (const id of ['volume', 'vwap', 'legend', 'gex', 'last-price']) chart.setLayerVisible(id, false);
    const candlesOnly = timeFrames(
      60,
      () => chart.engine.wheel(-12, 0, 800, 400),
      () => chart.render(),
    );
    check('candles1000', stats(candlesOnly));
    for (const id of ['volume', 'vwap', 'legend', 'gex', 'last-price']) chart.setLayerVisible(id, true);

    const cross = timeFrames(
      60,
      (i) => chart.engine.pointerMove(200 + i * 10, 300),
      () => chart.render(),
    );
    check('crosshair', stats(cross));
    chart.destroy();
  });

  it('prepends 40k older bars to 10k without moving the view, within budget', () => {
    const chart = headless({ width, height });
    const split = bars.length - 10_000;
    chart.setData('main', bars.slice(split));
    const vwap = vwapLayer(bars.slice(split));
    chart.addLayer(vwap);
    chart.setViewport({ lastBars: 1000 });
    chart.render(true);
    const before = chart.getViewport();
    const older = vwapLayer(bars).values;
    const reached = { time: older.time.slice(0, split), vwap: older.column('vwap')!.slice(0, split) };
    const t0 = threadMs();
    expect(chart.prepend('main', bars.slice(0, split))).toBe(split);
    vwap.values.replaceSpan(bars[0]!.t, bars[split - 1]!.t, reached.time, { vwap: reached.vwap });
    vwap.valuesChanged({ kind: 'span', from: bars[0]!.t, to: bars[split - 1]!.t });
    const prependMs = threadMs() - t0;
    expect(vwap.valueAt('vwap', 0)).toBe(reached.vwap[0]);
    const after = chart.getViewport();
    expect(chart.getSeries()!.length).toBe(bars.length);
    expect(after.fromTime).toBe(before.fromTime);
    expect(after.toTime).toBe(before.toTime);
    expect(after.barSpacing).toBeCloseTo(before.barSpacing, 9);
    chart.render(true);
    const pan = timeFrames(
      60,
      () => chart.engine.wheel(-12, 0, 800, 400),
      () => chart.render(),
    );
    check('prepend40k', { median: prependMs, p95: prependMs });
    check('panAfterPrepend', stats(pan));
    chart.destroy();
  });

  it('incremental updates (forming bar + append, and its value) stay cheap', () => {
    const chart = headless({ width, height });
    chart.setData('main', bars);
    const vwap = vwapLayer(bars);
    chart.addLayer(vwap);
    chart.setViewport({ lastBars: 150 });
    chart.render(true);
    let last = bars.at(-1)!;
    const upd: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t0 = threadMs();
      if (i % 50 === 49) {
        last = { t: last.t + 300_000, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 };
      } else {
        const c = last.c + Math.sin(i) * 0.05;
        last = { ...last, c, h: Math.max(last.h, c), l: Math.min(last.l, c), v: last.v + 100 };
      }
      chart.update('main', last);
      tick([vwap], last.t, last.c);
      upd.push(threadMs() - t0);
    }
    expect(vwap.valueAt('vwap', bars.length + 9)).toBe(last.c);
    const su = stats(upd);
    const t0 = threadMs();
    chart.render();
    const frame = threadMs() - t0;
    snapshot(chart, 'last-150');
    console.info(`[perf] frame after 500 updates: ${frame.toFixed(2)}ms`);
    check('update', su);
    expect(chart.getSeries()!.length).toBe(bars.length + 10);
    chart.destroy();
  });

  function indicators(): IndicatorLayer[] {
    const st = (color: string, extra: Partial<PlotStyle> = {}): PlotStyle => ({
      color,
      width: 1.25,
      line: 'solid',
      opacity: 1,
      visible: true,
      ...extra,
    });
    const pane = (kind: string, plots: IndicatorDef['plots'], extra: Partial<IndicatorDef> = {}): IndicatorDef => ({
      kind,
      short: kind,
      placement: 'pane',
      plots,
      fills: [],
      sessionReset: false,
      format: 'number',
      ...extra,
    });
    return [
      new IndicatorLayer({
        id: 'bb',
        def: {
          ...pane('bollinger', [
            { key: 'basis', label: 'Basis', kind: 'line' },
            { key: 'upper', label: 'Upper', kind: 'line' },
            { key: 'lower', label: 'Lower', kind: 'line' },
          ]),
          placement: 'overlay',
          fills: [{ key: 'band', from: 'upper', to: 'lower' }],
        },
        inputs: { length: 20, mult: 2 },
        style: {
          plots: { basis: st('#6f7c82'), upper: st('#aab6bb'), lower: st('#aab6bb') },
          fills: { band: { color: '#dcebef', opacity: 0.04, visible: true } },
        },
        label: 'BB 20 2',
        values: valuesOf(bars, { basis: (b) => b.c, upper: (b) => b.c + 1, lower: (b) => b.c - 1 }),
      }),
      new IndicatorLayer({
        id: 'vol',
        def: pane('volume', [{ key: 'volume', label: 'Volume', kind: 'histogram', colorBy: 'direction' }], {
          format: 'volume',
        }),
        inputs: {},
        style: { plots: { volume: st('#5fc79c', { downColor: '#ec7b78', opacity: 0.26 }) }, fills: {} },
        label: 'Vol',
        paneHeight: 0.1,
        values: valuesOf(bars, { volume: (b) => b.v }),
      }),
      new IndicatorLayer({
        id: 'rsi',
        def: pane('rsi', [{ key: 'rsi', label: 'RSI', kind: 'line' }], { range: [0, 100] }),
        inputs: { length: 14 },
        style: { plots: { rsi: st('#dcebef') }, fills: {} },
        label: 'RSI 14',
        values: valuesOf(bars, { rsi: (_b, i) => 50 + 35 * Math.sin(i / 9) }),
      }),
      new IndicatorLayer({
        id: 'macd',
        def: pane('macd', [
          { key: 'hist', label: 'Histogram', kind: 'histogram', colorBy: 'sign' },
          { key: 'macd', label: 'MACD', kind: 'line' },
          { key: 'signal', label: 'Signal', kind: 'line' },
        ]),
        inputs: {},
        style: {
          plots: {
            hist: st('#5fc79c', { downColor: '#ec7b78', opacity: 0.5 }),
            macd: st('#dcebef'),
            signal: st('#18849a'),
          },
          fills: {},
        },
        label: 'MACD 12 26 9',
        values: valuesOf(bars, {
          hist: (_b, i) => Math.sin(i / 5),
          macd: (_b, i) => Math.sin(i / 7),
          signal: (_b, i) => Math.sin(i / 11),
        }),
      }),
    ];
  }

  it('pans 1,000 bars with indicator panes within budget, and updates them cheaply', () => {
    const chart = headless({ width, height, volumePane: 0 });
    chart.setData('main', bars);
    const studies = [...indicators(), vwapLayer(bars)];
    for (const layer of studies) chart.addLayer(layer);
    chart.setViewport({ lastBars: 1000 });
    chart.render(true);
    expect(chart.coords().panes).toHaveLength(3);
    const pan = timeFrames(
      60,
      () => chart.engine.wheel(-12, 0, 800, 400),
      () => chart.render(),
    );
    snapshot(chart, 'indicators-1000');
    check('panIndicators1000', stats(pan));
    let last = bars.at(-1)!;
    const upd: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t0 = threadMs();
      if (i % 50 === 49) {
        last = { t: last.t + 300_000, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 };
      } else {
        const c = last.c + Math.sin(i) * 0.05;
        last = { ...last, c, h: Math.max(last.h, c), l: Math.min(last.l, c), v: last.v + 100 };
      }
      chart.update('main', last);
      tick(studies, last.t, last.c);
      upd.push(threadMs() - t0);
    }
    expect(studies.map((l) => l.valueAt(l.def.plots[0]!.key, bars.length + 9))).toEqual(studies.map(() => last.c));
    check('updateIndicators', stats(upd));
    chart.destroy();
  });
});

describe('perf: order-flow stores (orderflow spec §12)', () => {
  const ES = new TickGrid(0.25);
  const mid = 23_000;

  it('applies a 400-change depth message within budget', () => {
    const book = new BookStore(ES);
    const r = rng(11);
    const level = (t: number) => [ES.toPrice(t), 1 + Math.floor(r() * 400)];
    book.apply(
      {
        seq: 1,
        kind: 'snapshot',
        levels: 200,
        bids: Array.from({ length: 200 }, (_, k) => level(mid - k)),
        asks: Array.from({ length: 200 }, (_, k) => level(mid + 1 + k)),
      },
      0,
    );
    const messages: string[] = [];
    for (let m = 0; m < 200; m++) {
      const side = (sign: number) =>
        Array.from({ length: 200 }, (_, k) => {
          const t = sign < 0 ? mid - k : mid + 1 + k;
          return [ES.toPrice(t), k % 37 === m % 37 ? 0 : 1 + Math.floor(r() * 400)];
        });
      messages.push(JSON.stringify({ seq: 2 + m, kind: 'delta', levels: 200, bids: side(-1), asks: side(1) }));
    }
    const samples = messages.map((json, k) => {
      const t0 = threadMs();
      const msg = JSON.parse(json) as DepthMessage;
      book.apply(msg, k);
      return threadMs() - t0;
    });
    expect(book.seq).toBe(201);
    check('bookDelta', stats(samples.slice(20)));
  });

  it('ingests a 5,000-prints-a-second burst in 125-print batches within budget', () => {
    const tape = new TradeTape(ES);
    const agg = new AggTape(tape);
    tape.applySnapshot({ seq: 0, trades: [] });
    const r = rng(5);
    let ns = 1.8e18;
    const batches: string[] = [];
    let seq = 0;
    for (let b = 0; b < 400; b++) {
      const trades: number[][] = [];
      for (let k = 0; k < 125; k++) {
        if (r() < 0.6) ns += 1000 + Math.floor(r() * 100_000);
        trades.push([ns, ES.toPrice(mid + Math.floor(r() * 8)), 1 + Math.floor(r() * 20), r() < 0.5 ? 1 : -1]);
      }
      seq += trades.length;
      batches.push(JSON.stringify({ seq, trades }));
    }
    const samples = batches.map((json) => {
      const t0 = threadMs();
      tape.apply(JSON.parse(json) as { seq: number; trades: number[][] });
      agg.sync();
      return threadMs() - t0;
    });
    expect(tape.length).toBe(50_000);
    expect(agg.length).toBeGreaterThan(10_000);
    check('ingestBurst5000', stats(samples.slice(40)));
  });

  it('profiles a visible range of footprints within budget', () => {
    const store = new FootprintStore(ES);
    const r = rng(9);
    const bars = Array.from({ length: 2000 }, (_, i) => {
      const low = mid + Math.floor(Math.sin(i / 40) * 80) + Math.floor(r() * 8);
      return {
        t: i * 60_000,
        row: 0.25,
        cells: Array.from({ length: 24 + Math.floor(r() * 24) }, (_, k) => [
          ES.toPrice(low + k),
          Math.floor(r() * 300),
          Math.floor(r() * 300),
        ]),
        deltaHigh: null,
        deltaLow: null,
      };
    });
    store.setHistory(bars);
    const samples = Array.from({ length: 40 }, (_, k) => {
      const from = 1000 + k * 7;
      const t0 = threadMs();
      const p = footprintProfile(store, from, from + 300, 2 + (k % 2) * 2);
      const ms = threadMs() - t0;
      expect(p?.poc).toBeGreaterThanOrEqual(0);
      return ms;
    });
    check('profileVisible', stats(samples.slice(4)));
  });

  it('blits a full footprint’s numbers from the glyph atlas within budget', () => {
    const dpr = 2;
    const canvas = createCanvas(1920 * dpr, 1080 * dpr);
    const ctx = canvas.getContext('2d') as unknown as Ctx2D;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const atlas = new GlyphAtlas({
      createCanvas: (w, h) => createCanvas(w, h),
      family: TESSERA_THEME.fontFig,
      size: 11.5,
      colors: [`rgba(238,243,244,${String(FOOTPRINT_TEXT.alpha)})`, TESSERA_THEME.upText, TESSERA_THEME.downText],
      dpr,
    });
    const r = rng(4);
    const cells = Array.from({ length: 780 }, () => [
      formatCount(Math.floor(r() * r() * 3000)),
      formatCount(Math.floor(r() * 900)),
    ]);
    const frames = Array.from({ length: 30 }, () => {
      const t0 = threadMs();
      ctx.clearRect(0, 0, 1920, 1080);
      for (let k = 0; k < cells.length; k++) {
        const bar = Math.floor(k / 39);
        const row = k % 39;
        const x = 40 + bar * 90;
        const y = 20 + row * 26;
        const [bid, ask] = cells[k]!;
        atlas.draw(ctx, bid!, x + 40, y, 'right', 0, 0);
        atlas.draw(ctx, ask!, x + 50, y, 'left', k % 9 === 0 ? 1 : 0, k % 9 === 0 ? 1 : 0);
      }
      return threadMs() - t0;
    });
    if (REPORT) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'footprint-text.png'), canvas.toBuffer('image/png'));
    }
    check('footprintText1560', stats(frames.slice(5)));
  });
});

describe('perf: order-flow layers (orderflow spec §12, 1920×1080 at dpr 2)', () => {
  const SAMPLES = 100;
  const grid = new TickGrid(0.25);
  const t0 = Date.UTC(2026, 9, 5, 13, 30);
  function wideMarket() {
    const r = rng(11);
    const bars: Bar[] = [];
    const footprints = [];
    for (let i = 0; i < 300; i++) {
      const base = grid.toTick(5800) + Math.round((r() - 0.5) * 6);
      const cells: number[][] = [];
      for (let k = 0; k < 40; k++)
        cells.push([grid.toPrice(base + k), Math.floor(r() * r() * 3000), Math.floor(r() * 900)]);
      const t = t0 + i * 60_000;
      bars.push({
        t,
        o: grid.toPrice(base + 5),
        h: grid.toPrice(base + 39),
        l: grid.toPrice(base),
        c: grid.toPrice(base + 30),
        v: 1,
      });
      footprints.push({ t, row: 0.25, cells, deltaHigh: null, deltaLow: null });
    }
    return { bars, footprints };
  }
  const chartOpts = {
    width: 1920,
    height: 1080,
    dpr: 2,
    timeframeMs: 60_000,
    priceFormat: { precision: 2, minMove: 0.25 },
    sessions: { mode: 'continuous' as const, timezone: 'UTC', dayStartMinutes: 0 },
  };

  it('draws a full footprint at LOD 2 and pans it within budget', () => {
    const { bars, footprints } = wideMarket();
    const chart = headless(chartOpts);
    chart.setData('main', bars);
    const store = new FootprintStore(grid);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    chart.setViewport({ barSpacing: 94 });
    chart.setViewport({ price: { min: 5797, max: 5812 } });
    chart.render(true);
    expect(fp.lod).toBe(2);
    const frameOf = (n: number) =>
      stats(
        timeFrames(
          n,
          () => chart.setOptions({}),
          () => chart.render(),
        ).slice(5),
      );
    const withFootprint = frameOf(SAMPLES);
    fp.setStore(null);
    chart.render(true);
    const bare = frameOf(SAMPLES);
    fp.setStore(store);
    chart.render(true);
    check('footprintL2', share(withFootprint, bare));
    snapshot(chart, 'footprint-l2');
    const pan = timeFrames(
      40,
      (i) => chart.engine.wheel(i % 2 ? 40 : -40, 0, 900, 500),
      () => chart.render(),
    );
    check('footprintPan', stats(pan.slice(5)));
    chart.destroy();
  });

  it('zooms a busy 5m footprint across the numbers threshold, in and out, within budget', () => {
    const r = rng(5);
    const bars: Bar[] = [];
    const footprints: FootprintInput[] = [];
    let tick = grid.toTick(21_000);
    for (let i = 0; i < 600; i++) {
      const range = 40 + Math.floor(r() * 120);
      const low = tick - Math.floor(r() * range);
      const cells: number[][] = [];
      for (let k = 0; k <= range; k++)
        cells.push([grid.toPrice(low + k), Math.floor(r() * r() * 400), Math.floor(r() * r() * 400)]);
      const t = t0 + i * 300_000;
      const close = low + Math.floor(r() * range);
      bars.push({
        t,
        o: grid.toPrice(low + Math.floor(r() * range)),
        h: grid.toPrice(low + range),
        l: grid.toPrice(low),
        c: grid.toPrice(close),
        v: 1,
      });
      footprints.push({ t, row: 0.25, cells, deltaHigh: null, deltaLow: null });
      tick = close;
    }
    const timers = new ManualTimers();
    const chart = headless({ ...chartOpts, timeframeMs: 300_000, timers });
    chart.setData('main', bars);
    const store = new FootprintStore(grid);
    store.setHistory(footprints, true);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    chart.setViewport({ barSpacing: 50 });
    chart.render(true);
    timers.advance(1000);
    chart.render(true);
    expect(fp.lod).toBe(1);
    const figures = () => (fp.lod >= 2 ? fp.figureSize : 0);
    const crossings: number[] = [];
    const shown = new Set<number>();
    let held = figures();
    for (let pass = 0; pass < 3; pass++)
      for (let i = 0; i < 60; i++) {
        chart.engine.wheel(0, i < 30 ? -15 : 15, 900, 500);
        const t = threadMs();
        chart.render();
        const ms = threadMs() - t;
        if (figures() !== held) crossings.push(ms);
        held = figures();
        shown.add(held);
      }
    expect([...shown].sort()).toEqual([0, ...FOOTPRINT_FIGURE_SIZES].sort());
    expect(crossings.length).toBeGreaterThanOrEqual(3 * 2 * FOOTPRINT_FIGURE_SIZES.length);
    check('footprintNumbersOn', stats(crossings));
    chart.destroy();
  });

  it('draws 500 big-trade bubbles within budget', () => {
    const { bars } = wideMarket();
    const chart = headless(chartOpts);
    chart.setData('main', bars);
    const r = rng(3);
    const trades: BigTrade[] = Array.from({ length: 2000 }, (_, k): BigTrade => {
      const b = bars[Math.floor(r() * bars.length)]!;
      return {
        t: b.t + r() * 60_000,
        price: b.l + r() * (b.h - b.l),
        size: 50 + Math.floor(r() * 400),
        side: r() > 0.5 ? 1 : -1,
        prints: 1,
        ref: String(k),
      };
    }).sort((a, b) => a.t - b.t);
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    big.setSource({ reference: () => 200, between: (a, b) => trades.filter((t) => t.t >= a && t.t <= b) });
    chart.addLayer(big);
    chart.setViewport({ fitAll: true });
    chart.render(true);
    const frame = () =>
      stats(
        timeFrames(
          SAMPLES,
          () => chart.setOptions({}),
          () => chart.render(),
        ).slice(5),
      );
    const withBubbles = frame();
    chart.setLayerVisible('bt', false);
    const without = frame();
    snapshot(chart, 'bubbles');
    check('bubbles500', share(withBubbles, without));
    chart.destroy();
  });

  it('draws a live frame of every order-flow view within budget, a forming update each frame', () => {
    const r = rng(17);
    const n = 1200;
    const bars: Bar[] = [];
    const footprints: FootprintInput[] = [];
    let base = grid.toTick(5800);
    for (let i = 0; i < n; i++) {
      base += Math.round((r() - 0.5) * 6);
      const cells: number[][] = [];
      for (let k = 0; k < 40; k++)
        cells.push([grid.toPrice(base + k), Math.floor(r() * r() * 3000), Math.floor(r() * 900)]);
      const t = t0 + i * 60_000;
      bars.push({
        t,
        o: grid.toPrice(base + 5),
        h: grid.toPrice(base + 39),
        l: grid.toPrice(base),
        c: grid.toPrice(base + 30),
        v: 1,
      });
      footprints.push({ t, row: 0.25, cells, deltaHigh: null, deltaLow: null });
    }
    const timers = new ManualTimers();
    const chart = headless({ ...chartOpts, timers });
    chart.setData('main', bars);
    const store = new FootprintStore(grid);
    store.setHistory(footprints, true);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid,
      style: {
        poc: perfStyle('#dcebef'),
        vah: perfStyle('#6f7c82', { line: 'dot' }),
        val: perfStyle('#6f7c82', { line: 'dot' }),
      },
    });
    vp.setFootprints(store);
    chart.addLayer(vp);
    const delta = new DeltaLayer({
      id: 'cvd',
      style: {
        zero: perfStyle('#4a555b', { line: 'dot' }),
        delta: perfStyle('#5fc79c', { downColor: '#ec7b78', opacity: 0.5 }),
        cvd: perfStyle('#dcebef', { width: 1.25, opacity: 0.55 }),
      },
    });
    chart.addLayer(delta);
    const flows = cvdRows(footprints);
    delta.setValues(cvdValues(bars, flows));
    let trades: BigTrade[] = Array.from({ length: 3000 }, (_, k): BigTrade => {
      const b = bars[n - 1 - Math.floor(r() * 60)]!;
      return {
        t: b.t + r() * 60_000,
        price: b.l + r() * (b.h - b.l),
        size: 50 + Math.floor(r() * 400),
        side: r() > 0.5 ? 1 : -1,
        prints: 1,
        ref: String(k),
      };
    }).sort((a, b) => a.t - b.t);
    let view: { a: number; b: number; out: BigTrade[] } | null = null;
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    big.setSource({
      reference: () => 200,
      between: (a, b) => {
        if (view?.a !== a || view.b !== b) view = { a, b, out: trades.filter((t) => t.t >= a && t.t <= b) };
        return view.out;
      },
    });
    chart.addLayer(big);
    chart.setViewport({ barSpacing: 94 });
    chart.setViewport({ price: { min: 5797, max: 5812 } });
    chart.render(true);
    expect(fp.lod).toBe(2);
    timers.advance(1000);
    chart.render(true);
    const last = footprints[n - 1]!;
    const live = timeFrames(
      2 * SAMPLES,
      (i) => {
        const cell = last.cells[i % last.cells.length]!;
        store.apply({
          bar: { ...last, cells: [[cell[0], cell[1] + i, cell[2] + 2 * i]] },
          closed: false,
          partial: true,
        });
        fp.dataChanged();
        vp.dataChanged();
        const forming = flows[n - 1]!;
        const close = forming.close + i;
        delta.values.replaceSpan(last.t, last.t, Float64Array.of(last.t), {
          delta: Float64Array.of(forming.d + i),
          volume: Float64Array.of(forming.v + 3 * i),
          open: Float64Array.of(forming.open),
          high: Float64Array.of(Math.max(forming.open, close)),
          low: Float64Array.of(Math.min(forming.open, close)),
          close: Float64Array.of(close),
          candle: Float64Array.of(0),
        });
        delta.valuesChanged({ kind: 'span', from: last.t, to: last.t });
        if (i % 10 === 0) {
          trades = [
            ...trades,
            { t: last.t + 30_000, price: last.cells[0]![0], size: 400, side: 1, prints: 1, ref: `n${String(i)}` },
          ];
          view = null;
          big.dataChanged();
        }
      },
      () => chart.render(),
    );
    snapshot(chart, 'live-frame');
    check('liveFrame', stats(live.slice(5)));
    chart.destroy();
  });

  it('pans a 1m order-flow chart zoomed fully out over 14 sessions within budget', () => {
    const r = rng(21);
    const bars: Bar[] = [];
    const footprints: FootprintInput[] = [];
    const trades: BigTrade[] = [];
    const sessions: SessionProfileData[] = [];
    let tick = grid.toTick(20_000);
    for (let s = 0; s < 14; s++) {
      const from = t0 + s * 86_400_000;
      const rows = new Map<number, [number, number]>();
      for (let m = 0; m < 1380; m++) {
        const t = from + m * 60_000;
        const open = tick;
        tick += Math.round((r() - 0.5) * 16);
        const low = Math.min(open, tick) - Math.floor(r() * 10);
        const high = Math.max(open, tick) + Math.floor(r() * 10);
        const cells: number[][] = [];
        for (let k = low; k <= high; k++) {
          const bid = Math.floor(r() * r() * 120);
          const ask = Math.floor(r() * r() * 120);
          cells.push([grid.toPrice(k), bid, ask]);
          const row = rows.get(k) ?? [0, 0];
          rows.set(k, [row[0] + bid, row[1] + ask]);
        }
        const o = grid.toPrice(open);
        bars.push({ t, o, h: grid.toPrice(high), l: grid.toPrice(low), c: grid.toPrice(tick), v: 1 });
        footprints.push({ t, row: 0.25, cells, deltaHigh: null, deltaLow: null });
        if (r() < 0.03)
          trades.push({
            t: t + 30_000,
            price: o,
            size: 50 + Math.floor(r() * 400),
            side: r() > 0.5 ? 1 : -1,
            prints: 1,
            ref: String(t),
          });
      }
      const lowTick = Math.min(...rows.keys());
      const n = Math.max(...rows.keys()) - lowTick + 1;
      const buy = new Float64Array(n);
      const sell = new Float64Array(n);
      for (const [k, [b, a]] of rows) {
        buy[k - lowTick] = a;
        sell[k - lowTick] = b;
      }
      const volume = buy.map((v, k) => v + sell[k]!);
      sessions.push({
        from,
        to: from + 1380 * 60_000,
        label: `S${String(s)}`,
        rowTicks: 1,
        lowTick,
        rows: n,
        volume,
        buy,
        sell,
      });
    }
    const chart = headless(chartOpts);
    chart.setData('main', bars);
    const store = new FootprintStore(grid);
    store.setHistory(footprints, true);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid,
      options: { length: 14 },
      style: {
        poc: perfStyle('#dcebef'),
        vah: perfStyle('#6f7c82', { line: 'dot' }),
        val: perfStyle('#6f7c82', { line: 'dot' }),
      },
    });
    vp.setFootprints(store);
    vp.setSource({ periods: () => sessions, composite: () => null, span: () => null });
    chart.addLayer(vp);
    const delta = new DeltaLayer({
      id: 'cvd',
      style: {
        zero: perfStyle('#4a555b', { line: 'dot' }),
        delta: perfStyle('#5fc79c', { downColor: '#ec7b78', opacity: 0.5 }),
        cvd: perfStyle('#dcebef', { width: 1.25, opacity: 0.55 }),
      },
    });
    chart.addLayer(delta);
    delta.setValues(cvdValues(bars, cvdRows(footprints)));
    const slices = new Map<string, BigTrade[]>();
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    big.setSource({
      reference: () => 200,
      between: (a, b) => {
        const key = `${String(a)}|${String(b)}`;
        const held = slices.get(key) ?? trades.filter((t) => t.t >= a && t.t <= b);
        slices.set(key, held);
        return held;
      },
    });
    chart.addLayer(big);
    chart.setViewport({ fitAll: true });
    chart.render(true);
    expect(chart.getViewport().to - chart.getViewport().from + 1).toBeGreaterThan(19_000);
    const pan = timeFrames(
      60,
      (i) => chart.engine.wheel(i % 2 ? 30 : -30, 0, 900, 400),
      () => chart.render(),
    );
    snapshot(chart, 'zoomed-out-order-flow');
    check('zoomedOutOrderFlow', stats(pan.slice(5)));
    chart.destroy();
  });
});
