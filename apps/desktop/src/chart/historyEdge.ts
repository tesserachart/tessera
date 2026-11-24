import type { Layer, LayerHost, RenderContext } from '@tessera/chart';

const GAP = 6;
const BASELINE = 8;

export class HistoryEdgeLayer implements Layer {
  readonly id = 'history-edge';
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly z = 44;
  private why: string | null = null;
  private inView = false;
  private host: LayerHost | null = null;

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  set(why: string | null, inView = false): void {
    if (why === this.why && inView === this.inView) return;
    this.why = why;
    this.inView = inView;
    this.host?.invalidate();
  }

  get current(): string | null {
    return this.why;
  }

  draw(rc: RenderContext): void {
    const why = this.why;
    if (!why || rc.store.length === 0) return;
    const { ctx, pane, dpr, theme } = rc;
    const half = rc.time.barSpacing / 2;
    const first = rc.time.xOfIndex(0);
    const edgeShown = Number.isFinite(first) && first + half >= pane.x && first - half <= pane.x + pane.w;
    if (!edgeShown) {
      if (this.inView) this.drawNote(rc, why);
      return;
    }
    const x = Math.max(pane.x, first - half);
    const px = Math.round(x * dpr) / dpr + 0.5 / dpr;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    ctx.strokeStyle = theme.mutedText;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1 / dpr;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(px, pane.y);
    ctx.lineTo(px, pane.y + pane.h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = `${String(theme.fontSize)}px ${theme.font}`;
    ctx.fillStyle = theme.mutedText;
    ctx.textBaseline = 'alphabetic';
    const room = px - pane.x - GAP * 2;
    const before = ctx.measureText(why).width <= room;
    ctx.textAlign = before ? 'right' : 'left';
    ctx.fillText(why, before ? px - GAP : px + GAP, pane.y + pane.h - BASELINE);
    ctx.restore();
  }

  private drawNote(rc: RenderContext, why: string): void {
    const { ctx, pane, theme } = rc;
    ctx.save();
    ctx.font = `${String(theme.fontSize)}px ${theme.font}`;
    ctx.fillStyle = theme.mutedText;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(why, pane.x + GAP, pane.y + pane.h - BASELINE);
    ctx.restore();
  }
}
