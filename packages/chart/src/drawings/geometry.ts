import { MINUS } from '../format.ts';
import type { RenderContext } from '../layers/types.ts';
import type { Rect } from '../types.ts';
import type { DrawingExtend } from './types.ts';

export interface Pt {
  x: number;
  y: number;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const s = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + s * dx), p.y - (a.y + s * dy));
}

export function inPolygon(p: Pt, pts: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function clipRange(a: Pt, b: Pt, rect: Rect): [number, number] | null {
  let lo = -Infinity;
  let hi = Infinity;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.w - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.h - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) lo = Math.max(lo, r);
    else hi = Math.min(hi, r);
  }
  return lo <= hi ? [lo, hi] : null;
}

export function extendSegment(a: Pt, b: Pt, extend: DrawingExtend, rect: Rect): [Pt, Pt] | null {
  if (extend === 'none' || (a.x === b.x && a.y === b.y)) return [a, b];
  const bIsRight = b.x > a.x || (b.x === a.x && b.y > a.y);
  const right = extend === 'right' || extend === 'both';
  const left = extend === 'left' || extend === 'both';
  let lo = 0;
  let hi = 1;
  if (right) {
    if (bIsRight) hi = Infinity;
    else lo = -Infinity;
  }
  if (left) {
    if (bIsRight) lo = -Infinity;
    else hi = Infinity;
  }
  const clip = clipRange(a, b, rect);
  if (!clip) return null;
  lo = Math.max(lo, clip[0]);
  hi = Math.min(hi, clip[1]);
  if (lo > hi) return null;
  const at = (s: number): Pt => ({ x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y) });
  return [at(lo), at(hi)];
}

export function fibLevelPrices(
  first: number,
  second: number,
  levels: readonly number[],
): { level: number; price: number }[] {
  return levels.map((level) => ({ level, price: second + (first - second) * level }));
}

export function fibExtensionPrices(
  start: number,
  end: number,
  pullback: number,
  levels: readonly number[],
): { level: number; price: number }[] {
  return levels.map((level) => ({ level, price: pullback + (end - start) * level }));
}

export function fibFanPrices(
  origin: number,
  end: number,
  levels: readonly number[],
): { level: number; price: number }[] {
  return levels.map((level) => ({ level, price: origin + (end - origin) * level }));
}

export function screenAngle(a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const rise = a.y - b.y;
  if (dx === 0 && rise === 0) return Number.NaN;
  return (Math.atan2(rise, Math.abs(dx)) * 180) / Math.PI;
}

export function formatAngle(degrees: number): string {
  const v = degrees.toFixed(2);
  return `${Number(v) < 0 ? `${MINUS}${v.slice(1)}` : v.replace(/^-/, '')}°`;
}

export function formatLevel(level: number): string {
  return String(Number(level.toFixed(4)));
}

export interface MeasureStats {
  dPrice: number;
  ticks: number;
  pct: number;
  bars: number;
  ms: number;
}

export function measureStats(
  a: { price: number; index: number; t: number },
  b: { price: number; index: number; t: number },
  tick: number,
): MeasureStats {
  const dPrice = b.price - a.price;
  return {
    dPrice,
    ticks: tick > 0 ? Math.round(dPrice / tick) : Number.NaN,
    pct: a.price !== 0 ? (dPrice / Math.abs(a.price)) * 100 : Number.NaN,
    bars: Math.round(b.index - a.index),
    ms: b.t - a.t,
  };
}

export function formatDuration(ms: number): string {
  const sign = ms < 0 ? MINUS : '';
  const s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${sign}${String(d)}d${h ? ` ${String(h)}h` : ''}`;
  if (h > 0) return `${sign}${String(h)}h${m ? ` ${String(m)}m` : ''}`;
  if (m > 0) return `${sign}${String(m)}m`;
  return `${sign}${String(s)}s`;
}

export function magnetPrice(
  y: number,
  bar: { o: number; h: number; l: number; c: number },
  yOf: (p: number) => number,
) {
  let best = bar.c;
  let bestD = Infinity;
  for (const v of [bar.o, bar.h, bar.l, bar.c]) {
    const d = Math.abs(yOf(v) - y);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

export interface DrawingAxes {
  readonly pane: Rect;
  readonly tick: number;
  readonly barSpacing: number;
  readonly ready: boolean;
  readonly key: string;
  readonly lastBarX: number;
  xOfTime(t: number): number;
  timeOfX(x: number): number;
  indexOfTime(t: number): number;
  yOfPrice(p: number): number;
  priceOfY(y: number): number;
  barAt(x: number): { o: number; h: number; l: number; c: number } | null;
  formatPrice(p: number): string;
}

export function drawingAxes(
  rc: Pick<RenderContext, 'store' | 'session' | 'time' | 'timeframeMs' | 'price' | 'pane' | 'format'>,
): DrawingAxes {
  const { store, session, time, price, pane, format } = rc;
  const n = store.length;
  const slots = session.slot;
  const last = n - 1;
  const tl = n > 0 ? store.time[last]! : 0;
  const t0 = n > 0 ? store.time[0]! : 0;
  const tf = rc.timeframeMs > 0 ? rc.timeframeMs : n > 1 ? tl - store.time[last - 1]! : 60_000;
  const slotLast = n > 0 ? (slots[last] ?? last) : 0;
  const slotFirst = n > 0 ? (slots[0] ?? 0) : 0;
  const xLast = n > 0 ? time.xOfIndex(last) : 0;
  const spacing = time.barSpacing;
  const slotOfTime = (t: number): number => {
    if (t > tl) return slotLast + (t - tl) / tf;
    if (t < t0) return slotFirst - (t0 - t) / tf;
    const i = store.indexAtOrBefore(t);
    return slots[i] ?? i;
  };
  const slotOfX = (x: number) => slotLast + (x - xLast) / spacing;
  return {
    pane,
    tick: format.minMove,
    barSpacing: spacing,
    ready: n > 0,
    key: `${String(n)}|${String(tl)}|${String(xLast)}|${String(spacing)}|${String(price.yOf(0))}|${String(price.yOf(1))}|${String(pane.x)},${String(pane.y)},${String(pane.w)},${String(pane.h)}`,
    lastBarX: n > 0 ? xLast : Number.NaN,
    xOfTime: (t) => (n > 0 && Number.isFinite(t) ? xLast + (slotOfTime(t) - slotLast) * spacing : Number.NaN),
    timeOfX: (x) => {
      if (n === 0) return Number.NaN;
      const s = slotOfX(x);
      if (s > slotLast + 0.5) return tl + Math.round(s - slotLast) * tf;
      if (s < slotFirst - 0.5) return t0 - Math.round(slotFirst - s) * tf;
      return store.time[session.indexOfSlot(s)]!;
    },
    indexOfTime: (t) => {
      if (n === 0) return Number.NaN;
      if (t > tl) return last + (t - tl) / tf;
      if (t < t0) return -(t0 - t) / tf;
      return store.indexAtOrBefore(t);
    },
    yOfPrice: (p) => price.yOf(p),
    priceOfY: (y) => price.priceOf(y),
    barAt: (x) => {
      if (n === 0) return null;
      const s = slotOfX(x);
      if (s > slotLast + 0.5 || s < slotFirst - 0.5) return null;
      const i = session.indexOfSlot(s);
      return { o: store.open[i]!, h: store.high[i]!, l: store.low[i]!, c: store.close[i]! };
    },
    formatPrice: (p) => format.grouped(p),
  };
}
