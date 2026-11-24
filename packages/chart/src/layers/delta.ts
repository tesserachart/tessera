import type { PriceFormatter } from '../format.ts';
import { formatCount } from '../render/glyphs.ts';
import { eachBar, eachColumnRange, traceSeries, TwoToneRects } from '../render/columns.ts';
import { font, snap } from '../render/draw.ts';
import type { PlotStyle } from '../indicators/types.ts';
import { AlignedColumns, type SeriesChange, type SeriesValues } from '../indicators/values.ts';
import type { DataChange, SeriesStore } from '../store.ts';
import { ORDERFLOW_STYLE } from '../theme.ts';
import type { ChartTheme, TimeSpan } from '../types.ts';
import {
  FlowState,
  signedCount,
  STOPPED_ALPHA,
  type FlowReadout,
  type LegendNote,
  type LegendNotice,
  type LegendValue,
} from './flowReadout.ts';
import { CANDLE_BODY_MIN_SPACING } from './candles.ts';
import { valueHoles, type BarsInView } from './missingPrints.ts';
import type { Layer, LayerHost, RenderContext } from './types.ts';

export interface DeltaOptions {
  mode: 'cumulative' | 'bar';
  style: 'candles' | 'line' | 'histogram';
  reset: 'session' | 'chart';
  barStats: boolean;
  highlight: number;
  divergence: boolean;
}

export const DELTA_COLUMNS = ['delta', 'volume', 'open', 'high', 'low', 'close', 'candle'] as const;

type DeltaColumn = (typeof DELTA_COLUMNS)[number];

export const CVD_COLUMN: DeltaColumn = 'close';

export const DEFAULT_DELTA: Readonly<DeltaOptions> = {
  mode: 'cumulative',
  style: 'candles',
  reset: 'session',
  barStats: true,
  highlight: 0,
  divergence: false,
};

export const BAR_STATS_SPACING = 64;
const CANDLE_PASSES = [
  [true, false],
  [false, false],
  [true, true],
  [false, true],
] as const;
const STATS_ROW = 15;
const STATS_H = STATS_ROW * 2 + 4;
const ZERO_NEAR = 0.25;
const FADED = 0.3;
const HIGHLIGHT_DOT = 2.5;
const MARKER_W = 7;
const MARKER_H = 5;
const MARKER_GAP = 3;
const MARKER_MIN_SPACING = MARKER_W + 1;

export function deltaShare(delta: number, volume: number): number {
  return volume > 0 ? (Math.abs(delta) / volume) * 100 : Number.NaN;
}

export function priceAgainstDelta(open: number, close: number, delta: number): -1 | 0 | 1 {
  const price = Math.sign(close - open);
  return price !== 0 && price === -Math.sign(delta) ? (price as -1 | 1) : 0;
}

export interface DeltaStyle {
  zero: PlotStyle;
  delta: PlotStyle;
  cvd: PlotStyle;
}

export interface DeltaLayerOptions {
  id: string;
  options?: Partial<DeltaOptions>;
  style: DeltaStyle;
  paneHeight?: number;
  paneOrder?: number;
  z?: number;
  owner?: string | null;
  visible?: boolean;
}

export class DeltaLayer implements Layer, FlowReadout {
  readonly id: string;
  readonly kind = 'study' as const;
  readonly surface = 'main' as const;
  readonly pane: string;
  readonly z: number;
  readonly provider = 'Tessera';
  readonly owner: string | null;
  readonly visible: boolean;
  readonly state = new FlowState();
  private readonly rects = new TwoToneRects();
  private readonly faintRects = new TwoToneRects();
  paneHeight: number | undefined;
  paneOrder: number | undefined;
  autoscaleMargins = { top: 0.08, bottom: 0.08 };
  options: DeltaOptions;
  style: DeltaStyle;
  private readonly aligned = new AlignedColumns(DELTA_COLUMNS);
  private readonly series = this.aligned.rows as Readonly<Record<DeltaColumn, Float64Array>>;
  private host: LayerHost | null = null;
  private bars: SeriesStore | null = null;

