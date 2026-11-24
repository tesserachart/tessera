import { MINUS } from '../format.ts';
import { crisp, deOverlap, font, TextMeasurer } from '../render/draw.ts';
import type { Ctx2D, Layer, LayerHost, RenderContext } from './types.ts';

export interface LevelSpec {
  id: string;
  price: number;
  label: string;
  short?: string;
  vendor?: string | null;
  source?: string | null;
  style?: 'solid' | 'dash' | 'dot';
  dash?: readonly number[];
  color?: string;
  width?: number;
  include?: boolean;
  labelMode?: 'name' | 'short' | 'none';
  distance?: boolean;
}

export interface LevelsLayerOptions {
  id: string;
  provider?: string | null;
  owner?: string | null;
  levels?: readonly LevelSpec[];
  z?: number;
  showVendor?: boolean;
  vendorOnce?: boolean;
  shortTags?: boolean;
  axisTags?: boolean;
}

function signedDistance(d: number, fmt: (abs: number) => string): string {
  const abs = fmt(Math.abs(d));
  if (Number(abs.replace(/[^0-9.]/g, '')) === 0) return abs;
  return `${d < 0 ? MINUS : '+'}${abs}`;
}

const DASH: Record<NonNullable<LevelSpec['style']>, number[]> = { solid: [], dash: [6, 4], dot: [1, 3] };
const LABEL_H = 14;
const HIT_PX = 4;

export class LevelsLayer implements Layer {
  readonly id: string;
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider: string | null;
  readonly owner: string | null;
  readonly settingsSchema = {
    type: 'object',
    properties: {
      showVendor: { type: 'boolean' },
      vendorOnce: { type: 'boolean' },
      shortTags: { type: 'boolean' },
      axisTags: { type: 'boolean' },
    },
  };
  private levels: LevelSpec[];
  private host: LayerHost | null = null;
  private readonly measurer = new TextMeasurer();
  showVendor: boolean;
  vendorOnce: boolean;
  shortTags: boolean;
  axisTags: boolean;

