import { createCanvas } from '@napi-rs/canvas';
import {
  createHeadlessChart,
  IndicatorLayer,
  SeriesValues,
  type Bar,
  type HeadlessChartOptions,
  type IndicatorDef,
} from '../src/index.ts';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ET_OFFSET_EDT = 4 * 3_600_000;

export function equityBars(sessions: number, seed = 7, start = 487): Bar[] {
  const r = rng(seed);
  const days: number[] = [];
  let d = Date.UTC(2026, 9, 2);
  while (days.length < sessions) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6) days.unshift(d);
    d -= 86_400_000;
  }
  const out: Bar[] = [];
  let p = start;
  for (const day of days) {
    for (let k = 0; k < 78; k++) {
      const t = day + 9.5 * 3_600_000 + k * 300_000 + ET_OFFSET_EDT;
      const o = p;
      const c = o + (r() - 0.5) * 0.6;
      const h = Math.max(o, c) + r() * 0.2;
      const l = Math.min(o, c) - r() * 0.2;
      out.push({ t, o: round2(o), h: round2(h), l: round2(l), c: round2(c), v: Math.round(50_000 + r() * 300_000) });
      p = c;
    }
  }
  return out;
}

export function continuousBars(n: number, t0 = Date.UTC(2026, 8, 1), seed = 3): Bar[] {
  const r = rng(seed);
  const out: Bar[] = [];
  let p = 98_000;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + (r() - 0.5) * 40;
    out.push({ t: t0 + i * 60_000, o, h: Math.max(o, c) + r() * 10, l: Math.min(o, c) - r() * 10, c, v: 1 + r() * 20 });
    p = c;
  }
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function headless(opts: Partial<HeadlessChartOptions> = {}) {
  return createHeadlessChart({
    width: 1200,
    height: 700,
    dpr: 1,
    createCanvas: (w, h) => createCanvas(w, h),
    now: () => Date.UTC(2026, 9, 2, 18, 42, 30),
    legend: { title: 'QQQ 5m', subtitle: 'Apex · Rithmic' },
    ...opts,
  });
}

export function valuesOf(
  bars: readonly Bar[],
  columns: Readonly<Record<string, (bar: Bar, i: number) => number>>,
): SeriesValues {
  const values = new SeriesValues();
  values.replaceAll(
    Float64Array.from(bars, (b) => b.t),
    Object.fromEntries(Object.entries(columns).map(([key, f]) => [key, Float64Array.from(bars, f)])),
  );
  return values;
}

function sessionVwap(bars: readonly Bar[]): SeriesValues {
  let day = '';
  let pv = 0;
  let v = 0;
  return valuesOf(bars, {
    vwap: (b) => {
      const d = new Date(b.t).toISOString().slice(0, 10);
      if (d !== day) {
        day = d;
        pv = 0;
        v = 0;
      }
      pv += ((b.h + b.l + b.c) / 3) * b.v;
      v += b.v;
      return v > 0 ? pv / v : b.c;
    },
  });
}

const VWAP: IndicatorDef = {
  kind: 'vwap',
  short: 'VWAP',
  placement: 'overlay',
  plots: [{ key: 'vwap', label: 'VWAP', kind: 'line' }],
  fills: [],
  sessionReset: true,
  format: 'price',
};

export function vwapLayer(bars: readonly Bar[]): IndicatorLayer {
  return new IndicatorLayer({
    id: 'vwap',
    def: VWAP,
    inputs: {},
    style: { plots: { vwap: { color: '#E8E4DA', width: 1.25, line: 'solid', opacity: 1, visible: true } }, fills: {} },
    label: 'VWAP',
    z: 5,
    values: sessionVwap(bars),
  });
}

export function threadMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}
