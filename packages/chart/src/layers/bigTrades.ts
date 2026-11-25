import type { OutcomeKind } from '../flow/outcome.ts';
import type { PriceFormatter } from '../format.ts';
import { colorChannels, font } from '../render/draw.ts';
import { formatCount } from '../render/glyphs.ts';
import { ORDERFLOW_STYLE, rgba } from '../theme.ts';
import type { ChartTheme, TimeSpan } from '../types.ts';
import {
  defaultCanvasFactory,
  FlowState,
  NO_GAPS,
  STOPPED_ALPHA,
  type CanvasFactory,
  type AskSource,
  type AskTarget,
  type FlowReadout,
  type LegendNote,
  type LegendNotice,
  type LegendValue,
} from './flowReadout.ts';
import { STEM_BODY_PX, STEM_X_PX } from './footprint.ts';
import type { Layer, LayerHost, RenderContext } from './types.ts';

export type BigTradeTier = 'high' | 'medium' | 'low';

export interface BigTradeOutcome {
  kind: OutcomeKind;
  reachTicks: number;
  withinMs: number;
}

export interface BigTrade {
  t: number;
  price: number;
  size: number;
  side: 1 | -1;
  prints: number;
  ref: string;
  tier?: BigTradeTier | null;
  outcome?: BigTradeOutcome | null;
  levels?: number;
  firstPrice?: number;
  lastPrice?: number;
  durationMs?: number;
  orders?: number;
}

export interface BigTradeSource {
  reference(): number;
  between(fromMs: number, toMs: number): readonly BigTrade[];
}

export type BigTradePlotPrice = 'vwap' | 'start' | 'last';
export type ZoneFilter = 'all' | 'trend' | 'reversal' | 'none';

export interface BigTradeZoneOptions {
  bars: number;
  biggest: boolean;
  body: ZoneFilter;
  wick: ZoneFilter;
}

export interface BigTradesOptions {
  legend: string;
  notes: Readonly<Record<string, string>> | null;
  showSize: boolean;
  price: BigTradePlotPrice;
  zones: BigTradeZoneOptions | null;
}

export interface ZoneBars {
  length: number;
  time: ArrayLike<number>;
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
  indexAtOrBefore(t: number): number;
}

export interface BigTradeZone {
  from: number;
  to: number;
  low: number;
  high: number;
  side: 1 | -1;
}

export function plotPrice(t: BigTrade, at: BigTradePlotPrice, tick = 0): number {
  if (at === 'start') return t.firstPrice ?? t.price;
  if (at === 'last') return t.lastPrice ?? t.price;
  return tick > 0 ? Math.round(t.price / tick) * tick : t.price;
}

function passes(filter: ZoneFilter, trend: boolean): boolean {
  return filter === 'all' || (filter === 'trend' && trend) || (filter === 'reversal' && !trend);
}

export function bigTradeZones(
  trades: readonly BigTrade[],
  bars: ZoneBars,
  o: BigTradeZoneOptions,
  tick: number,
  at: BigTradePlotPrice,
): BigTradeZone[] {
  const picked = new Map<number, BigTrade[]>();
  for (const t of trades) {
    const i = bars.indexAtOrBefore(t.t);
    if (i < 0) continue;
    const price = plotPrice(t, at, tick);
    const top = Math.max(bars.open[i]!, bars.close[i]!);
    const bottom = Math.min(bars.open[i]!, bars.close[i]!);
    const up = bars.close[i]! > bars.open[i]!;
    const trend = t.side > 0 ? up : !up;
    const inBody = price >= bottom && price <= top;
    if (!passes(inBody ? o.body : o.wick, trend)) continue;
    const held = picked.get(i) ?? [];
    held.push(t);
    picked.set(i, held);
  }
  const out: BigTradeZone[] = [];
  for (const [i, list] of picked) {
    const chosen = o.biggest ? [list.reduce((a, b) => (b.size > a.size ? b : a))] : list;
    for (const t of chosen) {
      const price = plotPrice(t, at, tick);
      const last = Math.min(bars.length - 1, i + Math.max(1, Math.round(o.bars)));
      let to = last;
      for (let k = i + 1; k <= last; k++) {
        if (bars.low[k]! <= price && bars.high[k]! >= price) {
          to = k;
          break;
        }
      }
      if (to > i) out.push({ from: i, to, low: price - tick, high: price + tick, side: t.side });
    }
  }
  return out.sort((a, b) => a.from - b.from || a.low - b.low);
}

