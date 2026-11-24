import { formatVolumeShort, MINUS, type PriceFormatter } from '../format.ts';
import {
  drawObjects,
  groundedText,
  NO_OBJECTS,
  objectFont,
  objectsRange,
  type IndicatorObjectsDef,
} from '../indicators/objects.ts';
import {
  dashOf,
  DEFAULT_PLOT_STYLE,
  defaultLabels,
  type IndicatorDef,
  type IndicatorInputs,
  type IndicatorLabels,
  type IndicatorPlotDef,
  type IndicatorStyle,
  type PlotStyle,
} from '../indicators/types.ts';
import { AlignedColumns, type SeriesChange, type SeriesValues } from '../indicators/values.ts';
import { eachBar, traceSeries, TwoToneRects } from '../render/columns.ts';
import { deOverlap, font, snap, TextMeasurer } from '../render/draw.ts';
import { opensPeriod } from '../session.ts';
import type { DataChange, SeriesStore } from '../store.ts';
import type { Layer, LayerHost, RenderContext } from './types.ts';

export interface IndicatorLayerOptions {
  id: string;
  def: IndicatorDef;
  inputs: IndicatorInputs;
  style: IndicatorStyle;
  label: string;
  values?: SeriesValues;
  objects?: IndicatorObjectsDef;
  paneHeight?: number;
  paneOrder?: number;
  legend?: boolean;
  z?: number;
  provider?: string | null;
  owner?: string | null;
  visible?: boolean;
}

interface Margins {
  top: number;
  bottom: number;
}

export function formatIndicatorValue(v: number, format: IndicatorDef['format'], price: PriceFormatter): string {
  if (!Number.isFinite(v)) return '—';
  if (format === 'volume') return formatVolumeShort(v);
  if (format === 'price') return price.grouped(v);
  const a = Math.abs(v);
  const s = a >= 1000 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a === 0 ? '0' : a.toPrecision(3);
  return v < 0 && Number(s) !== 0 ? `${MINUS}${s}` : s;
}

const LONE_POINT_SPAN = 0.4;
const NAME_GAP = 6;

export class IndicatorLayer implements Layer {
  readonly id: string;
  readonly kind = 'study' as const;
  readonly surface = 'main' as const;
  readonly pane: string;
  readonly z: number;
  readonly provider: string | null;
  readonly owner: string | null;
  readonly visible: boolean;
  readonly def: IndicatorDef;
  label: string;
  paneHeight: number | undefined;
  paneOrder: number | undefined;
  legend: boolean;
  autoscaleMargins: Margins = { top: 0.1, bottom: 0.1 };
  private inputs: IndicatorInputs;
  private style: IndicatorStyle;
  private objects: IndicatorObjectsDef;
  private readonly aligned: AlignedColumns;
  private readonly series: Record<string, Float64Array>;
  private readonly rects = new TwoToneRects();
  private host: LayerHost | null = null;
  private waiting = false;
  private store: SeriesStore | null = null;
  private readonly measurer = new TextMeasurer();

