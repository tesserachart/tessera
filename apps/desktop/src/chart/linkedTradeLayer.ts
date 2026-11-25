import type { Layer, LayerHost, RenderContext } from '@tessera/chart';
import type { BacktestTrade } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';

export interface LinkedTradeColors {
  entry: string;
  up: string;
  down: string;
  label: string;
}

interface Mark {
  x: number;
  y: number;
  side: 'buy' | 'sell';
}

export interface LinkedTradeGeometry {
  left: number;
  right: number;
  entry: Mark;
  exit: Mark;
  stop: number | null;
  target: number | null;
}

export interface LinkedTradeMap {
  xOfTime: (ms: number) => number;
  yOf: (price: number) => number;
  barSpacing: number;
}

const ZONE_ALPHA = 0.16;
const MARK = 6;
const LABEL_GAP = 8;
const nsToMs = (ns: number) => Math.round(ns / 1e6);

export const EXIT_WORD: Record<BacktestTrade['exit'], string> = {
  signal: 'Signal',
  stop: 'Stop',
  target: 'Target',
  end_of_data: 'End of data',
};

export function linkedTradeGeometry(t: BacktestTrade, map: LinkedTradeMap): LinkedTradeGeometry | null {
  const left = map.xOfTime(nsToMs(t.entryTime));
  const exitAt = map.xOfTime(nsToMs(t.exitTime));
  if (!Number.isFinite(left) || !Number.isFinite(exitAt)) return null;
  const insideExitBar = t.exit === 'stop' || t.exit === 'target';
  const right = Math.max(insideExitBar ? exitAt + map.barSpacing : exitAt, left + map.barSpacing);
  const long = t.qty > 0;
  return {
    left,
    right,
    entry: { x: left, y: map.yOf(t.entryPrice), side: long ? 'buy' : 'sell' },
    exit: { x: right, y: map.yOf(t.exitPrice), side: long ? 'sell' : 'buy' },
    stop: t.stop === null ? null : map.yOf(t.stop),
    target: t.target === null ? null : map.yOf(t.target),
  };
}

function triangle(ctx: RenderContext['ctx'], m: Mark, color: string): void {
  const dir = m.side === 'buy' ? 1 : -1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(m.x, m.y);
  ctx.lineTo(m.x - MARK * 0.7, m.y + dir * MARK * 1.2);
  ctx.lineTo(m.x + MARK * 0.7, m.y + dir * MARK * 1.2);
  ctx.closePath();
  ctx.fill();
}

const LABEL_PAD = 4;
const LABEL_H = 16;

function label(
  ctx: RenderContext['ctx'],
  text: string,
  x: number,
  y: number,
  align: 'left' | 'right',
  colors: { text: string; ground: string },
): void {
  const w = ctx.measureText(text).width + 2 * LABEL_PAD;
  const left = align === 'left' ? x - LABEL_PAD : x - w + LABEL_PAD;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = colors.ground;
  ctx.fillRect(left, y - LABEL_H / 2, w, LABEL_H);
  ctx.globalAlpha = 1;
  ctx.textAlign = align;
  ctx.fillStyle = colors.text;
  ctx.fillText(text, x, y);
}

export class LinkedTradeLayer implements Layer {
  readonly id: string;
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z = 24;
  private trade: BacktestTrade | null = null;
  private colors: LinkedTradeColors | null = null;
  private host: LayerHost | null = null;

  constructor(id: string) {
    this.id = id;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  set(trade: BacktestTrade | null, colors: LinkedTradeColors): void {
    this.trade = trade;
    this.colors = colors;
    this.host?.invalidate();
  }

  autoscaleRange(): [number, number] | null {
    const t = this.trade;
    if (!t) return null;
    const prices = [t.entryPrice, t.exitPrice, t.stop, t.target].filter(
      (p): p is number => p !== null && Number.isFinite(p),
    );
    return [Math.min(...prices), Math.max(...prices)];
  }

  draw(rc: RenderContext): void {
    const t = this.trade;
    const c = this.colors;
    if (!t || !c || rc.store.length === 0) return;
    const g = linkedTradeGeometry(t, {
      xOfTime: (ms) => rc.time.xOfTime(ms),
      yOf: (p) => rc.price.yOf(p),
      barSpacing: rc.time.barSpacing,
    });
    if (!g) return;
    const { ctx, pane, dpr, theme, format } = rc;
    const w = g.right - g.left;
    const result = t.pnl > 0 ? c.up : t.pnl < 0 ? c.down : c.entry;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    for (const [y, color] of [
      [g.target, c.up],
      [g.stop, c.down],
    ] as const) {
      if (y === null) continue;
      ctx.globalAlpha = ZONE_ALPHA;
      ctx.fillStyle = color;
      ctx.fillRect(g.left, Math.min(y, g.entry.y), w, Math.abs(y - g.entry.y));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(g.left, Math.round(y * dpr) / dpr + 0.5 / dpr);
      ctx.lineTo(g.right, Math.round(y * dpr) / dpr + 0.5 / dpr);
      ctx.stroke();
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = c.entry;
    ctx.beginPath();
    ctx.moveTo(g.left, g.entry.y);
    ctx.lineTo(g.right, g.entry.y);
    ctx.stroke();
    ctx.strokeStyle = result;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(g.entry.x, g.entry.y);
    ctx.lineTo(g.exit.x, g.exit.y);
    ctx.stroke();
    ctx.setLineDash([]);
    triangle(ctx, g.entry, g.entry.side === 'buy' ? c.up : c.down);
    triangle(ctx, g.exit, g.exit.side === 'buy' ? c.up : c.down);
    ctx.font = `500 11px ${theme.font}`;
    ctx.textBaseline = 'middle';
    label(ctx, `${t.qty > 0 ? 'Long' : 'Short'} ${String(Math.abs(t.qty))}`, g.left - LABEL_GAP, g.entry.y, 'right', {
      text: c.label,
      ground: theme.background,
    });
    label(ctx, `${EXIT_WORD[t.exit]} ${formatMoney(t.pnl, { signed: true })}`, g.right + LABEL_GAP, g.exit.y, 'left', {
      text: result,
      ground: theme.background,
    });
    ctx.restore();
    const tags: [number | null, string, 'filled' | 'outline', boolean][] = [
      [t.target, c.up, 'outline', true],
      [t.stop, c.down, 'outline', true],
      [t.entryPrice, c.entry, 'outline', false],
      [t.exitPrice, result, 'filled', false],
    ];
    for (const [price, color, style, dashed] of tags) {
      if (price === null) continue;
      rc.addAxisTag({ price, text: format.grouped(price), style, color, priority: 22, dashed });
    }
  }
}