export interface BigTradeMarker {
  x: number;
  y: number;
  r: number;
  trade: BigTrade;
}

const LABEL_SIZE = 10.5;
const LABEL_STEP_PX = 0.5;
const LABEL_DISC_SHARE = 0.9;
const DIGIT_HEIGHT_EM = 0.75;
const EDGE = 20;
const HIT_MIN = 4;
const LANE_MIN = 2.5;
const CELL_SPILL = 3;

export interface BigTradesLayerOptions {
  id: string;
  options?: Partial<BigTradesOptions>;
  z?: number;
  owner?: string | null;
  visible?: boolean;
  createCanvas?: CanvasFactory;
}

export function bigTradeLabelFont(theme: ChartTheme, px = LABEL_SIZE): string {
  return font(px, theme.fontMono, ORDERFLOW_STYLE.bubbleLabelWeight);
}

export interface BubbleLabel {
  text: string;
  px: number;
}

function trimmed(v: number, unit: string): string {
  return `${v.toFixed(1).replace(/\.0$/, '')}${unit}`;
}

export function sizeSpellings(size: number): string[] {
  const out = [formatCount(size)];
  for (const [scale, unit] of [
    [1_000, 'k'],
    [1_000_000, 'M'],
  ] as const)
    if (size >= scale && size < scale * 1_000) out.push(trimmed(size / scale, unit));
  return [...new Set(out)];
}

export type LabelWidth = (text: string, px: number) => number;

function fitsDisc(width: number, px: number, r: number): boolean {
  const halo = labelHalo(px);
  return Math.hypot((width + halo) / 2, (DIGIT_HEIGHT_EM * px + halo) / 2) <= r * LABEL_DISC_SHARE;
}

function largestPxInDisc(text: string, r: number, widthAt: LabelWidth): number {
  const widthEm = widthAt(text, LABEL_SIZE) / LABEL_SIZE;
  const haloEm = ORDERFLOW_STYLE.bubbleLabelHalo / LABEL_SIZE;
  const estimate = (2 * r * LABEL_DISC_SHARE) / Math.hypot(widthEm + haloEm, DIGIT_HEIGHT_EM + haloEm);
  let px = Math.max(LABEL_STEP_PX, Math.min(LABEL_SIZE, Math.floor(estimate / LABEL_STEP_PX) * LABEL_STEP_PX));
  while (px > LABEL_STEP_PX && !fitsDisc(widthAt(text, px), px, r)) px -= LABEL_STEP_PX;
  return px;
}

export function fitBubbleLabel(size: number, r: number, widthAt: LabelWidth): BubbleLabel {
  let best: BubbleLabel | null = null;
  for (const text of sizeSpellings(size)) {
    const px = largestPxInDisc(text, r, widthAt);
    if (px === LABEL_SIZE) return { text, px };
    if (!best || px > best.px) best = { text, px };
  }
  return best!;
}

function usable(reference: number): boolean {
  return reference > 0 && Number.isFinite(reference);
}

