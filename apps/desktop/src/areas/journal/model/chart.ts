import type { EquityPoint, Timeframe } from '@tessera/protocol';

export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Math.round(v / step) * step || 0);
  }
  return out;
}

export interface Scale {
  (v: number): number;
  domain: [number, number];
}

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = ((v: number) => r0 + (v - d0) * k) as Scale;
  f.domain = domain;
  return f;
}

export interface EquityGeometry {
  line: string;
  area: string;
  peak: string;
  under: string;
  y: Scale;
  dd: Scale;
  x: Scale;
  ticks: number[];
  split: number;
}

export function equityGeometry(
  points: readonly EquityPoint[],
  width: number,
  height: number,
  ddShare = 0.24,
): EquityGeometry {
  const n = points.length;
  const split = Math.round(height * (1 - ddShare));
  const values = [0, ...points.map((p) => p.equity), ...points.map((p) => p.peak)];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const ticks = niceTicks(lo, hi, 4);
  lo = Math.min(lo, ticks[0] ?? lo);
  hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const x = linear([0, Math.max(1, n)], [0, width]);
  const y = linear([lo, hi], [split - 6, 6]);
  const maxDd = Math.max(1, ...points.map((p) => p.drawdown));
  const dd = linear([0, maxDd], [split + 8, height - 2]);
  const fx = (v: number) => x(v).toFixed(1);
  const fy = (v: number) => y(v).toFixed(1);
  const pts = [{ i: 0, equity: 0, peak: 0, drawdown: 0 }, ...points];
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${fx(p.i)},${fy(p.equity)}`).join('');
  const area = n ? `${line}L${fx(n)},${fy(0)}L${fx(0)},${fy(0)}Z` : '';
  const peak = pts.map((p, i) => `${i ? 'L' : 'M'}${fx(p.i)},${fy(p.peak)}`).join('');
  const top = (split + 8).toFixed(1);
  const under = n
    ? `M${fx(0)},${top}${pts.map((p) => `L${fx(p.i)},${dd(p.drawdown).toFixed(1)}`).join('')}L${fx(n)},${top}Z`
    : '';
  return { line, area, peak, under, x, y, dd, ticks, split };
}

export function nearestIndex(px: number, x: Scale, n: number): number {
  const [d0, d1] = x.domain;
  const r0 = x(d0);
  const r1 = x(d1);
  const v = d0 + ((px - r0) / (r1 - r0 || 1)) * (d1 - d0);
  return Math.min(n, Math.max(1, Math.round(v)));
}

export function autoTimeframe(holdSecs: number | null): Timeframe {
  const m = (holdSecs ?? 0) / 60;
  if (m <= 40) return '1m';
  if (m <= 180) return '5m';
  if (m <= 480) return '15m';
  return '1h';
}

export interface Arc {
  dash: string;
  offset: number;
}

export function donutArcs(values: readonly number[], r: number): Arc[] {
  const c = 2 * Math.PI * r;
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  let at = 0;
  return values.map((v) => {
    const len = total > 0 ? (Math.max(0, v) / total) * c : 0;
    const arc = { dash: `${len.toFixed(2)} ${(c - len).toFixed(2)}`, offset: -at };
    at += len;
    return arc;
  });
}

export function gaugeArc(share: number, r: number): Arc {
  const c = 2 * Math.PI * r;
  const len = Math.max(0, Math.min(1, Number.isFinite(share) ? share : 0)) * c;
  return { dash: `${len.toFixed(2)} ${(c - len).toFixed(2)}`, offset: 0 };
}

export function cumulative(values: readonly number[]): number[] {
  let s = 0;
  return values.map((v) => (s += v));
}

export interface SeriesGeometry {
  line: string;
  area: string;
  x: Scale;
  y: Scale;
  ticks: number[];
}

export function seriesGeometry(values: readonly number[], width: number, height: number, pad = 6): SeriesGeometry {
  const n = values.length;
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  const ticks = niceTicks(lo, hi, 4);
  lo = Math.min(lo, ticks[0] ?? lo);
  hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const x = linear([0, Math.max(1, n - 1)], [0, width]);
  const y = linear([lo, hi === lo ? lo + 1 : hi], [height - pad, pad]);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = n ? `${line}L${x(n - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z` : '';
  return { line, area, x, y, ticks };
}

export function multiGeometry(
  series: readonly (readonly number[])[],
  width: number,
  height: number,
  pad = 6,
): { lines: string[]; x: Scale; y: Scale; ticks: number[] } {
  const n = Math.max(0, ...series.map((s) => s.length));
  const all = series.flat();
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  const ticks = niceTicks(lo, hi, 4);
  lo = Math.min(lo, ticks[0] ?? lo);
  hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const x = linear([0, Math.max(1, n - 1)], [0, width]);
  const y = linear([lo, hi === lo ? lo + 1 : hi], [height - pad, pad]);
  const lines = series.map((s) => s.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''));
  return { lines, x, y, ticks };
}
