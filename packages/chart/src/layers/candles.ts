import { eachColumnRange, traceSeries, TwoToneRects } from '../render/columns.ts';
import { snap } from '../render/draw.ts';
import type { Layer, RenderContext } from './types.ts';

export type SeriesStyle = 'candles' | 'bars' | 'line' | 'none';

export const CANDLE_BODY_MIN_SPACING = 2.5;
const LINE_WIDTH = 1.5;

export class CandlesLayer implements Layer {
  readonly id: string;
  readonly kind = 'series' as const;
  readonly surface = 'main' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = null;
  style: SeriesStyle = 'candles';
  private readonly rects = new TwoToneRects();

  constructor(id = 'candles', z = 10) {
    this.id = id;
    this.z = z;
  }

  draw(rc: RenderContext): void {
    const { ctx, store, time, price, dpr, theme } = rc;
    if (time.to < time.from || this.style === 'none') return;
    const spacing = time.barSpacing;
    const o = store.open;
    const h = store.high;
    const l = store.low;
    const c = store.close;

    ctx.save();
    ctx.beginPath();
    ctx.rect(rc.pane.x, rc.pane.y, rc.pane.w, rc.pane.h);
    ctx.clip();

    if (this.style === 'line') {
      this.drawLine(rc);
      ctx.restore();
      return;
    }
    if (rc.columns) {
      this.drawAggregated(rc);
      ctx.restore();
      return;
    }

    const px = 1 / dpr;
    const wickW = px;
    let body = Math.max(px, snap(spacing * 0.7, dpr));
    const bodyDev = Math.round(body * dpr);
    if (bodyDev % 2 === 0 && bodyDev > 1) body = (bodyDev - 1) / dpr;
    const drawBodies = spacing >= CANDLE_BODY_MIN_SPACING;
    if (this.style === 'bars') {
      this.drawBars(rc, Math.max(px, snap(Math.min(4, spacing * 0.35), dpr)));
      ctx.restore();
      return;
    }

    for (const up of [true, false]) {
      const fill = up ? theme.upFill : theme.downFill;
      const wick = up ? theme.upWick : theme.downWick;
      const edge = up ? theme.upBorder : theme.downBorder;
      const oneFill = wick === fill && (edge === fill || !drawBodies);
      const edged = drawBodies && edge !== fill && body > 2 * px;
      ctx.beginPath();
      for (let i = time.from; i <= time.to; i++) {
        const oi = o[i]!;
        const ci = c[i]!;
        if (ci >= oi !== up) continue;
        const x = snap(time.xOfIndex(i), dpr);
        const yh = snap(price.yOf(h[i]!), dpr);
        const yl = snap(price.yOf(l[i]!), dpr);
        ctx.rect(x - wickW / 2, yh, wickW, Math.max(px, yl - yh));
        if (drawBodies && oneFill) {
          const [top, bh] = this.bodyOf(rc, oi, ci);
          ctx.rect(x - body / 2, top, body, bh);
        }
      }
      ctx.fillStyle = oneFill ? fill : wick;
      ctx.fill();
      if (oneFill || !drawBodies) continue;
      for (const pass of edged ? ['edge', 'inside'] : ['body']) {
        ctx.beginPath();
        for (let i = time.from; i <= time.to; i++) {
          const oi = o[i]!;
          const ci = c[i]!;
          if (ci >= oi !== up) continue;
          const x = snap(time.xOfIndex(i), dpr);
          const [top, bh] = this.bodyOf(rc, oi, ci);
          if (pass === 'inside') {
            if (bh > 2 * px) ctx.rect(x - body / 2 + px, top + px, body - 2 * px, bh - 2 * px);
          } else ctx.rect(x - body / 2, top, body, bh);
        }
        ctx.fillStyle = pass === 'inside' ? fill : edge;
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private bodyOf(rc: RenderContext, open: number, close: number): [number, number] {
    const { price, dpr } = rc;
    const yo = price.yOf(open);
    const yc = price.yOf(close);
    const top = snap(Math.min(yo, yc), dpr);
    const bh = Math.max(1 / dpr, snap(Math.abs(yc - yo), dpr));
    return [top, bh];
  }

  private drawBars(rc: RenderContext, tick: number): void {
    const { ctx, store, time, price, dpr, theme } = rc;
    const px = 1 / dpr;
    const w = Math.max(px, snap(1.5, dpr));
    for (const up of [true, false]) {
      ctx.beginPath();
      for (let i = time.from; i <= time.to; i++) {
        const oi = store.open[i]!;
        const ci = store.close[i]!;
        if (ci >= oi !== up) continue;
        const x = snap(time.xOfIndex(i), dpr);
        const yh = snap(price.yOf(store.high[i]!), dpr);
        const yl = snap(price.yOf(store.low[i]!), dpr);
        ctx.rect(x - w / 2, yh, w, Math.max(px, yl - yh));
        ctx.rect(x - w / 2 - tick, snap(price.yOf(oi), dpr) - w / 2, tick, w);
        ctx.rect(x + w / 2, snap(price.yOf(ci), dpr) - w / 2, tick, w);
      }
      ctx.fillStyle = up ? theme.upBar : theme.downBar;
      ctx.fill();
    }
  }

  private drawLine(rc: RenderContext): void {
    const { ctx, store, time, price, theme } = rc;
    ctx.beginPath();
    traceSeries(
      rc,
      time.to,
      (i) => store.close[i]!,
      null,
      (i, v, start) => {
        const x = time.xOfIndex(i);
        const y = price.yOf(v);
        if (start) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      },
      LINE_WIDTH,
    );
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.lineSeries;
    ctx.stroke();
  }

  private drawAggregated(rc: RenderContext): void {
    const { ctx, store, time, price, dpr, theme } = rc;
    const columns = rc.columns!;
    const px = 1 / dpr;
    const { add } = this.rects;
    eachColumnRange(columns, time.to, store.low, store.high, null, (r) => {
      const top = snap(price.yOf(r.hi), dpr);
      add(
        store.close[r.last]! >= store.open[r.first]! ? 0 : 1,
        r.left,
        top,
        px,
        Math.max(px, snap(price.yOf(r.lo), dpr) - top),
      );
    });
    this.rects.fill(ctx, [theme.upFill, theme.downFill], 'one by one');
  }
}
