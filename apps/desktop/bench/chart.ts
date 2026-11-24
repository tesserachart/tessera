import {
  BigTradesLayer,
  createChart,
  DeltaLayer,
  FootprintLayer,
  FootprintStore,
  IndicatorLayer,
  SeriesValues,
  TickGrid,
  VolumeProfileLayer,
  type Bar,
  type BigTrade,
  type ChartApi,
  type FootprintInput,
  type PlotStyle,
  type SessionProfileData,
} from '@tessera/chart';
import { INDICATOR_SPECS } from '@tessera/protocol';
import { engineStyle, indicatorLabel, resolveIndicator } from '../src/chart/indicators.ts';
import { deltaOptions } from '../src/chart/layers/orderflow/delta.ts';
import { footprintOptions } from '../src/chart/layers/orderflow/footprint.ts';
import { profileOptions } from '../src/chart/layers/orderflow/volumeProfile.ts';

export interface BenchPage {
  chart: ChartApi;
  frames: { durationMs: number }[];
}

declare global {
  interface Window {
    bench?: BenchPage;
  }
}

const TICK = 0.25;
const DAY_MS = 86_400_000;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function globexBars(n: number, r: () => number): Bar[] {
  const out: Bar[] = [];
  let t = Date.UTC(2026, 9, 23, 20, 59);
  let p = 21_000;
  while (out.length < n) {
    const d = new Date(t);
    const h = d.getUTCHours();
    const wd = d.getUTCDay();
    const closed = h === 21 || wd === 6 || (wd === 0 && h < 22) || (wd === 5 && h >= 21);
    if (!closed) {
      const o = p;
      const c = o + Math.round((r() - 0.5) * 16) * TICK;
      const hi = Math.max(o, c) + Math.round(r() * 8) * TICK;
      const lo = Math.min(o, c) - Math.round(r() * 8) * TICK;
      out.push({ t, o, h: hi, l: lo, c, v: Math.round(50 + r() * r() * 3000) });
      p = c;
    }
    t -= 60_000;
  }
  return out.reverse();
}

const SESSION_OPEN_UTC_HOUR = 22;
const sessionDay = (t: number) => Math.floor((t + (24 - SESSION_OPEN_UTC_HOUR) * 3_600_000) / DAY_MS);

function values(bars: readonly Bar[], columns: Record<string, (b: Bar, i: number) => number>): SeriesValues {
  const v = new SeriesValues();
  v.replaceAll(
    Float64Array.from(bars, (b) => b.t),
    Object.fromEntries(Object.entries(columns).map(([k, f]) => [k, Float64Array.from(bars, f)])),
  );
  return v;
}

function settingsOf(kind: string) {
  const spec = INDICATOR_SPECS.find((s) => s.kind === kind)!;
  return { spec, settings: resolveIndicator(spec, {}) };
}

function plotStyles(kind: string): Record<string, PlotStyle> {
  const { spec, settings } = settingsOf(kind);
  const plots = engineStyle(spec, settings).plots;
  return Object.fromEntries(Object.entries(plots).map(([k, p]) => [k, { ...p, downColor: p.downColor ?? null }]));
}

function addStandard(chart: ChartApi, bars: readonly Bar[]): void {
  let day = -1;
  let pv = 0;
  let vv = 0;
  const vwap = bars.map((b) => {
    if (sessionDay(b.t) !== day) {
      day = sessionDay(b.t);
      pv = 0;
      vv = 0;
    }
    pv += ((b.h + b.l + b.c) / 3) * b.v;
    vv += b.v;
    return pv / vv;
  });
  const fed: Record<string, SeriesValues> = {
    volume: values(bars, { volume: (b) => b.v, ma: () => Number.NaN }),
    vwap: values(bars, { vwap: (_b, i) => vwap[i]! }),
  };
  for (const [order, kind] of (['volume', 'vwap'] as const).entries()) {
    const { spec, settings } = settingsOf(kind);
    chart.addLayer(
      new IndicatorLayer({
        id: `model:${kind}`,
        def: spec,
        inputs: settings.inputs,
        style: engineStyle(spec, settings),
        label: indicatorLabel(spec, settings.inputs),
        z: kind === 'vwap' ? 5 : 10,
        legend: false,
        paneOrder: order,
        values: fed[kind],
      }),
    );
  }
}

