import { crisp, deOverlap, font, TextMeasurer } from '../render/draw.ts';
import { ORDER_STYLES, type OrderKind } from '../theme.ts';
import type { LabelClaim, Layer, LayerHost, RenderContext } from './types.ts';

export interface OrderLineSpec {
  id: string;
  price: number;
  side: 'buy' | 'sell';
  label: string;
  note?: string | null;
  draft: boolean;
  qty?: number | null;
  pending?: boolean;
  role?: 'entry' | 'stop' | 'target' | 'position';
}

export function orderKindOf(l: OrderLineSpec): OrderKind {
  if (l.role === 'stop') return 'stop';
  if (l.role === 'target') return 'target';
  if (l.role === 'position') return 'position';
  return l.draft ? 'draft' : 'working';
}

export interface OrderLinesLayerOptions {
  id: string;
  lines?: readonly OrderLineSpec[];
  z?: number;
}

const BOX_H = 18;
const TICK_W = 2;
const GAP = 6;
const HIT_PX = 4;

export class OrderLinesLayer implements Layer {
  readonly id: string;
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = null;
  readonly owner = null;
  private lines: OrderLineSpec[];
  private host: LayerHost | null = null;
  private readonly measurer = new TextMeasurer();

  constructor(options: OrderLinesLayerOptions) {
    this.id = options.id;
    this.lines = [...(options.lines ?? [])];
    this.z = options.z ?? 40;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  getLines(): readonly OrderLineSpec[] {
    return this.lines;
  }

  setLines(lines: readonly OrderLineSpec[]): void {
    this.lines = [...lines];
    this.host?.invalidate();
  }

  autoscaleRange(): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of this.lines) {
      if (!l.draft) continue;
      if (l.price < lo) lo = l.price;
      if (l.price > hi) hi = l.price;
    }
    return hi >= lo ? [lo, hi] : null;
  }

  hitTest(_x: number, y: number, rc: RenderContext): { objectId: string; distance: number } | null {
    let best: { objectId: string; distance: number } | null = null;
    for (const l of this.lines) {
      const d = Math.abs(rc.price.yOf(l.price) - y);
      if (d <= HIT_PX && (!best || d < best.distance)) best = { objectId: l.id, distance: d };
    }
    return best;
  }

  labelClaims(rc: RenderContext): readonly LabelClaim[] {
    return this.layoutLabels(rc, this.visibleLines(rc)).map((p) => ({
      y: p.y - BOX_H / 2,
      h: BOX_H,
      edge: 'right' as const,
    }));
  }

  private visibleLines(rc: RenderContext): OrderLineSpec[] {
    const { pane, price } = rc;
    return this.lines.filter((l) => {
      const y = price.yOf(l.price);
      return y >= pane.y && y <= pane.y + pane.h;
    });
  }

  private text(l: OrderLineSpec): string {
    return l.note ? `${l.label} · ${l.note}` : l.label;
  }

  private layoutLabels(
    rc: RenderContext,
    visible: readonly OrderLineSpec[],
  ): { line: OrderLineSpec; x: number; y: number; qtyW: number; w: number }[] {
    const { ctx, theme, pane, price } = rc;
    const qtyFont = font(theme.fontSize + 1, theme.font, 600);
    const textFont = font(theme.fontSize + 1, theme.font, 500);
    const sized = visible.map((l) => {
      const qty = l.qty !== null && l.qty !== undefined ? String(l.qty) : null;
      const qtyW = qty === null ? 0 : this.measurer.measure(ctx, qtyFont, qty) + GAP;
      const w = TICK_W + GAP + qtyW + this.measurer.measure(ctx, textFont, this.text(l));
      return { line: l, qtyW, w };
    });
    const ys = deOverlap(
      sized.map((s) => ({ y: price.yOf(s.line.price) - BOX_H / 2, h: BOX_H, priority: s.line.draft ? 1 : 0 })),
      pane.y,
      pane.y + pane.h,
      2,
    );
    const right = pane.x + pane.w - 10;
    return sized.map((s, k) => ({ ...s, x: Math.max(pane.x + 8, right - s.w), y: ys[k]! + BOX_H / 2 }));
  }

  draw(rc: RenderContext): void {
    const { ctx, theme, dpr, pane, price, format } = rc;
    const visible = this.visibleLines(rc);
    if (visible.length === 0) return;
    const styleOf = (l: OrderLineSpec) => ORDER_STYLES[orderKindOf(l)];

    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    for (const l of visible) {
      const st = styleOf(l);
      const y = crisp(price.yOf(l.price), dpr);
      ctx.strokeStyle = st.line;
      ctx.lineWidth = st.width;
      ctx.setLineDash(l.draft || l.pending ? [5, 3] : [...st.dash]);
      ctx.beginPath();
      ctx.moveTo(pane.x, y);
      ctx.lineTo(pane.x + pane.w, y);
      ctx.stroke();
      rc.addAxisTag({
        price: l.price,
        text: format.grouped(l.price),
        style: l.draft ? 'filled' : 'outline',
        color: st.text,
        priority: l.draft ? 30 : 25,
      });
    }
    ctx.setLineDash([]);

    const qtyFont = font(theme.fontSize + 1, theme.font, 600);
    const textFont = font(theme.fontSize + 1, theme.font, 500);
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const { line: l, x, y, qtyW } of this.layoutLabels(rc, visible)) {
      const st = styleOf(l);
      ctx.fillStyle = st.text;
      ctx.fillRect(Math.round(x), Math.round(y - BOX_H / 2 + 3), TICK_W, BOX_H - 6);
      let tx = x + TICK_W + GAP;
      if (qtyW > 0) {
        ctx.font = qtyFont;
        ctx.lineWidth = 3;
        ctx.strokeStyle = theme.background;
        ctx.strokeText(String(l.qty), tx, y + 0.5);
        ctx.fillStyle = theme.text;
        ctx.fillText(String(l.qty), tx, y + 0.5);
        tx += qtyW;
      }
      ctx.font = textFont;
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.background;
      ctx.strokeText(this.text(l), tx, y + 0.5);
      ctx.fillStyle = st.text;
      ctx.fillText(this.text(l), tx, y + 0.5);
    }
    ctx.restore();
  }
}