  constructor(o: DeltaLayerOptions) {
    this.id = o.id;
    this.pane = `pane:${o.id}`;
    this.z = o.z ?? 10;
    this.owner = o.owner ?? null;
    this.visible = o.visible ?? true;
    this.options = { ...DEFAULT_DELTA, ...o.options };
    this.style = o.style;
    this.paneHeight = o.paneHeight;
    this.paneOrder = o.paneOrder;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  get length(): number {
    return this.aligned.length;
  }

  get values(): SeriesValues {
    return this.aligned.values;
  }

  setValues(values: SeriesValues): void {
    if (values === this.aligned.values) return;
    this.aligned.setValues(values);
    this.host?.invalidate('data');
  }

  valuesChanged(change: SeriesChange): void {
    this.aligned.onValues(change);
    this.host?.invalidate('data');
  }

  setOptions(o: Partial<DeltaOptions>, style?: DeltaStyle): void {
    this.options = { ...this.options, ...o };
    if (style) this.style = style;
    this.host?.invalidate();
  }

  setPaneHeight(h: number | undefined): void {
    if (h === this.paneHeight) return;
    this.paneHeight = h;
    this.host?.relayout();
  }

  setPaneOrder(order: number | undefined): void {
    if (order === this.paneOrder) return;
    this.paneOrder = order;
    this.host?.relayout();
  }

  noteChanged(): void {
    this.host?.invalidate();
  }

  onData(change: DataChange, store: SeriesStore): void {
    this.bars = store;
    this.aligned.onRows(change, store);
  }

  autoscaleRange(from: number, to: number): [number, number] | null {
    const r = this.range(from, to);
    if (!r) return null;
    const [lo, hi] = r;
    const near = this.histogram || (lo > 0 ? lo : hi < 0 ? -hi : 0) <= ZERO_NEAR * (hi - lo);
    const a = near ? Math.min(lo, 0) : lo;
    const b = near ? Math.max(hi, 0) : hi;
    return a === b ? [a - 1, b + 1] : [a, b];
  }

  private range(from: number, to: number): [number, number] | null {
    const s = this.series;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = Math.max(0, from); i <= Math.min(to, this.length - 1); i++) {
      if (this.histogram) {
        const d = this.histogramValue(i);
        if (Number.isNaN(d)) continue;
        lo = Math.min(lo, d, 0);
        hi = Math.max(hi, d, 0);
      } else {
        const l = s.low[i]!;
        if (Number.isNaN(l)) continue;
        lo = Math.min(lo, l);
        hi = Math.max(hi, s.high[i]!);
      }
    }
    return hi >= lo ? [lo, hi] : null;
  }

  autoscaleReserve(barSpacing: number, paneH: number): number {
    return this.statsShown(barSpacing, paneH) ? STATS_H + 2 : 0;
  }

  private statsShown(barSpacing: number, paneH: number): boolean {
    return this.options.barStats && barSpacing >= BAR_STATS_SPACING && paneH >= STATS_H + 20;
  }

  formatValue(v: number, _price: PriceFormatter): string {
    return formatCount(Math.round(v), false);
  }

  private get histogram(): boolean {
    return this.options.mode === 'bar' || this.options.style === 'histogram';
  }

  private histogramValue(i: number): number {
    return this.options.mode === 'bar' ? this.series.delta[i]! : this.series.close[i]!;
  }

  private strong(i: number): boolean {
    const cut = this.options.highlight;
    return cut <= 0 || deltaShare(this.series.delta[i]!, this.series.volume[i]!) >= cut;
  }

  private anyStrong(first: number, last: number): boolean {
    for (let i = first; i <= last; i++) if (this.strong(i)) return true;
    return false;
  }

