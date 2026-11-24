import { crisp, isClear } from '../render/draw.ts';
import type { Layer, RenderContext } from './types.ts';

export class GridLayer implements Layer {
  readonly id = 'grid';
  readonly kind = 'interaction' as const;
  readonly surface = 'main' as const;
  readonly z = -100;
  readonly provider = null;
  ticks: readonly number[] = [];
  timeTicks: readonly number[] = [];

  draw(rc: RenderContext): void {
    const { ctx, dpr, theme, layout, time, session } = rc;
    const main = layout.main;
    ctx.save();
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    for (const p of this.ticks) {
      const y = crisp(rc.mainPrice.yOf(p), dpr);
      if (y < main.y || y > main.y + main.h) continue;
      ctx.moveTo(main.x, y);
      ctx.lineTo(main.x + main.w, y);
    }
    ctx.stroke();

    if (this.timeTicks.length > 0 && !isClear(theme.gridVertical)) {
      ctx.strokeStyle = theme.gridVertical;
      ctx.beginPath();
      const bottom = layout.timeAxis.y;
      for (const i of this.timeTicks) {
        const x = crisp(time.xOfIndex(i), dpr);
        if (x < main.x || x > main.x + main.w) continue;
        ctx.moveTo(x, main.y);
        ctx.lineTo(x, bottom);
      }
      ctx.stroke();
    }

    if (time.to >= time.from && time.barSpacing * dpr >= 0.75) {
      ctx.strokeStyle = theme.sessionSeparator;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      const bottom = layout.timeAxis.y;
      let lastX = -Infinity;
      for (let i = Math.max(1, time.from); i <= time.to; i++) {
        if (session.brk[i] !== 1) continue;
        const x = crisp(time.xOfIndex(i) - time.barSpacing / 2, dpr);
        if (x - lastX < 4) continue;
        lastX = x;
        ctx.moveTo(x, main.y);
        ctx.lineTo(x, bottom);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