function clamp(lo: number, hi: number, v: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function bubbleRadius(size: number, reference: number, spacing: number): number {
  const s = ORDERFLOW_STYLE;
  const base = clamp(s.bubbleRadiusMin, s.bubbleRadiusMax, s.bubbleRadiusBase + s.bubbleRadiusPerSpacing * spacing);
  if (!usable(reference)) return base;
  const ratio = size / reference;
  return base * (ratio > 1 ? Math.min(s.bubbleScaleMax, Math.sqrt(ratio)) : 1);
}

interface Ink {
  rgb: string;
  fill: number;
  key: string;
}

function inkOf(color: string): Ink {
  const [r, g, b, a] = colorChannels(color) ?? [0, 0, 0, 0];
  const rgb = `${String(r)},${String(g)},${String(b)}`;
  const fill = Math.min(ORDERFLOW_STYLE.bubbleFill, a);
  return { rgb, fill, key: `${rgb}|${String(fill)}` };
}

function drawBubble(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  ink: Ink,
  alpha: number,
  dpr: number,
): void {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = rgba(ink.rgb, ink.fill * alpha);
  c.fill();
  c.lineWidth = 1 / dpr;
  c.strokeStyle = rgba(ink.rgb, ORDERFLOW_STYLE.bubbleStroke * alpha);
  c.stroke();
}

function drawHovered(c: CanvasRenderingContext2D, p: Placed, ink: Ink, ground: string, alpha: number): void {
  c.beginPath();
  c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  c.fillStyle = ground;
  c.fill();
  c.fillStyle = rgba(ink.rgb, ORDERFLOW_STYLE.bubbleFill * alpha);
  c.fill();
  c.lineWidth = ORDERFLOW_STYLE.bubbleHoverStroke;
  c.strokeStyle = rgba(ink.rgb, alpha);
  c.stroke();
}

function drawLabel(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  ink: Ink,
  ground: string,
  text: string,
): void {
  c.strokeStyle = ground;
  c.strokeText(label, x, y);
  c.strokeStyle = rgba(ink.rgb, ink.fill);
  c.strokeText(label, x, y);
  c.fillStyle = text;
  c.fillText(label, x, y);
}

function labelHalo(px: number): number {
  return (ORDERFLOW_STYLE.bubbleLabelHalo * px) / LABEL_SIZE;
}

function labelStyle(c: CanvasRenderingContext2D, theme: ChartTheme, px: number): void {
  c.font = bigTradeLabelFont(theme, px);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.lineWidth = labelHalo(px);
}

const OVERLAP_NUDGE_FROM = 0.8;
const NUDGE_STEP_PX = 0.25;

export function overlapShare(distance: number, small: number, big: number): number {
  if (distance >= small + big) return 0;
  if (distance <= big - small) return 1;
  const a = (distance * distance + small * small - big * big) / (2 * distance * small);
  const b = (distance * distance + big * big - small * small) / (2 * distance * big);
  const lens =
    small * small * Math.acos(clamp(-1, 1, a)) +
    big * big * Math.acos(clamp(-1, 1, b)) -
    0.5 *
      Math.sqrt(
        Math.max(
          0,
          (-distance + small + big) * (distance + small - big) * (distance - small + big) * (distance + small + big),
        ),
      );
  return lens / (Math.PI * small * small);
}

function nudgeOffLarger(placed: Placed[]): void {
  for (let k = 1; k < placed.length; k++) {
    const p = placed[k]!;
    for (let j = 0; j < k; j++) {
      const q = placed[j]!;
      if (q.r < p.r || Math.abs(q.x - p.x) > q.r || Math.abs(q.y - p.y) > q.r) continue;
      if (overlapShare(Math.hypot(q.x - p.x, q.y - p.y), p.r, q.r) <= OVERLAP_NUDGE_FROM) continue;
      let shift = NUDGE_STEP_PX;
      const reach = p.r + q.r;
      while (shift < reach && overlapShare(Math.hypot(q.x - p.x - shift, q.y - p.y), p.r, q.r) > OVERLAP_NUDGE_FROM)
        shift += NUDGE_STEP_PX;
      p.x += shift;
    }
  }
}

function spriteRadius(r: number): number {
  return Math.round(r * 2) / 2;
}

interface Placed extends BigTradeMarker {
  label: string;
  labelPx: number;
  sprite: { canvas: unknown; size: number } | null;
}

export class BigTradesLayer implements Layer, FlowReadout, AskSource {
  readonly id: string;
  readonly kind = 'study' as const;
  readonly surface = 'main' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = 'Tessera';
  readonly owner: string | null;
  readonly visible: boolean;
  readonly state = new FlowState();
  options: BigTradesOptions;
  private source: BigTradeSource | null = null;
  private gaps: readonly TimeSpan[] = NO_GAPS;
  private host: LayerHost | null = null;
  private placed: Placed[] = [];
  private drawOrder: Placed[] = [];
  private hovered: string | null = null;
  private zones: BigTradeZone[] = [];
  private readonly createCanvas: CanvasFactory | null;
  private readonly sprites = new Map<string, { canvas: unknown; size: number }>();
  private readonly widths = new Map<string, number>();
  private readonly labelSprites = new Map<string, { canvas: unknown; w: number; h: number }>();
  private sorted: { trades: readonly BigTrade[]; order: BigTrade[] } | null = null;
  private placedFor: { trades: readonly BigTrade[]; key: string } | null = null;
  private spriteKey = '';

  constructor(o: BigTradesLayerOptions) {
    this.createCanvas = o.createCanvas ?? defaultCanvasFactory();
    this.id = o.id;
    this.z = o.z ?? 16;
    this.owner = o.owner ?? null;
    this.visible = o.visible ?? true;
    this.options = { legend: '', notes: null, showSize: true, price: 'vwap', zones: null, ...o.options };
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  setGaps(gaps: readonly TimeSpan[]): void {
    if (gaps === this.gaps) return;
    this.gaps = gaps;
    this.host?.invalidate('data');
  }

  setSource(source: BigTradeSource | null): void {
    this.source = source;
    this.host?.invalidate('data');
  }

  setOptions(o: Partial<BigTradesOptions>): void {
    this.options = { ...this.options, ...o };
    this.host?.invalidate();
  }

  dataChanged(): void {
    this.host?.invalidate('data');
  }

  setHovered(ref: string | null): void {
    if (ref === this.hovered) return;
    this.hovered = ref;
    this.host?.invalidate();
  }

  noteChanged(): void {
    this.host?.invalidate();
  }

  legendValues(_index: number, _format: PriceFormatter, theme: ChartTheme): LegendValue[] {
    return this.options.legend ? [{ text: this.options.legend, color: theme.subtleText }] : [];
  }

  missingPrints(): readonly TimeSpan[] {
    return this.gaps;
  }

  legendNote(): LegendNote | null {
    return this.state.note;
  }

  legendNotice(): LegendNotice | null {
    return this.state.notice;
  }

  reading(): boolean {
    return this.state.reading;
  }

  legendSuffix(): string {
    return '';
  }

  aggressorNote(): string | null {
    return this.state.aggressor;
  }

  optionNotes(): Readonly<Record<string, string>> | null {
    return this.options.notes;
  }

  draw(rc: RenderContext): void {
    const src = this.source;
    const { time, store, mainPrice, pane, format, theme } = rc;
    if (!src || time.to < time.from || store.length === 0) {
      this.placed = [];
      this.drawOrder = [];
      this.placedFor = null;
      return;
    }
    const from = store.time[time.from]!;
    const to = store.time[Math.min(time.to, store.length - 1)]! + rc.timeframeMs;
    const zoneOpts = this.options.zones;
    const trades = src.between(from - (zoneOpts ? zoneOpts.bars * rc.timeframeMs : 0), to);
    const tick = format.minMove;
    const at = this.options.price;
    this.zones = zoneOpts ? bigTradeZones(trades, store, zoneOpts, tick, at) : [];
    if (trades.length === 0) {
      this.placed = [];
      this.drawOrder = [];
      this.placedFor = null;
      return;
    }
    const reference = src.reference();
    const labelFont = bigTradeLabelFont(theme);
    const showSize = this.options.showSize;
    const viewKey = `${String(from)}|${String(to)}|${String(time.barSpacing)}|${String(time.xOfIndex(time.from))}|${String(mainPrice.yOf(0))}|${String(mainPrice.yOf(1))}|${String(pane.x)}|${String(pane.y)}|${String(pane.w)}|${String(pane.h)}|${String(reference)}|${at}|${String(tick)}|${String(showSize)}|${String(rc.seriesReplaced)}|${labelFont}`;
    if (this.placedFor?.trades === trades && this.placedFor.key === viewKey) {
      this.paint(rc);
      return;
    }
    this.placedFor = { trades, key: viewKey };
    if (this.sorted?.trades !== trades) this.sorted = { trades, order: [...trades].sort((a, b) => b.size - a.size) };
    const spacing = time.barSpacing;
    const labelled = showSize && spacing >= ORDERFLOW_STYLE.bubbleLabelSpacingMin;
    const stem = rc.seriesReplaced;
    const candleCentre = (i: number) =>
      stem ? time.xOfIndex(i) - spacing / 2 + STEM_X_PX + STEM_BODY_PX / 2 : time.xOfIndex(i);
    const ctx = rc.ctx;
    const widthAt: LabelWidth = (label, px) => {
      const labelFontAt = bigTradeLabelFont(theme, px);
      const key = `${labelFontAt}|${label}`;
      let w = this.widths.get(key);
      if (w === undefined) {
        ctx.save();
        ctx.font = labelFontAt;
        w = ctx.measureText(label).width;
        ctx.restore();
        if (this.widths.size > 16384) this.widths.clear();
        this.widths.set(key, w);
      }
      return w;
    };
    const placed: Placed[] = [];
    for (const t of this.sorted.order) {
      const i = store.indexAtOrBefore(t.t);
      if (i < 0) continue;
      const x = candleCentre(i);
      const y = mainPrice.yOf(plotPrice(t, at, tick));
      if (!Number.isFinite(x) || x < pane.x - EDGE || x > pane.x + pane.w + EDGE) continue;
      if (y < pane.y - EDGE || y > pane.y + pane.h + EDGE) continue;
      const natural = bubbleRadius(t.size, reference, spacing);
      const cap = stem ? Math.max(LANE_MIN, spacing / 2 + CELL_SPILL) : Number.NaN;
      const r = Number.isNaN(cap) ? natural : Math.max(LANE_MIN, Math.min(natural, cap));
      placed.push({ x, y, r, trade: t, label: '', labelPx: 0, sprite: null });
    }
    nudgeOffLarger(placed);
    if (labelled)
      for (const p of placed) {
        const fitted = fitBubbleLabel(p.trade.size, p.r, widthAt);
        p.label = fitted.text;
        p.labelPx = fitted.px;
      }
    this.placed = placed;
    this.drawOrder = [...placed].sort((a, b) => a.r - b.r);
    this.paint(rc);
  }

  private paint(rc: RenderContext): void {
    const { ctx, pane, theme, dpr } = rc;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    const g = this.state.stopped ? STOPPED_ALPHA : 1;
    const fl = theme.flow;
    const buy = inkOf(fl.bubbleBuy);
    const sell = inkOf(fl.bubbleSell);
    const inkOfSide = (side: 1 | -1) => (side > 0 ? buy : sell);
    this.paintZones(rc, inkOfSide, g);
    const spriteKey = `${String(dpr)}|${String(g)}|${fl.bubbleBuy}|${fl.bubbleSell}`;
    const fresh = spriteKey !== this.spriteKey;
    this.spriteKey = spriteKey;
    for (const p of this.drawOrder) {
      if (this.createCanvas) {
        if (fresh || !p.sprite) p.sprite = this.sprite(inkOfSide(p.trade.side), p.r, dpr, g);
        const sp = p.sprite;
        const half = sp.size / dpr / 2;
        const x = Math.round((p.x - half) * dpr) / dpr;
        const y = Math.round((p.y - half) * dpr) / dpr;
        ctx.drawImage(sp.canvas as CanvasImageSource, x, y, sp.size / dpr, sp.size / dpr);
      } else drawBubble(ctx, p.x, p.y, p.r, inkOfSide(p.trade.side), g, dpr);
    }
    const hovered = this.hovered === null ? undefined : this.placed.find((p) => p.trade.ref === this.hovered);
    if (hovered) drawHovered(ctx, hovered, inkOfSide(hovered.trade.side), theme.background, g);
    ctx.globalAlpha = g;
    for (let k = this.placed.length - 1; k >= 0; k--) {
      const p = this.placed[k]!;
      if (!p.label) continue;
      const ink = inkOfSide(p.trade.side);
      if (this.createCanvas) {
        const sp = this.labelSprite(p.label, p.labelPx, ink, theme, fl.text, dpr);
        const x = Math.round((p.x - sp.w / 2) * dpr) / dpr;
        const y = Math.round((p.y + 0.5 - sp.h / 2) * dpr) / dpr;
        ctx.drawImage(sp.canvas as CanvasImageSource, x, y, sp.w, sp.h);
      } else {
        labelStyle(ctx, theme, p.labelPx);
        drawLabel(ctx, p.x, p.y + 0.5, p.label, ink, theme.background, fl.text);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private paintZones(rc: RenderContext, inkOfSide: (side: 1 | -1) => Ink, g: number): void {
    if (this.zones.length === 0) return;
    const { ctx, time, mainPrice } = rc;
    const half = time.barSpacing / 2;
    for (const z of this.zones) {
      if (z.to < time.from || z.from > time.to) continue;
      const x0 = time.xOfIndex(z.from) + half;
      const x1 = time.xOfIndex(z.to) + half;
      const y0 = mainPrice.yOf(z.high);
      const y1 = mainPrice.yOf(z.low);
      ctx.fillStyle = rgba(inkOfSide(z.side).rgb, ORDERFLOW_STYLE.zoneOpacity * g);
      ctx.fillRect(x0, Math.min(y0, y1), Math.max(1, x1 - x0), Math.max(1, Math.abs(y1 - y0)));
    }
  }

  private labelSprite(
    label: string,
    px: number,
    ink: Ink,
    theme: ChartTheme,
    text: string,
    dpr: number,
  ): { canvas: unknown; w: number; h: number } {
    const ground = theme.background;
    const key = `${label}|${String(px)}|${ink.key}|${theme.fontMono}|${ground}|${text}|${String(dpr)}`;
    const held = this.labelSprites.get(key);
    if (held) return held;
    const halo = labelHalo(px);
    const probe = this.createCanvas!(1, 1) as { getContext(t: '2d'): CanvasRenderingContext2D };
    const pc = probe.getContext('2d');
    pc.font = bigTradeLabelFont(theme, px);
    const w = Math.ceil(pc.measureText(label).width + 2 * halo + 2);
    const h = Math.ceil(px + 2 * halo + 4);
    const canvas = this.createCanvas!(Math.ceil(w * dpr), Math.ceil(h * dpr));
    const c = (canvas as { getContext(t: '2d'): CanvasRenderingContext2D }).getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    labelStyle(c, theme, px);
    drawLabel(c, w / 2, h / 2, label, ink, ground, text);
    const sp = { canvas, w, h };
    if (this.labelSprites.size > 8192) this.labelSprites.clear();
    this.labelSprites.set(key, sp);
    return sp;
  }

  private sprite(ink: Ink, r: number, dpr: number, alpha: number): { canvas: unknown; size: number } {
    const rq = spriteRadius(r);
    const key = `${ink.key}|${String(rq)}|${String(dpr)}|${String(alpha)}`;
    const held = this.sprites.get(key);
    if (held) return held;
    const size = Math.ceil((2 * rq + 4) * dpr);
    const canvas = this.createCanvas!(size, size);
    const c = (canvas as { getContext(t: '2d'): CanvasRenderingContext2D }).getContext('2d');
    const m = size / dpr / 2;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBubble(c, m, m, rq, ink, alpha, dpr);
    const sp = { canvas, size };
    if (this.sprites.size > 1024) this.sprites.clear();
    this.sprites.set(key, sp);
    return sp;
  }

  markersAt(x: number, y: number): BigTradeMarker[] {
    return this.placed.filter((p) => Math.hypot(x - p.x, y - p.y) <= Math.max(p.r, HIT_MIN)).sort((a, b) => a.r - b.r);
  }

  markers(): readonly BigTradeMarker[] {
    return this.placed;
  }

  hitTest(x: number, y: number): { objectId: string; distance: number } | null {
    const m = this.markersAt(x, y)[0];
    return m ? { objectId: m.trade.ref, distance: 0 } : null;
  }

  askTarget(x: number, y: number): AskTarget | null {
    const ms = this.markersAt(x, y);
    if (ms.length === 0) return null;
    const ts = ms.map((m) => m.trade.t);
    const ps = ms.map((m) => m.trade.price);
    return {
      kind: 'bubble',
      label: ms.length > 1 ? 'these big trades' : 'this big trade',
      from: Math.min(...ts),
      to: Math.max(...ts),
      low: Math.min(...ps),
      high: Math.max(...ps),
      detail: ms
        .map((m) => [bigTradeWords(m.trade), bigTradeOutcomeWords(m.trade)].filter(Boolean).join(' · '))
        .join('; '),
    };
  }
}

function durationWords(ms: number): string {
  return Math.round(ms) < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function withinWords(ms: number): string {
  return Math.round(ms) < 1000 ? `${String(Math.round(ms))} ms` : `${String(Math.round(ms / 1000))} s`;
}

function ticksWords(n: number): string {
  return `${String(n)} tick${n === 1 ? '' : 's'}`;
}

export function bigTradeOutcomeWords(t: BigTrade): string | null {
  const o = t.outcome;
  if (!o) return null;
  const within = withinWords(o.withinMs);
  switch (o.kind) {
    case 'absorbed':
      return `Absorbed: price came back ${ticksWords(o.reachTicks)} within ${within}`;
    case 'pushed':
      return `Pushed through: ${ticksWords(o.reachTicks)} past it within ${within}`;
    case 'neither':
      return `Neither within ${within}`;
  }
}

const TIER_WORDS: Readonly<Record<BigTradeTier, string>> = {
  high: 'High tier',
  medium: 'Medium tier',
  low: 'Low tier',
};

export interface BigTradeCard {
  side: 1 | -1;
  headline: readonly string[];
  detail: readonly string[];
}

function outcomeCardWords(o: BigTradeOutcome): string {
  const within = withinWords(o.withinMs);
  switch (o.kind) {
    case 'absorbed':
      return `Absorbed, back ${ticksWords(o.reachTicks)} in ${within}`;
    case 'pushed':
      return `Pushed through ${ticksWords(o.reachTicks)} in ${within}`;
    case 'neither':
      return `Neither within ${within}`;
  }
}

export function bigTradeCard(t: BigTrade, price: (p: number) => string, clock: (ms: number) => string): BigTradeCard {
  const first = t.firstPrice ?? t.price;
  const last = t.lastPrice ?? t.price;
  const at = first === last ? price(first) : `${price(first)}–${price(last)}`;
  const headline = [`${t.side > 0 ? 'Buy' : 'Sell'} ${formatCount(t.size)} @ ${at}`];
  if ((t.levels ?? 1) > 1) headline.push(`${String(t.levels)} levels`);
  const fills = `${String(t.prints)} fill${t.prints === 1 ? '' : 's'}`;
  const detail = [
    clock(t.t),
    t.prints > 1 && t.durationMs !== undefined ? `${fills} in ${durationWords(t.durationMs)}` : fills,
  ];
  if ((t.orders ?? 1) > 1) detail.push(`${String(t.orders)} orders`);
  if (t.tier) detail.push(TIER_WORDS[t.tier]);
  if (t.outcome) detail.push(outcomeCardWords(t.outcome));
  return { side: t.side, headline, detail };
}

export function bigTradeWords(t: BigTrade, price: (p: number) => string = String): string {
  const first = t.firstPrice ?? t.price;
  const last = t.lastPrice ?? t.price;
  const parts = [
    `${t.side > 0 ? 'Buy' : 'Sell'} ${formatCount(t.size)} in ${String(t.prints)} fill${t.prints === 1 ? '' : 's'}`,
    first === last ? price(first) : `${price(first)}–${price(last)}`,
  ];
  if (t.durationMs !== undefined) parts.push(durationWords(t.durationMs));
  if ((t.levels ?? 1) > 1) parts.push(`${String(t.levels)} levels`);
  if ((t.orders ?? 1) > 1) parts.push(`${String(t.orders)} orders`);
  return parts.join(' · ');
}
