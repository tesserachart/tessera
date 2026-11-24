import { crosshairTimeLabel, formatCountdown, formatVolumeShort } from '../format.ts';
import { crisp, font, snap, TextMeasurer } from '../render/draw.ts';
import type { Layer, RenderContext } from './types.ts';

export class LastPriceLayer implements Layer {
  readonly id = 'last-price';
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z = 30;
  readonly provider = null;
  countdown = true;
  stale = false;

  isLive(rc: Pick<RenderContext, 'store' | 'timeframeMs' | 'now'>): boolean {
    const n = rc.store.length;
    if (n === 0 || !this.countdown || this.stale) return false;
    const end = rc.store.time[n - 1]! + rc.timeframeMs;
    return rc.now < end && rc.now > end - 2 * rc.timeframeMs;
  }

  draw(rc: RenderContext): void {
    const { ctx, store, price, pane, dpr, theme, format } = rc;
    const n = store.length;
    if (n === 0) return;
    const c = store.close[n - 1]!;
    const up = c >= store.open[n - 1]!;
    const color = this.stale ? theme.mutedText : (theme.lastPrice ?? (up ? theme.upFill : theme.downFill));
    const y = price.yOf(c);
    if (y >= pane.y && y <= pane.y + pane.h) {
      ctx.save();
      ctx.strokeStyle = this.stale ? color : (theme.lastPriceLine ?? color);
      ctx.lineWidth = 1 / dpr;
      ctx.setLineDash([1, 2]);
      ctx.beginPath();
      ctx.moveTo(pane.x, crisp(y, dpr));
      ctx.lineTo(pane.x + pane.w, crisp(y, dpr));
      ctx.stroke();
      ctx.restore();
    }
    const sub = this.isLive(rc) ? formatCountdown(store.time[n - 1]! + rc.timeframeMs - rc.now) : undefined;
    rc.addAxisTag({
      price: c,
      text: format.grouped(c),
      ...(sub ? { sub } : {}),
      style: this.stale ? 'neutral' : 'filled',
      ...(this.stale ? { dashed: true } : {}),
      color,
      priority: 100,
    });
  }
}

export class CrosshairLayer implements Layer {
  readonly id = 'crosshair';
  readonly kind = 'interaction' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z = 1000;
  readonly provider = null;
  private readonly measurer = new TextMeasurer();

  draw(rc: RenderContext): void {
    const ch = rc.crosshair;
    if (!ch) return;
    const { ctx, dpr, theme, layout, time, store, format, session } = rc;
    const bottom = layout.timeAxis.y;
    const hasBar = ch.index >= 0 && ch.index < store.length;
    const x = hasBar ? time.xOfIndex(ch.index) : ch.x;
    ctx.save();
    ctx.strokeStyle = theme.crosshair;
    ctx.lineWidth = 1 / dpr;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(crisp(x, dpr), layout.main.y);
    ctx.lineTo(crisp(x, dpr), bottom);
    const paneRect = layout.panes.find((p) => p.id === ch.pane)?.rect ?? layout.main;
    ctx.moveTo(paneRect.x, crisp(ch.y, dpr));
    ctx.lineTo(paneRect.x + paneRect.w, crisp(ch.y, dpr));
    ctx.stroke();
    ctx.restore();

    if (ch.pane === 'main') {
      rc.addAxisTag({
        price: ch.price,
        text: format.grouped(format.round(ch.price)),
        style: 'filled',
        color: theme.tagBackground,
        priority: 200,
        transient: true,
      });
    } else if (ch.pane !== 'volume' && Number.isFinite(ch.value)) {
      rc.addAxisTag({
        price: ch.value,
        text: rc.formatPaneValue(ch.pane, ch.value),
        style: 'filled',
        color: theme.tagBackground,
        priority: 200,
        transient: true,
        pane: ch.pane,
      });
    }
    if (hasBar) {
      const label = crosshairTimeLabel(session.clock, store.time[ch.index]!, rc.timeframeMs);
      const f = font(theme.fontSize, theme.fontMono);
      const w = this.measurer.measure(ctx, f, label) + 12;
      const ta = layout.timeAxis;
      const left = Math.min(ta.x + ta.w - w, Math.max(ta.x, snap(x - w / 2, dpr)));
      ctx.save();
      ctx.fillStyle = theme.tagBackground;
      ctx.fillRect(left, ta.y + 1, w, ta.h - 2);
      ctx.font = f;
      ctx.fillStyle = theme.text;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, left + 6, ta.y + ta.h / 2 + 0.5);
      ctx.restore();
    }
  }
}

interface LegendPart {
  text: string;
  color: string;
  font: string;
  gap: number;
}

export interface LegendItem {
  text: string;
  color?: string;
  weight?: 400 | 500;
  gap?: number;
  keepWithNext?: boolean;
}

const LEGEND_BACKING_ALPHA = 0.8;

const LEGEND_FIRST_ROW = 16;
const LEGEND_HALF_ROW = 11;
const LEGEND_ROW_STEP = 19;

export const LEGEND_INSET = LEGEND_FIRST_ROW + LEGEND_ROW_STEP + LEGEND_HALF_ROW;

export class LegendLayer implements Layer {
  readonly id = 'legend';
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z = 900;
  readonly provider = null;
  title: string;
  subtitle: string | null;
  hoverOnly: boolean;
  extra: ((index: number) => readonly LegendItem[]) | null = null;
  reserved = 0;
  extent: { x: number; y: number; w: number; h: number } | null = null;
  private readonly measurer = new TextMeasurer();

