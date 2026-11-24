import type { ChartApi, Layer, LayerHost, RenderContext } from '@tessera/chart';

export class TimeMarkLayer implements Layer {
  readonly id = 'time-mark';
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly z = 45;
  private mark: { t: number; price: number } | null = null;
  private host: LayerHost | null = null;
  private xOf: ((ms: number) => number) | null = null;
  private plot: { x: number; w: number } | null = null;

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  set(mark: { t: number; price: number } | null): void {
    this.mark = mark;
    this.host?.invalidate();
  }

  get current(): { t: number; price: number } | null {
    return this.mark;
  }

  reveal(chart: ChartApi): boolean {
    const m = this.mark;
    if (!m || !this.xOf || !this.plot) return false;
    const x = this.xOf(m.t);
    if (!Number.isFinite(x)) return false;
    const { x: left, w } = this.plot;
    if (x >= left + 8 && x <= left + w - 8) return false;
    const vp = chart.getViewport();
    if (!(vp.barSpacing > 0)) return false;
    chart.setViewport({ rightEdgeSlot: vp.rightEdgeSlot + (x - (left + w * 0.6)) / vp.barSpacing });
    return true;
  }

  draw(rc: RenderContext): void {
    this.xOf = (ms) => rc.time.xOfTime(ms);
    this.plot = { x: rc.pane.x, w: rc.pane.w };
    const m = this.mark;
    if (!m) return;
    const x = rc.time.xOfTime(m.t);
    const { ctx, pane, dpr } = rc;
    if (!Number.isFinite(x) || x < pane.x || x > pane.x + pane.w) return;
    const px = Math.round(x * dpr) / dpr + 0.5 / dpr;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    ctx.strokeStyle = rc.theme.text;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1 / dpr;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, pane.y);
    ctx.lineTo(px, pane.y + pane.h);
    ctx.stroke();
    ctx.setLineDash([]);
    const y = rc.price.yOf(m.price);
    if (Number.isFinite(y) && y >= pane.y && y <= pane.y + pane.h) {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = rc.theme.background;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}