  constructor(options: IndicatorLayerOptions) {
    this.aligned = new AlignedColumns(
      options.def.plots.filter((p) => p.kind !== 'hline').map((p) => p.key),
      options.values,
    );
    this.series = this.aligned.rows;
    this.id = options.id;
    this.def = options.def;
    this.pane = options.def.placement === 'pane' ? `pane:${options.id}` : 'main';
    this.z = options.z ?? 20;
    this.provider = options.provider ?? 'Tessera';
    this.owner = options.owner ?? null;
    this.visible = options.visible ?? true;
    this.inputs = options.inputs;
    this.style = options.style;
    this.objects = options.objects ?? NO_OBJECTS;
    this.label = options.label;
    this.paneHeight = options.paneHeight;
    this.paneOrder = options.paneOrder;
    this.legend = options.legend ?? true;
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

  onData(change: DataChange, store: SeriesStore): void {
    this.store = store;
    this.aligned.onRows(change, store);
  }

  get reading(): boolean {
    return this.waiting;
  }

  setReading(reading: boolean): void {
    if (reading === this.waiting) return;
    this.waiting = reading;
    this.host?.invalidate();
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

  setInputs(inputs: IndicatorInputs): void {
    this.inputs = inputs;
    this.host?.invalidate();
  }

  setStyle(style: IndicatorStyle, label: string = this.label): void {
    this.style = style;
    this.label = label;
    this.host?.invalidate();
  }

  setObjects(objects: IndicatorObjectsDef): void {
    this.objects = objects;
    this.host?.invalidate();
  }

  getObjects(): IndicatorObjectsDef {
    return this.objects;
  }

  get labels(): IndicatorLabels {
    return this.style.labels ?? defaultLabels(this.def);
  }

  setPaneHeight(height: number | undefined): void {
    if (height === this.paneHeight) return;
    this.paneHeight = height;
    this.host?.relayout();
  }

  setPaneOrder(order: number | undefined): void {
    if (order === this.paneOrder) return;
    this.paneOrder = order;
    this.host?.relayout();
  }

  plotStyle(key: string): PlotStyle {
    return this.style.plots[key] ?? DEFAULT_PLOT_STYLE;
  }

  valueAt(key: string, index: number): number {
    const plot = this.def.plots.find((p) => p.key === key);
    if (plot?.kind === 'hline') return this.guideValue(plot);
    const s = this.series[key];
    return s && index >= 0 && index < this.length ? s[index]! : Number.NaN;
  }

  private guideValue(plot: IndicatorPlotDef): number {
    if (plot.valueInput) {
      const v = this.inputs[plot.valueInput];
      return typeof v === 'number' ? v : Number.NaN;
    }
    return plot.value ?? Number.NaN;
  }

  get fixedRange(): boolean {
    return this.def.placement === 'pane' && this.def.range?.length === 2;
  }

  axisMarks(): number[] {
    const marks: number[] = [];
    for (const p of this.def.plots) {
      if (p.kind !== 'hline' || !this.plotStyle(p.key).visible) continue;
      const v = this.guideValue(p);
      if (Number.isFinite(v)) marks.push(v);
    }
    return marks;
  }

  formatValue(v: number, price: PriceFormatter): string {
    return formatIndicatorValue(v, this.def.format, price);
  }

  autoscaleRange(from: number, to: number): [number, number] | null {
    if (this.def.placement !== 'pane') return null;
    const range = this.def.range;
    if (range?.length === 2) {
      this.autoscaleMargins = { top: 0.06, bottom: 0.06 };
      return [range[0]!, range[1]!];
    }
    let lo = Infinity;
    let hi = -Infinity;
    let histogram = false;
    const last = Math.min(to, this.length - 1);
    for (const p of this.def.plots) {
      if (!this.plotStyle(p.key).visible) continue;
      if (p.kind === 'hline') continue;
      const s = this.series[p.key];
      if (!s) continue;
      if (p.kind === 'histogram') {
        histogram = true;
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      for (let i = Math.max(0, from); i <= last; i++) {
        const v = s[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const store = this.store;
    if (store && store.length > 0) {
      const objects = objectsRange(
        this.objects,
        store.time[Math.max(0, from)]!,
        store.time[Math.min(store.length - 1, Math.max(0, to))]!,
      );
      if (objects) {
        lo = Math.min(lo, objects[0]);
        hi = Math.max(hi, objects[1]);
      }
    }
    if (!(hi >= lo)) return null;
    this.autoscaleMargins = { top: 0.12, bottom: histogram && lo >= 0 ? 0 : 0.1 };
    return [lo, hi];
  }

  draw(rc: RenderContext): void {
    const { ctx, pane } = rc;
    const to = Math.min(rc.time.to, this.length - 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    ctx.lineJoin = 'round';
    if (to >= rc.time.from) {
      for (const f of this.def.fills) this.drawFill(rc, f.key, f.from, f.to, to);
      for (const p of this.def.plots) {
        const st = this.plotStyle(p.key);
        if (!st.visible) continue;
        if (p.kind === 'histogram') this.drawHistogram(rc, p, st, to);
        else if (p.kind === 'line') this.drawLine(rc, this.series[p.key], st, to);
      }
    }
    for (const p of this.def.plots) {
      const st = this.plotStyle(p.key);
      if (p.kind === 'hline' && st.visible) this.drawGuide(rc, this.guideValue(p), st);
    }
    drawObjects(rc, this.objects, this.measurer);
    const labels = this.labels;
    if (labels.name) this.drawNames(rc, labels.value);
    if (this.def.placement === 'pane' && this.legend) this.drawPaneLegend(rc);
    ctx.restore();
    if (labels.priceScale) this.addTags(rc);
  }

  private lineEnds(): { plot: IndicatorPlotDef; st: PlotStyle; index: number; value: number }[] {
    const out: { plot: IndicatorPlotDef; st: PlotStyle; index: number; value: number }[] = [];
    for (const p of this.def.plots) {
      if (p.kind !== 'line') continue;
      const st = this.plotStyle(p.key);
      const s = this.series[p.key];
      if (!st.visible || !s) continue;
      let i = this.length - 1;
      while (i >= 0 && !Number.isFinite(s[i]!)) i--;
      if (i >= 0) out.push({ plot: p, st, index: i, value: s[i]! });
    }
    return out;
  }

  private drawNames(rc: RenderContext, withValue: boolean): void {
    const ends = this.lineEnds();
    if (!ends.length) return;
    const { pane, time, price, ctx } = rc;
    const f = objectFont(rc);
    const h = rc.theme.fontSize + 4;
    const items = ends.map((e) => {
      const name = ends.length === 1 ? this.label : e.plot.label;
      const text = withValue ? `${name} ${this.formatValue(e.value, rc.format)}` : name;
      const w = this.measurer.measure(ctx, f, text);
      const xEnd = time.xOfIndex(e.index);
      const room = xEnd + NAME_GAP + w <= pane.x + pane.w - 4;
      const y = price.yOf(e.value);
      return { e, text, w, x: room ? xEnd + NAME_GAP : pane.x + pane.w - 4 - w, y: room ? y : y - h / 2 - 2 };
    });
    const ys = deOverlap(
      items.map((it) => ({ y: it.y, h, priority: 0 })),
      pane.y,
      pane.y + pane.h,
    );
    items.forEach((it, k) => {
      if (it.x + it.w < pane.x) return;
      groundedText(rc, it.text, it.x, ys[k]!, it.e.st.color, f, 'left', 'middle');
    });
  }

  private stroke(rc: RenderContext, v: Float64Array, to: number): void {
    const { ctx, time, price } = rc;
    const half = time.barSpacing * LONE_POINT_SPAN;
    let lone: { x: number; y: number } | null = null;
    const tick = () => {
      if (!lone) return;
      ctx.moveTo(lone.x - half, lone.y);
      ctx.lineTo(lone.x + half, lone.y);
    };
    ctx.beginPath();
    traceSeries(
      rc,
      to,
      (i) => v[i]!,
      this.sessionBreak(rc),
      (i, val, start) => {
        const x = time.xOfIndex(i);
        const y = price.yOf(val);
        if (start) {
          tick();
          lone = { x, y };
          ctx.moveTo(x, y);
        } else {
          lone = null;
          ctx.lineTo(x, y);
        }
      },
      ctx.lineWidth,
    );
    tick();
    ctx.stroke();
  }

  private sessionBreak(rc: RenderContext): ((i: number) => boolean) | null {
    if (!this.def.sessionReset) return null;
    const day = rc.session.day;
    const period = String((this.def.resetBy && this.inputs[this.def.resetBy]) ?? 'session');
    return (i) => i > 0 && opensPeriod(period, day[i - 1]!, day[i]!);
  }

  private drawLine(rc: RenderContext, v: Float64Array | undefined, st: PlotStyle, to: number): void {
    if (!v) return;
    const { ctx } = rc;
    ctx.strokeStyle = st.color;
    ctx.globalAlpha = st.opacity;
    ctx.lineWidth = st.width;
    ctx.setLineDash(dashOf(st.line, st.width));
    this.stroke(rc, v, to);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawGuide(rc: RenderContext, value: number, st: PlotStyle): void {
    if (!Number.isFinite(value)) return;
    const { ctx, pane, price, dpr } = rc;
    const y = Math.round(price.yOf(value) * dpr) / dpr + (st.width <= 1 ? 0.5 / dpr : 0);
    if (y < pane.y || y > pane.y + pane.h) return;
    ctx.strokeStyle = st.color;
    ctx.globalAlpha = st.opacity;
    ctx.lineWidth = st.width <= 1 ? 1 / dpr : st.width;
    ctx.setLineDash(dashOf(st.line, st.width));
    ctx.beginPath();
    ctx.moveTo(pane.x, y);
    ctx.lineTo(pane.x + pane.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawHistogram(rc: RenderContext, p: IndicatorPlotDef, st: PlotStyle, to: number): void {
    const v = this.series[p.key];
    if (!v) return;
    const { ctx, time, price, dpr, store, pane } = rc;
    const px = 1 / dpr;
    const spacing = time.barSpacing;
    const w = rc.columns ? px : Math.max(px, snap(spacing * 0.7, dpr));
    const base = Math.min(pane.y + pane.h, Math.max(pane.y, snap(price.yOf(0), dpr)));
    const down = (i: number) =>
      p.colorBy === 'direction' ? store.close[i]! < store.open[i]! : p.colorBy === 'sign' ? v[i]! < 0 : false;
    ctx.globalAlpha = st.opacity;
    const { add } = this.rects;
    eachBar(
      rc,
      to,
      (i) => v[i]!,
      (i, x) => {
        const y = snap(price.yOf(v[i]!), dpr);
        add(down(i) ? 1 : 0, x - w / 2, Math.min(y, base), w, Math.max(px, Math.abs(base - y)));
      },
    );
    this.rects.fill(ctx, [st.color, st.downColor ?? st.color], rc.columns ? 'one by one' : 'one path');
    ctx.globalAlpha = 1;
  }

  private drawFill(rc: RenderContext, key: string, fromKey: string, toKey: string, to: number): void {
    const st = this.style.fills[key];
    if (!st?.visible || st.opacity <= 0) return;
    const edge = (k: string): ((i: number) => number) | null => {
      const p = this.def.plots.find((x) => x.key === k);
      if (!p) return null;
      if (p.kind === 'hline') {
        const g = this.guideValue(p);
        return () => g;
      }
      const s = this.series[k];
      return s ? (i) => s[i]! : null;
    };
    const a = edge(fromKey);
    const b = edge(toKey);
    if (!a || !b) return;
    const { ctx, time, price } = rc;
    ctx.fillStyle = st.color;
    ctx.globalAlpha = st.opacity;
    ctx.beginPath();
    let seg: number[] = [];
    const flush = () => {
      if (seg.length > 1) {
        ctx.moveTo(time.xOfIndex(seg[0]!), price.yOf(a(seg[0]!)));
        for (let k = 1; k < seg.length; k++) ctx.lineTo(time.xOfIndex(seg[k]!), price.yOf(a(seg[k]!)));
        for (let k = seg.length - 1; k >= 0; k--) ctx.lineTo(time.xOfIndex(seg[k]!), price.yOf(b(seg[k]!)));
        ctx.closePath();
      }
      seg = [];
    };
    const both = [fromKey, toKey].every((k) => this.def.plots.find((x) => x.key === k)?.kind === 'hline');
    if (both) {
      const y0 = price.yOf(a(0));
      const y1 = price.yOf(b(0));
      if (Number.isFinite(y0) && Number.isFinite(y1)) {
        ctx.rect(rc.pane.x, Math.min(y0, y1), rc.pane.w, Math.abs(y1 - y0));
      }
    } else {
      traceSeries(
        rc,
        to,
        (i) => (Number.isNaN(b(i)) ? Number.NaN : a(i)),
        this.sessionBreak(rc),
        (i, _v, start) => {
          if (start) flush();
          seg.push(i);
        },
      );
      flush();
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private legendIndex(rc: RenderContext): number {
    const ch = rc.crosshair;
    return ch && ch.index >= 0 && ch.index < this.length ? ch.index : this.length - 1;
  }

  private drawPaneLegend(rc: RenderContext): void {
    const { ctx, pane, theme, store } = rc;
    if (pane.h < 28) return;
    const i = this.legendIndex(rc);
    const f = font(theme.fontSize, theme.font);
    const fm = font(theme.fontSize, theme.font, 500);
    const left = pane.x + 14;
    const y = pane.y + 13;
    const right = pane.x + pane.w - 14;
    const parts: { text: string; font: string; color: string; w: number; gap: number }[] = [
      { text: this.label, font: fm, color: theme.labelText, w: this.measurer.measure(ctx, fm, this.label), gap: 10 },
    ];
    let x = left + parts[0]!.w + parts[0]!.gap;
    if (i >= 0) {
      for (const p of this.def.plots) {
        if (p.kind === 'hline') continue;
        const st = this.plotStyle(p.key);
        if (!st.visible) continue;
        const v = this.valueAt(p.key, i);
        const text = this.formatValue(v, rc.format);
        const w = this.measurer.measure(ctx, f, text);
        if (x + w > right) break;
        const isDown =
          p.colorBy === 'direction' ? store.close[i]! < store.open[i]! : p.colorBy === 'sign' ? v < 0 : false;
        parts.push({ text, font: f, color: isDown ? (st.downColor ?? st.color) : st.color, w, gap: 8 });
        x += w + 8;
      }
    }
    const end = left + parts.reduce((sum, p, k) => sum + p.w + (k < parts.length - 1 ? p.gap : 0), 0);
    ctx.fillStyle = theme.background;
    ctx.globalAlpha = 0.72;
    ctx.fillRect(left - 5, y - 9, end - left + 10, 18);
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'middle';
    x = left;
    for (const p of parts) {
      ctx.font = p.font;
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, x, y);
      x += p.w + p.gap;
    }
  }

  private addTags(rc: RenderContext): void {
    const last = this.length - 1;
    if (last < 0) return;
    for (const p of this.def.plots) {
      if (p.kind !== 'line') continue;
      const st = this.plotStyle(p.key);
      const v = this.valueAt(p.key, last);
      if (!st.visible || !Number.isFinite(v)) continue;
      rc.addAxisTag({
        price: v,
        text: this.formatValue(v, rc.format),
        style: 'filled',
        color: st.color,
        priority: 40,
        pane: this.pane,
      });
    }
  }
}