  constructor(title = '', subtitle: string | null = null, hoverOnly = false) {
    this.title = title;
    this.subtitle = subtitle;
    this.hoverOnly = hoverOnly;
  }

  height(): number {
    const rows = (this.extra ? 1 : 0) + (this.subtitle ? 1 : 0);
    return LEGEND_FIRST_ROW + LEGEND_HALF_ROW + Math.max(0, this.reserved) + rows * LEGEND_ROW_STEP;
  }

  draw(rc: RenderContext): void {
    const { ctx, store, theme, layout, format, crosshair } = rc;
    this.extent = null;
    if (this.hoverOnly && !crosshair) return;
    const n = store.length;
    if (n === 0 && !this.title) return;
    const i = crosshair && crosshair.index >= 0 && crosshair.index < n ? crosshair.index : n - 1;
    const left = layout.main.x + 14;
    const room = layout.main.w - 28;
    const y = layout.main.y + LEGEND_FIRST_ROW;
    const size = theme.fontSize + 1;
    const regular = font(size, theme.font);
    const medium = font(size, theme.font, 500);
    const part = (text: string, color: string, f: string, gap: number): LegendPart => ({ text, color, font: f, gap });
    const title = this.title ? [part(this.title, theme.text, medium, 12)] : [];
    let rows: LegendPart[][] = [title];
    if (i >= 0) {
      const o = store.open[i]!;
      const c = store.close[i]!;
      const tone = c > o ? theme.upText : c < o ? theme.downText : theme.text;
      const value = (k: string, v: string, color: string) => [
        part(k, theme.labelText, regular, 4),
        part(v, color, regular, 9),
      ];
      const [O, H, L, C] = (
        [
          ['O', o],
          ['H', store.high[i]!],
          ['L', store.low[i]!],
          ['C', c],
        ] as const
      ).map(([k, v]) => value(k, format.grouped(v), tone));
      const V = value('Vol', formatVolumeShort(store.volume[i]!), theme.text);
      rows = [
        [...title, ...O!, ...H!, ...L!, ...C!, ...V],
        [...title, ...O!, ...H!, ...L!, ...C!],
        [...title, ...H!, ...L!, ...C!],
        [...title, ...C!],
        [...C!],
      ];
    }
    const width = (row: readonly LegendPart[]) =>
      row.reduce((w, p, k) => w + this.measurer.measure(ctx, p.font, p.text) + (k < row.length - 1 ? p.gap : 0), 0);
    const row = rows.find((r) => width(r) <= room) ?? [];
    let second: LegendPart[] = [];
    if (this.extra && i >= 0) {
      const items = [...this.extra(i)];
      const fits = () =>
        width(items.map((it) => part(it.text, '', it.weight === 500 ? medium : regular, it.gap ?? 8))) <= room;
      while (items.length > 0 && (!fits() || items.at(-1)!.keepWithNext)) items.pop();
      second = items.map((it) =>
        part(it.text, it.color ?? theme.labelText, it.weight === 500 ? medium : regular, it.gap ?? 8),
      );
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.main.x, layout.main.y, layout.main.w, layout.main.h);
    ctx.clip();
    ctx.textBaseline = 'middle';
    const drawRow = (parts: readonly LegendPart[], at: number) => {
      let x = left;
      for (const p of parts) {
        ctx.font = p.font;
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, x, at);
        x += this.measurer.measure(ctx, p.font, p.text) + p.gap;
      }
    };
    const backing = (w: number, top: number, bottom: number) => {
      ctx.globalAlpha = LEGEND_BACKING_ALPHA;
      ctx.fillStyle = theme.background;
      ctx.fillRect(left - 5, Math.round(top), Math.ceil(w) + 10, Math.round(bottom) - Math.round(top));
      ctx.globalAlpha = 1;
    };
    const firstBottom = y + LEGEND_HALF_ROW;
    backing(width(row), y - LEGEND_HALF_ROW, firstBottom);
    drawRow(row, y);
    let right = left + width(row);
    let bottom = y + LEGEND_HALF_ROW + Math.max(0, this.reserved);
    const below = y + LEGEND_ROW_STEP + Math.max(0, this.reserved);
    if (second.length > 0) {
      backing(width(second), Math.max(below - LEGEND_HALF_ROW, firstBottom), below + LEGEND_HALF_ROW);
      drawRow(second, below);
      right = Math.max(right, left + width(second));
      bottom = below + LEGEND_HALF_ROW;
    }
    if (this.subtitle) {
      const sub = this.subtitle;
      const f = font(theme.fontSize, theme.font);
      const w = this.measurer.measure(ctx, f, sub);
      if (w <= room) {
        const at = below + (second.length > 0 ? LEGEND_ROW_STEP : 0);
        backing(w, second.length > 0 ? below + LEGEND_HALF_ROW : at - LEGEND_HALF_ROW, at + LEGEND_HALF_ROW);
        ctx.font = f;
        ctx.fillStyle = theme.mutedText;
        ctx.fillText(sub, left, at);
        right = Math.max(right, left + w);
        bottom = at + LEGEND_HALF_ROW;
      }
    }
    ctx.restore();
    const top = layout.main.y;
    this.extent = {
      x: left - 5,
      y: top,
      w: Math.ceil(right - left) + 10,
      h: Math.min(bottom, layout.main.y + layout.main.h) - top,
    };
  }
}
