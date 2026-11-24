import { crisp } from '../render/draw.ts';
import { LEGEND_INSET } from './overlays.ts';
import type { LabelClaim, Layer, LayerHost, RenderContext } from './types.ts';

export interface BracketLine {
  id: string;
  price: number;
  since: number | null;
  color: string;
  dash: readonly number[];
  width: number;
}

export interface BracketZone {
  id: string;
  from: number;
  to: number;
  since: number | null;
  fill: string;
}

export interface OrderTagSpec {
  id: string;
  price: number;
  priority: number;
  fanned?: boolean;
}

export const ORDER_TAG_H = 22;
export const ORDER_TAG_GAP = 2;

export function orderTagRows(
  tags: readonly OrderTagSpec[],
  yOf: (price: number) => number,
  plot: { y: number; h: number },
): number[] {
  const foot = plot.y + plot.h;
  const above = Math.min(foot - ORDER_TAG_H / 2, plot.y + LEGEND_INSET + ORDER_TAG_H / 2);
  const below = Math.max(plot.y + ORDER_TAG_H / 2, foot - ORDER_TAG_H / 2 - 2);
  return tags.map((tag) => {
    const y = yOf(tag.price);
    return y < plot.y ? above : y > foot ? below : y;
  });
}

export const ORDER_TAG_LANE_GAP = 12;
export const ORDER_TAG_MIN_W = 96;
export const ORDER_TAG_MORE_W = 80;
const TAG_INSET = 6;

export interface SizedOrderTag extends OrderTagSpec {
  width: number;
  packPrice?: number;
  floating?: boolean;
}

export interface OrderTagPlacement {
  index: number;
  y: number;
  priceY: number;
  right: number;
  width: number;
  lane: number;
  clipped: boolean;
  overflow: boolean;
}

export function layoutOrderTags(
  tags: readonly SizedOrderTag[],
  yOf: (price: number) => number,
  plot: { x: number; y: number; w: number; h: number },
): OrderTagPlacement[] {
  const rows = orderTagRows(tags, yOf, plot);
  const packRows = orderTagRows(
    tags.map((tag) => ({ ...tag, price: tag.packPrice ?? tag.price })),
    yOf,
    plot,
  );
  const lanes: { indices: number[]; width: number }[] = [];
  const laneOf: number[] = [];
  const main = tags.some((tag) => !tag.fanned && !tag.floating);
  const ranked = tags
    .map((tag, index) => ({ tag, index }))
    .filter(({ tag }) => !tag.floating)
    .sort(
      (a, b) => Number(!!a.tag.fanned) - Number(!!b.tag.fanned) || b.tag.priority - a.tag.priority || a.index - b.index,
    );
  for (const { tag, index } of ranked) {
    let lane = tag.fanned && main ? 1 : 0;
    while (
      lanes[lane]?.indices.some((other) => Math.abs(packRows[other]! - packRows[index]!) < ORDER_TAG_H + ORDER_TAG_GAP)
    )
      lane++;
    lanes[lane] ??= { indices: [], width: 0 };
    lanes[lane]!.indices.push(index);
    lanes[lane]!.width = Math.max(lanes[lane]!.width, Math.max(1, tag.width));
    laneOf[index] = lane;
  }

  const available = Math.max(0, plot.w - TAG_INSET * 2);
  const minimum = lanes.map((lane) => Math.min(lane.width, ORDER_TAG_MIN_W));
  const minimumSpan = minimum.reduce((sum, width) => sum + width, 0) + (lanes.length - 1) * ORDER_TAG_LANE_GAP;
  let keep = lanes.length;
  let room = available;
  if (minimumSpan > available) {
    room = Math.max(0, available - Math.min(ORDER_TAG_MORE_W, available) - ORDER_TAG_LANE_GAP);
    keep = 0;
    let used = 0;
    for (const width of minimum) {
      const next = used + (keep > 0 ? ORDER_TAG_LANE_GAP : 0) + width;
      if (next > room) break;
      used = next;
      keep++;
    }
  }
  const kept = lanes.slice(0, keep);
  const gaps = Math.max(0, keep - 1) * ORDER_TAG_LANE_GAP;
  const base = minimum.slice(0, keep).reduce((sum, width) => sum + width, 0);
  const natural = kept.reduce((sum, lane) => sum + lane.width, 0);
  const ratio = natural > base ? Math.max(0, Math.min(1, (room - gaps - base) / (natural - base))) : 1;
  const widths = kept.map((lane, index) => minimum[index]! + (lane.width - minimum[index]!) * ratio);
  const rights: number[] = [];
  let right = plot.x + plot.w - TAG_INSET;
  for (const width of widths) {
    rights.push(right);
    right -= width + ORDER_TAG_LANE_GAP;
  }
  const taken = lanes.slice(0, keep).map((lane) => lane.indices.map((i) => rows[i]!));
  const floatLane: number[] = [];
  tags.forEach((tag, index) => {
    if (!tag.floating) return;
    let lane = 0;
    while (lane < keep && taken[lane]!.some((y) => Math.abs(y - rows[index]!) < ORDER_TAG_H + ORDER_TAG_GAP)) lane++;
    if (lane < keep) taken[lane]!.push(rows[index]!);
    floatLane[index] = lane < keep ? lane : 0;
  });
  return tags.map((tag, index) => {
    const natural = Math.max(1, tag.width);
    if (tag.floating) {
      const lane = floatLane[index]!;
      const right = rights[lane] ?? plot.x + plot.w - TAG_INSET;
      const width = Math.max(0, Math.min(natural, right - plot.x - TAG_INSET));
      return {
        index,
        y: rows[index]!,
        priceY: yOf(tag.price),
        right,
        width,
        lane,
        clipped: width + 0.5 < natural,
        overflow: false,
      };
    }
    const lane = laneOf[index]!;
    const overflow = lane >= keep;
    const width = overflow ? 0 : Math.min(natural, widths[lane]!);
    return {
      index,
      y: rows[index]!,
      priceY: yOf(tag.price),
      right: rights[lane] ?? plot.x + TAG_INSET,
      width,
      lane,
      clipped: !overflow && width + 0.5 < natural,
      overflow,
    };
  });
}

