import type { FootprintStore, FootprintView } from '../flow/footprintStore.ts';
import { stackedZones, withForming, type ImbalanceOptions, type Zone, type ZoneBars } from '../flow/imbalance.ts';
import type { TickGrid } from '../flow/ticks.ts';
import { snap } from '../render/draw.ts';
import { ORDERFLOW_STYLE, rgba } from '../theme.ts';
import type { RenderContext } from './types.ts';

const ZONE_LOOKBACK_BARS = 1000;
const ZONE_SCAN_BLOCK = 250;

export class ZoneFinder {
  private closed: { key: string; zones: Zone[] } | null = null;
  private all: { key: string; zones: Zone[] } | null = null;

  reset(): void {
    this.all = null;
  }

  inView(store: FootprintStore, rc: RenderContext, o: ImbalanceOptions, rowTicks: number): Zone[] {
    const { time } = rc;
    const n = rc.store.length;
    if (n === 0) return [];
    const from = Math.floor(Math.max(0, time.from - ZONE_LOOKBACK_BARS) / ZONE_SCAN_BLOCK) * ZONE_SCAN_BLOCK;
    const grid = store.grid;
    const views = new Map<number, FootprintView | null>();
    const day = rc.session.day;
    const bars = (length: number): ZoneBars => ({
      length,
      view: (i) => {
        let v = views.get(i);
        if (v === undefined) {
          const b = store.get(rc.store.time[i]!);
          v = b && b.rows > 0 ? store.view(b, Math.max(b.baseTicks, rowTicks)) : null;
          views.set(i, v);
        }
        return v;
      },
      lowTick: (i) => grid.toTick(rc.store.low[i]!),
      highTick: (i) => grid.toTick(rc.store.high[i]!),
      session: (i) => day[i] ?? 0,
    });
    const newest = store.length > 0 ? store.at(store.length - 1)!.t : null;
    const lastIsNewest = newest === rc.store.time[n - 1];
    const settled = lastIsNewest ? String(store.settledVersion) : `v${String(store.version)}`;
    const opts = [rowTicks, o.ratio, o.minVolume, o.minDifference, o.includeZero, o.stackRows].join('|');
    const closedKey = `${settled}|${String(store.generation)}|${opts}|${String(n)}|${String(from)}`;
    if (this.closed?.key !== closedKey)
      this.closed = { key: closedKey, zones: stackedZones(bars(n - 1), from, n - 2, o) };
    const lastKey = `${closedKey}|${String(store.version)}|${String(rc.store.low[n - 1])}|${String(rc.store.high[n - 1])}`;
    if (this.all?.key !== lastKey)
      this.all = { key: lastKey, zones: withForming(this.closed.zones, bars(n), n - 1, o) };
    return this.all.zones.filter((z) => z.from <= time.to && (z.open || z.to >= time.from));
  }
}

export function paintZones(rc: RenderContext, grid: TickGrid, zones: readonly Zone[]): void {
  if (zones.length === 0) return;
  const { ctx, time, dpr, mainPrice, pane, theme } = rc;
  const px = 1 / dpr;
  const g = ctx.globalAlpha;
  for (const side of ['buy', 'sell'] as const) {
    const fills: number[] = [];
    const edges: number[] = [];
    for (const z of zones) {
      if (z.side !== side) continue;
      const x0 = time.xOfIndex(z.from) + time.barSpacing / 2;
      const x1 = time.xOfIndex(z.to) + (z.open ? 1 : -1) * (time.barSpacing / 2);
      if (x1 <= x0 || x1 < pane.x || x0 > pane.x + pane.w) continue;
      const y0 = snap(mainPrice.yOf(grid.toPrice(z.highTick) - grid.tick / 2), dpr);
      const y1 = snap(mainPrice.yOf(grid.toPrice(z.lowTick) - grid.tick / 2), dpr);
      fills.push(x0, y0, x1 - x0, y1 - y0);
      edges.push(x0, y0, x1 - x0, px, x0, y1 - px, x1 - x0, px);
    }
    const rgb = side === 'buy' ? theme.flow.ask : theme.flow.bid;
    fillRects(rc, fills, rgba(rgb, ORDERFLOW_STYLE.zoneFill * g));
    fillRects(rc, edges, rgba(rgb, ORDERFLOW_STYLE.zoneEdge * g));
  }
}

function fillRects(rc: RenderContext, r: readonly number[], color: string): void {
  if (r.length === 0) return;
  const { ctx } = rc;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let k = 0; k < r.length; k += 4) ctx.rect(r[k]!, r[k + 1]!, r[k + 2]!, r[k + 3]!);
  ctx.fill();
}