  constructor(options: LevelsLayerOptions) {
    this.id = options.id;
    this.provider = options.provider ?? null;
    this.owner = options.owner ?? null;
    this.levels = [...(options.levels ?? [])];
    this.z = options.z ?? 20;
    this.showVendor = options.showVendor ?? true;
    this.vendorOnce = options.vendorOnce ?? false;
    this.shortTags = options.shortTags ?? true;
    this.axisTags = options.axisTags ?? true;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  getLevels(): readonly LevelSpec[] {
    return this.levels;
  }

  setLevels(levels: readonly LevelSpec[]): void {
    this.levels = [...levels];
    this.host?.invalidate();
  }

  autoscaleRange(): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of this.levels) {
      if (!l.include) continue;
      if (l.price < lo) lo = l.price;
      if (l.price > hi) hi = l.price;
    }
    return hi >= lo ? [lo, hi] : null;
  }

  hitTest(_x: number, y: number, rc: RenderContext): { objectId: string; distance: number } | null {
    let best: { objectId: string; distance: number } | null = null;
    for (const l of this.levels) {
      const d = Math.abs(rc.price.yOf(l.price) - y);
      if (d <= HIT_PX && (!best || d < best.distance)) best = { objectId: l.id, distance: d };
    }
    return best;
  }

  draw(rc: RenderContext): void {
    const { ctx, theme, dpr, pane, price, format } = rc;
    const above: LevelSpec[] = [];
    const below: LevelSpec[] = [];
    const visible: LevelSpec[] = [];
    for (const l of this.levels) {
      const y = price.yOf(l.price);
      if (y < pane.y) above.push(l);
      else if (y > pane.y + pane.h) below.push(l);
      else visible.push(l);
    }

    const right = pane.x + pane.w - 6;
    const n = rc.store.length;
    const last = n > 0 ? rc.store.close[n - 1]! : null;
    const labelFont = font(theme.fontSize, theme.font);
    const chipFont = font(10, theme.font);
    const shortFont = font(10, theme.fontMono, 600);

    for (const l of visible) {
      const y = price.yOf(l.price);
      ctx.save();
      ctx.strokeStyle = l.color ?? theme.text;
      ctx.lineWidth = (l.width ?? 1) / dpr;
      ctx.setLineDash(l.dash ? [...l.dash] : DASH[l.style ?? 'dash']);
      ctx.beginPath();
      const yy = crisp(y, dpr);
      ctx.moveTo(pane.x, yy);
      ctx.lineTo(pane.x + pane.w, yy);
      ctx.stroke();
      ctx.restore();
      if (this.axisTags) {
        rc.addAxisTag({
          price: l.price,
          text: format.grouped(l.price),
          style: 'outline',
          color: l.color ?? theme.text,
          priority: 10,
        });
      }
    }

    const claims = rc.labelClaims.filter((c) => c.edge === 'right');
    const ys = deOverlap(
      [
        ...visible.map((l) => ({ y: price.yOf(l.price) - LABEL_H / 2 - 1, h: LABEL_H, priority: 0 })),
        ...claims.map((c) => ({ y: c.y, h: c.h, priority: 1 })),
      ],
      pane.y,
      pane.y + pane.h,
    ).slice(0, visible.length);
    const chipAt = new Map<string, number>();
    visible.forEach((l, k) => {
      const text = l.vendor ? (l.source ? `${l.vendor} · ${l.source}` : l.vendor) : null;
      if (text === null) return;
      const at = chipAt.get(text);
      if (at === undefined || ys[k]! < ys[at]!) chipAt.set(text, k);
    });
    visible.forEach((l, k) => {
      const cy = ys[k]!;
      let x = right;
      const text = this.showVendor && l.vendor ? (l.source ? `${l.vendor} · ${l.source}` : l.vendor) : null;
      const chip = text !== null && (!this.vendorOnce || chipAt.get(text) === k) ? text : null;
      const chipW = chip ? this.measurer.measure(ctx, chipFont, chip) + 8 : 0;
      if (chip) {
        x -= chipW;
        this.drawChip(ctx, chip, x, cy, chipW, chipFont, theme.mutedText, theme.border, theme.background, dpr);
        x -= 5;
      }
      const dist =
        last === null || l.distance === false ? null : signedDistance(l.price - last, (v) => format.grouped(v));
      const word = l.labelMode === 'none' ? null : l.labelMode === 'short' ? (l.short ?? l.label) : l.label;
      ctx.save();
      ctx.font = labelFont;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.background;
      if (dist !== null) {
        ctx.strokeText(dist, x, cy + 0.5);
        ctx.fillStyle = theme.mutedText;
        ctx.fillText(dist, x, cy + 0.5);
        x -= this.measurer.measure(ctx, labelFont, dist) + 8;
      }
      if (word !== null) {
        ctx.strokeText(word, x, cy + 0.5);
        ctx.fillStyle = theme.dayText;
        ctx.fillText(word, x, cy + 0.5);
      }
      ctx.restore();
      if (this.shortTags && l.short) {
        ctx.save();
        ctx.font = shortFont;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = theme.mutedText;
        ctx.fillText(l.short, pane.x + 6, price.yOf(l.price) - LABEL_H / 2 - 1);
        ctx.restore();
      }
    });

    if (above.length)
      this.drawEdgeChip(
        rc,
        '▲',
        above.sort((a, b) => a.price - b.price),
        pane.y + 4 + LABEL_H / 2,
      );
    if (below.length)
      this.drawEdgeChip(
        rc,
        '▼',
        below.sort((a, b) => b.price - a.price),
        pane.y + pane.h - 4 - LABEL_H / 2,
      );
  }

  private drawChip(
    ctx: Ctx2D,
    text: string,
    x: number,
    cy: number,
    w: number,
    fontSpec: string,
    ink: string,
    border: string,
    ground: string,
    dpr: number,
  ): void {
    const top = Math.round((cy - 7) * dpr) / dpr;
    ctx.save();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1 / dpr;
    ctx.strokeRect(crisp(x, dpr), crisp(top, dpr), w, 13);
    ctx.font = fontSpec;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = ground;
    ctx.strokeText(text, x + 4, top + 7);
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 4, top + 7);
    ctx.restore();
  }

  private drawEdgeChip(rc: RenderContext, arrow: string, levels: LevelSpec[], cy: number): void {
    const { ctx, theme, dpr, pane, format } = rc;
    const nearest = levels[0]!;
    const extra = levels.length > 1 ? ` +${String(levels.length - 1)}` : '';
    const text = `${arrow} ${nearest.short ?? nearest.label} ${format.grouped(nearest.price)}${extra}`;
    const f = font(theme.fontSize, theme.fontMono);
    const w = this.measurer.measure(ctx, f, text) + 10;
    const x = pane.x + pane.w - 6 - w;
    const top = Math.round((cy - LABEL_H / 2) * dpr) / dpr;
    ctx.save();
    ctx.fillStyle = theme.background;
    ctx.fillRect(x, top, w, LABEL_H);
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1 / dpr;
    ctx.strokeRect(crisp(x, dpr), crisp(top, dpr), w, LABEL_H);
    ctx.font = f;
    ctx.fillStyle = theme.mutedText;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, top + LABEL_H / 2 + 0.5);
    ctx.restore();
  }
}