export interface OrderScene {
  lines: readonly BracketLine[];
  zones: readonly BracketZone[];
  tags: readonly OrderTagSpec[];
}

export interface BracketsLayerOptions {
  id: string;
  z?: number;
}

export const OFFSCREEN_SPAN = 160;

export class BracketsLayer implements Layer {
  readonly id: string;
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = null;
  readonly owner = null;
  private scene: OrderScene = { lines: [], zones: [], tags: [] };
  private guide: { price: number; color: string } | null = null;
  private axis: readonly { price: number; color: string }[] = [];
  private host: LayerHost | null = null;

  constructor(options: BracketsLayerOptions) {
    this.id = options.id;
    this.z = options.z ?? 40;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  getScene(): OrderScene {
    return this.scene;
  }

  setScene(scene: OrderScene): void {
    this.scene = scene;
    this.host?.invalidate();
  }

  setGuide(guide: { price: number; color: string } | null): void {
    this.guide = guide;
    this.host?.invalidate();
  }

  setAxisPrices(axis: readonly { price: number; color: string }[]): void {
    this.axis = axis;
    this.host?.invalidate();
  }

  startX(rc: Pick<RenderContext, 'pane' | 'store' | 'time'>, since: number | null): number {
    const { pane, store, time } = rc;
    const right = pane.x + pane.w;
    const fallback = right - OFFSCREEN_SPAN;
    if (since === null || store.length === 0) return fallback;
    const i = store.indexAtOrBefore(since);
    if (i < 0) return fallback;
    const x = time.xOfIndex(i);
    return x < pane.x ? pane.x : Math.min(x, fallback);
  }

  autoscaleRange(): [number, number] | null {
    return null;
  }

  labelClaims(rc: RenderContext): readonly LabelClaim[] {
    const { tags } = this.scene;
    if (tags.length === 0) return [];
    return orderTagRows(tags, (p) => rc.price.yOf(p), rc.pane).map((y) => ({
      y,
      h: ORDER_TAG_H + ORDER_TAG_GAP,
      edge: 'right' as const,
    }));
  }

  draw(rc: RenderContext): void {
    const { ctx, dpr, pane, price, format } = rc;
    const right = pane.x + pane.w;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    for (const z of this.scene.zones) {
      const x = this.startX(rc, z.since);
      const y1 = price.yOf(z.from);
      const y2 = price.yOf(z.to);
      ctx.fillStyle = z.fill;
      ctx.fillRect(x, Math.min(y1, y2), right - x, Math.abs(y2 - y1));
    }
    if (this.guide) {
      const y = crisp(price.yOf(this.guide.price), dpr);
      ctx.strokeStyle = this.guide.color;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 1 / dpr;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(pane.x, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const l of this.scene.lines) {
      const x = this.startX(rc, l.since);
      const y = crisp(price.yOf(l.price), dpr);
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.width;
      ctx.setLineDash([...l.dash]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    for (const a of this.axis) {
      rc.addAxisTag({ price: a.price, text: format.grouped(a.price), style: 'outline', color: a.color, priority: 25 });
    }
  }
}
