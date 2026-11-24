import { drawingAxes, extendSegment, type DrawingAxes } from '../drawings/geometry.ts';
import type { Ctx2D, RenderContext } from '../layers/types.ts';
import { crisp, font, oddDeviceWidth, type TextMeasurer } from '../render/draw.ts';
import { dashOf, type PlotStyle } from './types.ts';

export interface ObjectTextDef {
  readonly text: string;
  readonly at: 'start' | 'middle' | 'end';
  readonly side: 'above' | 'below';
  readonly color: string;
}

export interface IndicatorLineDef {
  readonly t1: number;
  readonly p1: number;
  readonly t2: number | null;
  readonly p2: number;
  readonly color: string;
  readonly width: number;
  readonly line: PlotStyle['line'];
  readonly extend: 'none' | 'left' | 'right' | 'both';
  readonly label: ObjectTextDef | null;
}

export interface IndicatorLabelDef {
  readonly t: number;
  readonly p: number;
  readonly text: string;
  readonly color: string;
  readonly size: 'small' | 'normal' | 'large';
  readonly side: 'above' | 'below' | 'at';
}

export interface IndicatorBoxDef {
  readonly t1: number;
  readonly p1: number;
  readonly t2: number | null;
  readonly p2: number;
  readonly color: string;
  readonly width: number;
  readonly line: PlotStyle['line'];
  readonly fill: string;
  readonly opacity: number;
  readonly extend: 'none' | 'left' | 'right' | 'both';
  readonly label: ObjectTextDef | null;
}

export interface IndicatorObjectsDef {
  readonly lines: readonly IndicatorLineDef[];
  readonly labels: readonly IndicatorLabelDef[];
  readonly boxes: readonly IndicatorBoxDef[];
}

export const NO_OBJECTS: IndicatorObjectsDef = { lines: [], labels: [], boxes: [] };

const TEXT_GAP = 3;
const TEXT_INSET = 4;

export function objectFont(rc: Pick<RenderContext, 'theme'>, size: IndicatorLabelDef['size'] = 'normal'): string {
  const s = rc.theme.fontSize + (size === 'small' ? -1 : size === 'large' ? 2 : 0);
  return font(s, rc.theme.font);
}

