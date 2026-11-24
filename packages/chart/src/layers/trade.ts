import { crisp, font } from '../render/draw.ts';
import type { Ctx2D, Layer, LayerHost, RenderContext } from './types.ts';

export interface TradeFill {
  t: number;
  price: number;
  side: 'buy' | 'sell';
  qty: number;
}

export interface TradePlanStep {
  t: number;
  price: number | null;
}

export interface TradeOverlay {
  long: boolean;
  open: number;
  close: number | null;
  entry: number;
  exit: number | null;
  stop: readonly TradePlanStep[];
  target: readonly TradePlanStep[];
  fills: readonly TradeFill[];
  mae: number | null;
  mfe: number | null;
  colors: {
    entry: string;
    up: string;
    down: string;
    stopZone: string;
    targetZone: string;
    label: string;
  };
}

export interface TradeBar {
  x: number;
  high: number;
  low: number;
}

export interface TradeMap {
  xOf(ms: number): number;
  yOf(price: number): number;
  barAt(ms: number): TradeBar | null;
  lastTime: number;
}

export interface TradeGeometry {
  span: { x0: number; x1: number } | null;
  zones: { x0: number; x1: number; y0: number; y1: number; fill: string }[];
  runs: { x0: number; x1: number; y: number; color: string }[];
  joins: { x: number; y0: number; y1: number; color: string }[];
  entry: { x0: number; x1: number; y: number } | null;
  connector: { x0: number; y0: number; x1: number; y1: number; color: string } | null;
  fills: { x: number; y: number; side: 'buy' | 'sell'; qty: number; color: string }[];
  excursions: { x0: number; x1: number; y: number; label: string; color: string }[];
}

const FILL_GAP = 5;
const FILL_H = 6;

export function resultColor(o: TradeOverlay): string {
  if (o.exit === null || o.exit === o.entry) return o.colors.entry;
  return o.exit > o.entry === o.long ? o.colors.up : o.colors.down;
}

export function tradeGeometry(o: TradeOverlay, until: number | null, map: TradeMap): TradeGeometry {
  const out: TradeGeometry = {
    span: null,
    zones: [],
    runs: [],
    joins: [],
    entry: null,
    connector: null,
    fills: [],
    excursions: [],
  };
  const now = until ?? Infinity;
  if (now < o.open) return out;
  const closed = o.close !== null && o.close <= now;
  const end = Math.min(o.close ?? map.lastTime, now, map.lastTime);
  const x0 = map.xOf(o.open);
  const xEnd = map.xOf(Math.max(o.open, end));
  if (!Number.isFinite(x0) || !Number.isFinite(xEnd)) return out;
  const x1 = Math.max(xEnd, x0 + 4);
  out.span = { x0, x1 };
  const yEntry = map.yOf(o.entry);
  for (const [steps, fill, color] of [
    [o.stop, o.colors.stopZone, o.colors.down],
    [o.target, o.colors.targetZone, o.colors.up],
  ] as const) {
    let prev: number | null = null;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      const from = Math.max(s.t, o.open);
      const to = Math.min(i + 1 < steps.length ? steps[i + 1]!.t : end, end);
      if (to < from || from > end) break;
      if (s.price === null) {
        prev = null;
        continue;
      }
      const rx0 = Math.max(x0, map.xOf(from));
      const rx1 = i + 1 < steps.length && steps[i + 1]!.t <= end ? map.xOf(to) : x1;
      const y = map.yOf(s.price);
      out.zones.push({ x0: rx0, x1: rx1, y0: Math.min(y, yEntry), y1: Math.max(y, yEntry), fill });
      out.runs.push({ x0: rx0, x1: rx1, y, color });
      if (prev !== null && prev !== y) out.joins.push({ x: rx0, y0: prev, y1: y, color });
      prev = y;
    }
  }
  out.entry = { x0, x1, y: yEntry };
  for (const [price, label, color] of [
    [o.mfe, 'MFE', o.colors.up],
    [o.mae, 'MAE', o.colors.down],
  ] as const) {
    if (price !== null && closed) out.excursions.push({ x0, x1, y: map.yOf(price), label, color });
  }
  if (closed && o.exit !== null) {
    out.connector = { x0, y0: yEntry, x1: xEnd, y1: map.yOf(o.exit), color: resultColor(o) };
  }
  const byBar = new Map<string, { bar: TradeBar; side: 'buy' | 'sell'; qty: number }>();
  for (const f of o.fills) {
    if (f.t > now) continue;
    const bar = map.barAt(f.t);
    if (!bar) continue;
    const key = `${String(bar.x)}:${f.side}`;
    const at = byBar.get(key);
    if (at) at.qty += f.qty;
    else byBar.set(key, { bar, side: f.side, qty: f.qty });
  }
  for (const { bar, side, qty } of byBar.values()) {
    out.fills.push({
      x: bar.x,
      y: side === 'buy' ? map.yOf(bar.low) + FILL_GAP : map.yOf(bar.high) - FILL_GAP,
      side,
      qty,
      color: side === 'buy' ? o.colors.up : o.colors.down,
    });
  }
  return out;
}