  private valueAt(i: number): number {
    if (i < 0 || i >= this.length) return Number.NaN;
    return this.options.mode === 'bar' ? this.series.delta[i]! : this.series.close[i]!;
  }

  legendValues(index: number, _format: PriceFormatter, theme: ChartTheme): LegendValue[] {
    let i = Math.min(index, this.length - 1);
    if (index >= this.length - 1) while (i > 0 && Number.isNaN(this.valueAt(i))) i--;
    const v = this.valueAt(i);
    if (!Number.isFinite(v)) return [];
    return [{ text: signedCount(v), color: this.signColor(v, theme) }];
  }

  missingPrints(bars: BarsInView): readonly TimeSpan[] {
    return valueHoles(bars, this.length, (i) => !Number.isNaN(this.valueAt(i)));
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

  get legendName(): string {
    return this.options.mode === 'bar' ? 'Δ' : 'CVD';
  }

  private signColor(v: number, theme: ChartTheme): string {
    return v > 0
      ? this.style.delta.color
      : v < 0
        ? (this.style.delta.downColor ?? this.style.delta.color)
        : theme.subtleText;
  }

  draw(rc: RenderContext): void {
    const { ctx, pane, time, price, dpr } = rc;
    const to = Math.min(time.to, this.length - 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    if (this.state.stopped) ctx.globalAlpha = STOPPED_ALPHA;
    const g = ctx.globalAlpha;
    const zero = this.style.zero;
    if (zero.visible) {
      const y = snap(price.yOf(0), dpr) + 0.5 / dpr;
      ctx.strokeStyle = zero.color;
      ctx.globalAlpha = g * zero.opacity;
      ctx.lineWidth = 1 / dpr;
      ctx.beginPath();
      ctx.moveTo(pane.x, y);
      ctx.lineTo(pane.x + pane.w, y);
      ctx.stroke();
      ctx.globalAlpha = g;
    }
    if (to >= time.from) {
      if (this.histogram) this.drawBars(rc, to);
      else if (this.options.style === 'candles') this.drawCandles(rc, to);
      else this.drawLine(rc, to);
      if (this.options.divergence) this.drawDivergences(rc, to);
      if (this.statsShown(time.barSpacing, pane.h)) this.drawStats(rc, to);
    }
    ctx.restore();
    this.addTag(rc);
  }

  private drawBars(rc: RenderContext, to: number): void {
    const { ctx, time, price, dpr, pane } = rc;
    const st = this.style.delta;
    if (!st.visible) return;
    const px = 1 / dpr;
    const w = rc.columns ? px : Math.max(px, snap(time.barSpacing * 0.7, dpr));
    const base = Math.min(pane.y + pane.h, Math.max(pane.y, snap(price.yOf(0), dpr)));
    const g = ctx.globalAlpha;
    eachBar(
      rc,
      to,
      (i) => this.histogramValue(i),
      (i, x) => {
        const d = this.histogramValue(i);
        const y = snap(price.yOf(d), dpr);
        const { add } = this.strong(i) ? this.rects : this.faintRects;
        add(d < 0 ? 1 : 0, x - w / 2, Math.min(y, base), w, Math.max(px, Math.abs(base - y)));
      },
    );
    const colors = [st.color, st.downColor ?? st.color] as const;
    const how = rc.columns ? 'one by one' : 'one path';
    ctx.globalAlpha = g * st.opacity * FADED;
    this.faintRects.fill(ctx, colors, how);
    ctx.globalAlpha = g * st.opacity;
    this.rects.fill(ctx, colors, how);
    ctx.globalAlpha = g;
  }

  private drawCandles(rc: RenderContext, to: number): void {
    if (rc.columns) {
      this.drawCandleColumns(rc, to);
      return;
    }
    const { ctx, time, price, dpr, theme } = rc;
    const s = this.series;
    const px = 1 / dpr;
    const spacing = time.barSpacing;
    const body = Math.max(px, snap(spacing * 0.7, dpr));
    const bodies = spacing >= CANDLE_BODY_MIN_SPACING;
    const g = ctx.globalAlpha;
    let lines = false;
    for (const [up, strong] of CANDLE_PASSES) {
      ctx.beginPath();
      for (let i = time.from; i <= to; i++) {
        const c = s.close[i]!;
        if (Number.isNaN(c)) continue;
        if (!s.candle[i]) {
          lines = true;
          continue;
        }
        const o = s.open[i]!;
        if (c >= o !== up || this.strong(i) !== strong) continue;
        const x = snap(time.xOfIndex(i), dpr);
        const yh = snap(price.yOf(s.high[i]!), dpr);
        const yl = snap(price.yOf(s.low[i]!), dpr);
        ctx.rect(x - px / 2, yh, px, Math.max(px, yl - yh));
        if (bodies) {
          const yo = price.yOf(o);
          const yc = price.yOf(c);
          ctx.rect(x - body / 2, snap(Math.min(yo, yc), dpr), body, Math.max(px, snap(Math.abs(yc - yo), dpr)));
        }
      }
      ctx.fillStyle = up ? theme.flow.deltaUp : theme.flow.deltaDown;
      ctx.globalAlpha = strong ? g : g * FADED;
      ctx.fill();
    }
    ctx.globalAlpha = g;
    if (lines) this.drawLine(rc, to, true);
  }

  private drawCandleColumns(rc: RenderContext, to: number): void {
    const { ctx, price, dpr, theme } = rc;
    const s = this.series;
    const px = 1 / dpr;
    const breaks = this.sessionBreak(rc);
    eachColumnRange(rc.columns!, to, s.low, s.high, breaks, (r) => {
      const top = snap(price.yOf(r.hi), dpr);
      const { add } = this.anyStrong(r.first, r.last) ? this.rects : this.faintRects;
      add(
        s.close[r.last]! >= s.open[r.first]! ? 0 : 1,
        r.left,
        top,
        px,
        Math.max(px, snap(price.yOf(r.lo), dpr) - top),
      );
    });
    const g = ctx.globalAlpha;
    const colors = [theme.flow.deltaUp, theme.flow.deltaDown] as const;
    ctx.globalAlpha = g * FADED;
    this.faintRects.fill(ctx, colors, 'one path');
    ctx.globalAlpha = g;
    const overlapsBlendTwice = breaks !== null && g < 1;
    this.rects.fill(ctx, colors, overlapsBlendTwice ? 'one path' : 'one by one');
  }

  private sessionBreak(rc: RenderContext): ((i: number) => boolean) | null {
    const day = rc.session.day;
    return this.options.reset === 'session' ? (i) => i > 0 && day[i] !== day[i - 1] : null;
  }

  private drawLine(rc: RenderContext, to: number, onlyLines = false): void {
    const { ctx, time, price } = rc;
    const st = this.style.cvd;
    if (!st.visible) return;
    const s = this.series;
    const g = ctx.globalAlpha;
    ctx.strokeStyle = st.color;
    ctx.globalAlpha = g * st.opacity;
    ctx.lineWidth = st.width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    traceSeries(
      rc,
      to,
      (i) => (onlyLines && s.candle[i] ? Number.NaN : s.close[i]!),
      this.sessionBreak(rc),
      (i, v, start) => {
        const x = time.xOfIndex(i);
        const y = price.yOf(v);
        if (start) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      },
      st.width,
    );
    ctx.stroke();
    ctx.globalAlpha = g;
    if (!onlyLines && this.options.highlight > 0) this.drawHighlightDots(rc, to);
  }

  private drawHighlightDots(rc: RenderContext, to: number): void {
    const { ctx, time, price, theme } = rc;
    if (rc.columns || time.barSpacing < HIGHLIGHT_DOT * 2 + 1) return;
    const s = this.series;
    for (const up of [true, false]) {
      ctx.beginPath();
      for (let i = time.from; i <= to; i++) {
        const c = s.close[i]!;
        const d = s.delta[i]!;
        if (Number.isNaN(c) || d === 0 || d > 0 !== up || !this.strong(i)) continue;
        const x = time.xOfIndex(i);
        const y = price.yOf(c);
        ctx.moveTo(x + HIGHLIGHT_DOT, y);
        ctx.arc(x, y, HIGHLIGHT_DOT, 0, Math.PI * 2);
      }
      ctx.fillStyle = up ? theme.flow.deltaUp : theme.flow.deltaDown;
      ctx.fill();
    }
  }

  private markExtent(i: number): [number, number] {
    const s = this.series;
    if (this.histogram) {
      const v = this.histogramValue(i);
      return [Math.min(0, v), Math.max(0, v)];
    }
    if (this.options.style === 'line') return [s.close[i]!, s.close[i]!];
    return [s.low[i]!, s.high[i]!];
  }

  private drawDivergences(rc: RenderContext, to: number): void {
    const { ctx, time, price, theme } = rc;
    const bars = this.bars;
    if (!bars || rc.columns || time.barSpacing < MARKER_MIN_SPACING) return;
    const s = this.series;
    const last = Math.min(to, bars.length - 1);
    for (const way of [1, -1] as const) {
      ctx.beginPath();
      for (let i = time.from; i <= last; i++) {
        const d = s.delta[i]!;
        if (Number.isNaN(d) || Number.isNaN(this.valueAt(i))) continue;
        if (priceAgainstDelta(bars.open[i]!, bars.close[i]!, d) !== way) continue;
        const [lo, hi] = this.markExtent(i);
        const x = time.xOfIndex(i);
        const edge = d > 0 ? price.yOf(hi) - MARKER_GAP - MARKER_H : price.yOf(lo) + MARKER_GAP;
        const [tip, foot] = way > 0 ? [edge, edge + MARKER_H] : [edge + MARKER_H, edge];
        ctx.moveTo(x, tip);
        ctx.lineTo(x + MARKER_W / 2, foot);
        ctx.lineTo(x - MARKER_W / 2, foot);
        ctx.closePath();
      }
      ctx.fillStyle = way > 0 ? theme.upFill : theme.downFill;
      ctx.fill();
    }
  }

  private drawStats(rc: RenderContext, to: number): void {
    const { ctx, time, pane, theme } = rc;
    const s = this.series;
    const yDelta = pane.y + pane.h - STATS_ROW * 1.5 - 2;
    const yVol = pane.y + pane.h - STATS_ROW * 0.5 - 2;
    const g = ctx.globalAlpha;
    ctx.fillStyle = theme.background;
    ctx.globalAlpha = g * 0.82;
    ctx.fillRect(pane.x, pane.y + pane.h - STATS_H, pane.w, STATS_H);
    ctx.globalAlpha = g;
    ctx.font = font(ORDERFLOW_STYLE.figureSize, theme.fontFig);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = time.from; i <= to; i++) {
      const d = s.delta[i]!;
      if (Number.isNaN(d)) continue;
      const x = time.xOfIndex(i);
      ctx.fillStyle = this.signColor(d, theme);
      ctx.fillText(`Δ ${formatCount(d, true)}`, x, yDelta);
      ctx.fillStyle = theme.subtleText;
      ctx.fillText(formatCount(s.volume[i]!), x, yVol);
    }
    ctx.textAlign = 'left';
  }

  private addTag(rc: RenderContext): void {
    let i = this.length - 1;
    while (i >= 0 && Number.isNaN(this.valueAt(i))) i--;
    if (i < 0) return;
    const v = this.valueAt(i);
    rc.addAxisTag({
      price: v,
      text: formatCount(Math.round(v), true),
      style: 'outline',
      color: this.signColor(v, rc.theme),
      priority: 40,
      pane: this.pane,
    });
  }
}