export function groundedText(
  rc: Pick<RenderContext, 'ctx' | 'theme'>,
  text: string,
  x: number,
  y: number,
  color: string,
  fontSpec: string,
  align: CanvasTextAlign,
  baseline: CanvasTextBaseline,
): void {
  const { ctx } = rc;
  ctx.save();
  ctx.font = fontSpec;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = rc.theme.background;
  ctx.globalAlpha = 1;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function xOf(axes: DrawingAxes, rc: RenderContext, t: number | null): number {
  if (t !== null) return axes.xOfTime(t);
  const n = rc.store.length;
  return n > 0 ? axes.xOfTime(rc.store.time[n - 1]!) : Number.NaN;
}

function stroke(ctx: Ctx2D, color: string, width: number, line: PlotStyle['line']): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashOf(line, width));
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function meets(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function textOnSegment(
  rc: RenderContext,
  measurer: TextMeasurer,
  t: ObjectTextDef,
  a: { x: number; y: number },
  b: { x: number; y: number },
  placed: Rect[],
): void {
  const { pane } = rc;
  const f = objectFont(rc);
  const w = measurer.measure(rc.ctx, f, t.text);
  const h = rc.theme.fontSize + 2;
  const [l, r] = a.x <= b.x ? [a, b] : [b, a];
  const anchor = t.at === 'start' ? l : t.at === 'end' ? r : { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  let x = t.at === 'end' ? anchor.x - w : t.at === 'start' ? anchor.x : anchor.x - w / 2;
  x = Math.min(pane.x + pane.w - TEXT_INSET - w, Math.max(pane.x + TEXT_INSET, x));
  const above = t.side === 'above';
  const box: Rect = { x, y: above ? anchor.y - TEXT_GAP - h : anchor.y + TEXT_GAP, w, h };
  for (let tries = 0; tries < 8; tries++) {
    const hit = placed.find((p) => meets(p, box));
    if (!hit) break;
    box.y = above ? hit.y - h - 1 : hit.y + hit.h + 1;
  }
  placed.push(box);
  groundedText(rc, t.text, x, box.y + h / 2, t.color, f, 'left', 'middle');
}

export function drawObjects(rc: RenderContext, objects: IndicatorObjectsDef, measurer: TextMeasurer): void {
  if (!objects.lines.length && !objects.labels.length && !objects.boxes.length) return;
  if (rc.store.length === 0) return;
  const { ctx, pane, dpr } = rc;
  const axes = drawingAxes(rc);
  const left = pane.x;
  const right = pane.x + pane.w;
  const words: ((placed: Rect[]) => void)[] = [];
  ctx.save();
  ctx.lineCap = 'butt';

  for (const b of objects.boxes) {
    let x1 = xOf(axes, rc, b.t1);
    let x2 = xOf(axes, rc, b.t2);
    if (!Number.isFinite(x1) || !Number.isFinite(x2)) continue;
    if (x1 > x2) [x1, x2] = [x2, x1];
    if (b.extend === 'left' || b.extend === 'both') x1 = left;
    if (b.extend === 'right' || b.extend === 'both') x2 = right;
    if (x2 < left || x1 > right) continue;
    const ya = axes.yOfPrice(b.p1);
    const yb = axes.yOfPrice(b.p2);
    const top = Math.min(ya, yb);
    const bottom = Math.max(ya, yb);
    if (b.opacity > 0) {
      ctx.globalAlpha = b.opacity;
      ctx.fillStyle = b.fill;
      ctx.fillRect(x1, top, x2 - x1, bottom - top);
      ctx.globalAlpha = 1;
    }
    if (b.width > 0) {
      stroke(ctx, b.color, b.width, b.line);
      const odd = oddDeviceWidth(b.width, dpr);
      const c = (v: number) => (odd ? crisp(v, dpr) : v);
      ctx.strokeRect(c(x1), c(top), c(x2) - c(x1), c(bottom) - c(top));
      ctx.setLineDash([]);
    }
    const label = b.label;
    if (label) {
      const y = label.side === 'above' ? top : bottom;
      words.push((placed) =>
        textOnSegment(rc, measurer, label, { x: x1 + TEXT_INSET, y }, { x: x2 - TEXT_INSET, y }, placed),
      );
    }
  }

  for (const l of objects.lines) {
    const ax = xOf(axes, rc, l.t1);
    const bx = xOf(axes, rc, l.t2);
    if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
    const a = { x: ax, y: axes.yOfPrice(l.p1) };
    const b = { x: bx, y: axes.yOfPrice(l.p2) };
    const seg = extendSegment(a, b, l.extend, pane);
    if (!seg) continue;
    const [p, q] = seg;
    if (Math.max(p.x, q.x) < left || Math.min(p.x, q.x) > right) continue;
    stroke(ctx, l.color, l.width, l.line);
    ctx.beginPath();
    const flat = p.y === q.y && oddDeviceWidth(l.width, dpr);
    const py = flat ? crisp(p.y, dpr) : p.y;
    const qy = flat ? py : q.y;
    ctx.moveTo(p.x, py);
    ctx.lineTo(q.x, qy);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = l.label;
    if (label) words.push((placed) => textOnSegment(rc, measurer, label, { x: p.x, y: py }, { x: q.x, y: qy }, placed));
  }
  ctx.restore();

  const placed: Rect[] = [];
  for (const draw of words) draw(placed);
  for (const t of objects.labels) {
    const x = axes.xOfTime(t.t);
    const y = axes.yOfPrice(t.p);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const f = objectFont(rc, t.size);
    const w = measurer.measure(ctx, f, t.text);
    if (x + w / 2 < left || x - w / 2 > right) continue;
    const baseline = t.side === 'above' ? 'bottom' : t.side === 'below' ? 'top' : 'middle';
    const yy = t.side === 'above' ? y - TEXT_GAP : t.side === 'below' ? y + TEXT_GAP : y;
    groundedText(rc, t.text, x, yy, t.color, f, 'center', baseline);
  }
}

export function objectsRange(objects: IndicatorObjectsDef, from: number, to: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const seen = (t1: number, t2: number | null, extend: string) =>
    extend !== 'none' || (Math.min(t1, t2 ?? Infinity) <= to && Math.max(t1, t2 ?? Infinity) >= from);
  for (const l of objects.lines) {
    if (!seen(l.t1, l.t2, l.extend)) continue;
    lo = Math.min(lo, l.p1, l.p2);
    hi = Math.max(hi, l.p1, l.p2);
  }
  for (const b of objects.boxes) {
    if (!seen(b.t1, b.t2, b.extend)) continue;
    lo = Math.min(lo, b.p1, b.p2);
    hi = Math.max(hi, b.p1, b.p2);
  }
  for (const t of objects.labels) {
    if (t.t < from || t.t > to) continue;
    lo = Math.min(lo, t.p);
    hi = Math.max(hi, t.p);
  }
  return hi >= lo ? [lo, hi] : null;
}