function tradeMapOf(rc: RenderContext): TradeMap {
  const { time, price, store, timeframeMs } = rc;
  const n = store.length;
  return {
    xOf: (ms) => time.xOfTime(ms),
    yOf: (p) => price.yOf(p),
    barAt: (ms) => {
      const i = store.indexAtOrBefore(ms);
      return i < 0 ? null : { x: time.xOfIndex(i), high: store.high[i]!, low: store.low[i]! };
    },
    lastTime: n === 0 ? 0 : store.time[n - 1]! + timeframeMs,
  };
}

function drawTradeMarks(ctx: Ctx2D, g: TradeGeometry, colors: TradeOverlay['colors']): void {
  if (g.connector) {
    const c = g.connector;
    ctx.strokeStyle = c.color;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(c.x0, c.y0);
    ctx.lineTo(c.x1, c.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.arc(c.x1, c.y1, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (g.entry) {
    ctx.fillStyle = colors.entry;
    ctx.beginPath();
    ctx.arc(g.entry.x0, g.entry.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = 'left';
  for (const f of g.fills) {
    const half = FILL_H * 0.6;
    const dir = f.side === 'buy' ? 1 : -1;
    ctx.fillStyle = f.color;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.lineTo(f.x - half, f.y + dir * FILL_H);
    ctx.lineTo(f.x + half, f.y + dir * FILL_H);
    ctx.closePath();
    ctx.fill();
    if (f.qty > 1) {
      ctx.fillStyle = colors.label;
      ctx.fillText(String(f.qty), f.x + half + 3, f.y + dir * (FILL_H / 2));
    }
  }
}

export interface TradeLayerOptions {
  id: string;
  z?: number;
}

export class TradeLayer implements Layer {
  readonly id: string;
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = null;
  readonly owner = null;
  private trade: TradeOverlay | null = null;
  private until: number | null = null;
  private host: LayerHost | null = null;

  constructor(options: TradeLayerOptions) {
    this.id = options.id;
    this.z = options.z ?? 24;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  setTrade(trade: TradeOverlay | null): void {
    this.trade = trade;
    this.host?.invalidate();
  }

  setUntil(until: number | null): void {
    if (until === this.until) return;
    this.until = until;
    this.host?.invalidate();
  }

  autoscaleRange(): [number, number] | null {
    const o = this.trade;
    if (!o) return null;
    const prices = [o.entry, o.exit, o.mae, o.mfe, ...o.stop.map((s) => s.price), ...o.target.map((s) => s.price)];
    const known = prices.filter((p): p is number => p !== null && Number.isFinite(p));
    return known.length ? [Math.min(...known), Math.max(...known)] : null;
  }

  draw(rc: RenderContext): void {
    const o = this.trade;
    if (!o) return;
    const { ctx, dpr, pane, store, theme, format } = rc;
    if (store.length === 0) return;
    const g = tradeGeometry(o, this.until, tradeMapOf(rc));
    if (!g.span) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    for (const z of g.zones) {
      ctx.fillStyle = z.fill;
      ctx.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
    }
    ctx.lineWidth = 1 / dpr;
    for (const r of g.runs) {
      ctx.strokeStyle = r.color;
      ctx.beginPath();
      ctx.moveTo(r.x0, crisp(r.y, dpr));
      ctx.lineTo(r.x1, crisp(r.y, dpr));
      ctx.stroke();
    }
    for (const j of g.joins) {
      ctx.strokeStyle = j.color;
      ctx.beginPath();
      ctx.moveTo(crisp(j.x, dpr), crisp(j.y0, dpr));
      ctx.lineTo(crisp(j.x, dpr), crisp(j.y1, dpr));
      ctx.stroke();
    }
    const small = font(10, theme.font);
    ctx.font = small;
    ctx.textBaseline = 'middle';
    ctx.setLineDash([1, 3]);
    for (const e of g.excursions) {
      const y = crisp(e.y, dpr);
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(e.x0, y);
      ctx.lineTo(e.x1, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const w = ctx.measureText(e.label).width;
      if (e.x1 - e.x0 > w + 16) {
        ctx.fillStyle = o.colors.label;
        ctx.textAlign = 'left';
        ctx.fillText(e.label, e.x0 + 8, e.y + (g.entry && e.y < g.entry.y ? -7 : 7));
      }
    }
    ctx.setLineDash([]);
    if (g.entry) {
      ctx.strokeStyle = o.colors.entry;
      ctx.beginPath();
      ctx.moveTo(g.entry.x0, crisp(g.entry.y, dpr));
      ctx.lineTo(g.entry.x1, crisp(g.entry.y, dpr));
      ctx.stroke();
    }
    drawTradeMarks(ctx, g, o.colors);
    ctx.restore();
    rc.addAxisTag({
      price: o.entry,
      text: format.grouped(o.entry),
      style: 'outline',
      color: o.colors.entry,
      priority: 22,
    });
    if (g.connector && o.exit !== null) {
      rc.addAxisTag({
        price: o.exit,
        text: format.grouped(o.exit),
        style: 'outline',
        color: g.connector.color,
        priority: 21,
      });
    }
  }
}

export function tradesInView(trades: readonly TradeOverlay[], from: number, to: number): TradeOverlay[] {
  return trades.filter((o) => o.open <= to && (o.close ?? Infinity) >= from);
}

export class TradesLayer implements Layer {
  readonly id: string;
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = null;
  readonly owner = null;
  private trades: readonly TradeOverlay[] = [];
  private host: LayerHost | null = null;

  constructor(options: TradeLayerOptions) {
    this.id = options.id;
    this.z = options.z ?? 23;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  setTrades(trades: readonly TradeOverlay[]): void {
    this.trades = trades;
    this.host?.invalidate();
  }

  draw(rc: RenderContext): void {
    const { ctx, dpr, pane, store, time, timeframeMs } = rc;
    const n = store.length;
    if (n === 0 || this.trades.length === 0) return;
    const first = Math.max(0, Math.min(n - 1, Math.floor(time.from)));
    const last = Math.max(0, Math.min(n - 1, Math.ceil(time.to)));
    const shown = tradesInView(this.trades, store.time[first]!, store.time[last]! + timeframeMs);
    if (shown.length === 0) return;
    const map = tradeMapOf(rc);
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    ctx.lineWidth = 1 / dpr;
    for (const o of shown) drawTradeMarks(ctx, tradeGeometry(o, null, map), o.colors);
    ctx.restore();
  }
}
