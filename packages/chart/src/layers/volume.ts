import { formatVolumeShort } from '../format.ts';
import { eachBar, TwoToneRects } from '../render/columns.ts';
import { font, snap } from '../render/draw.ts';
import type { Layer, RenderContext } from './types.ts';

export class VolumeLayer implements Layer {
  readonly id: string;
  readonly kind = 'series' as const;
  readonly surface = 'main' as const;
  readonly pane = 'volume' as const;
  readonly z = 10;
  readonly provider = null;
  private readonly rects = new TwoToneRects();

  constructor(id = 'volume') {
    this.id = id;
  }

  draw(rc: RenderContext): void {
    const { ctx, store, time, dpr, theme, pane } = rc;
    if (time.to < time.from) return;
    const vmax = store.maxVolume(time.from, time.to);
    if (!(vmax > 0)) return;
    const bottom = pane.y + pane.h;
    const usable = pane.h - 4;
    const px = 1 / dpr;
    const spacing = time.barSpacing;
    const w = rc.columns ? px : Math.max(px, snap(spacing * 0.7, dpr));
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    const { add } = this.rects;
    eachBar(
      rc,
      time.to,
      (i) => store.volume[i]!,
      (i, x) => {
        const hgt = Math.max(px, snap((store.volume[i]! / vmax) * usable, dpr));
        add(store.close[i]! >= store.open[i]! ? 0 : 1, x - w / 2, bottom - hgt, w, hgt);
      },
    );
    this.rects.fill(ctx, [theme.upVolume, theme.downVolume], rc.columns ? 'one by one' : 'one path');
    ctx.restore();
    ctx.save();
    ctx.font = font(theme.fontSize, theme.fontMono);
    ctx.fillStyle = theme.mutedText;
    ctx.textBaseline = 'top';
    ctx.fillText(formatVolumeShort(vmax), rc.layout.priceAxis.x + 6, pane.y + 2);
    ctx.restore();
  }
}