function addOrderFlow(chart: ChartApi, bars: readonly Bar[], r: () => number): void {
  const grid = new TickGrid(TICK);
  const footprints: FootprintInput[] = [];
  const trades: BigTrade[] = [];
  const bySession = new Map<number, { from: number; to: number; rows: Map<number, [number, number]> }>();
  const cvd: { d: number; v: number; open: number; close: number }[] = [];
  let sum = 0;
  let day = -1;
  for (const b of bars) {
    const k = sessionDay(b.t);
    if (k !== day) {
      day = k;
      sum = 0;
    }
    const session = bySession.get(k) ?? { from: b.t, to: b.t, rows: new Map<number, [number, number]>() };
    bySession.set(k, session);
    session.to = b.t + 60_000;
    const cells: [number, number, number][] = [];
    let d = 0;
    for (let tick = grid.toTick(b.l); tick <= grid.toTick(b.h); tick++) {
      const bid = Math.floor(r() * r() * 120);
      const ask = Math.floor(r() * r() * 120);
      cells.push([grid.toPrice(tick), bid, ask]);
      d += ask - bid;
      const row = session.rows.get(tick) ?? [0, 0];
      session.rows.set(tick, [row[0] + ask, row[1] + bid]);
    }
    footprints.push({ t: b.t, row: TICK, cells, deltaHigh: null, deltaLow: null });
    cvd.push({ d, v: b.v, open: sum, close: sum + d });
    sum += d;
    if (r() < 0.03) {
      trades.push({
        t: b.t + 30_000,
        price: b.o,
        size: 50 + Math.floor(r() * 400),
        side: r() > 0.5 ? 1 : -1,
        prints: 1,
        ref: String(b.t),
      });
    }
  }
  const sessions: SessionProfileData[] = [...bySession.values()].map((s, n) => {
    const lowTick = Math.min(...s.rows.keys());
    const rows = Math.max(...s.rows.keys()) - lowTick + 1;
    const buy = new Float64Array(rows);
    const sell = new Float64Array(rows);
    for (const [tick, [a, bid]] of s.rows) {
      buy[tick - lowTick] = a;
      sell[tick - lowTick] = bid;
    }
    const volume = buy.map((v, i) => v + sell[i]!);
    return { from: s.from, to: s.to, label: `S${String(n)}`, rowTicks: 1, lowTick, rows, volume, buy, sell };
  });

  const store = new FootprintStore(grid);
  store.setHistory(footprints, true);
  const fp = new FootprintLayer({ id: 'model:footprint' });
  fp.setOptions(footprintOptions(settingsOf('footprint').settings));
  fp.setStore(store);
  chart.addLayer(fp);

  const vpStyle = plotStyles('volume_profile');
  const vp = new VolumeProfileLayer({
    id: 'model:volume_profile',
    grid,
    style: { poc: vpStyle.poc!, vah: vpStyle.vah!, val: vpStyle.val! },
  });
  vp.setOptions(profileOptions(settingsOf('volume_profile').settings), vp.style);
  vp.setFootprints(store);
  vp.setSource({ periods: () => sessions, composite: () => null, span: () => null });
  chart.addLayer(vp);

  const big = new BigTradesLayer({ id: 'model:big_trades' });
  big.setSource({ reference: () => 200, between: (a, b) => trades.filter((t) => t.t >= a && t.t <= b) });
  chart.addLayer(big);

  const dStyle = plotStyles('delta');
  const delta = new DeltaLayer({
    id: 'model:delta',
    style: { zero: dStyle.zero!, delta: dStyle.delta!, cvd: dStyle.cvd! },
  });
  delta.setOptions(deltaOptions(settingsOf('delta').settings), delta.style);
  chart.addLayer(delta);
  delta.setValues(
    values(bars, {
      delta: (_b, i) => cvd[i]!.d,
      volume: (_b, i) => cvd[i]!.v,
      open: (_b, i) => cvd[i]!.open,
      high: (_b, i) => Math.max(cvd[i]!.open, cvd[i]!.close),
      low: (_b, i) => Math.min(cvd[i]!.open, cvd[i]!.close),
      close: (_b, i) => cvd[i]!.close,
      candle: () => 1,
    }),
  );
}

const params = new URLSearchParams(location.search);
const host = document.getElementById('host')!;
const chart = createChart(host, { legend: { title: '' }, initialBars: 150, rightPadBars: 8, volumePane: 0 });
chart.setOptions({
  priceFormat: { precision: 2, minMove: TICK },
  sessions: { mode: 'continuous', timezone: 'America/New_York', dayStartMinutes: 18 * 60 },
  timeframeMs: 60_000,
});
const r = rng(11);
const bars = globexBars(Number(params.get('bars') ?? 50_000), r);
chart.setData('main', bars);
if (params.get('setup') === 'orderflow') addOrderFlow(chart, bars, r);
else addStandard(chart, bars);
const frames: BenchPage['frames'] = [];
chart.on('frame', (f) => frames.push({ durationMs: f.durationMs }));
window.bench = { chart, frames };
