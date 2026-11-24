import { MINUS } from '../format.ts';
import {
  readingAngle,
  textCentre,
  textCorners,
  textFont,
  textLineHeight,
  type MeasureText,
  type PlacedText,
} from '../render/label.ts';
import type { Rect } from '../types.ts';
import {
  distToSegment,
  extendSegment,
  fibExtensionPrices,
  fibFanPrices,
  fibLevelPrices,
  formatAngle,
  formatDuration,
  formatLevel,
  inPolygon,
  measureStats,
  screenAngle,
  type DrawingAxes,
  type Pt,
} from './geometry.ts';
import {
  FIB_DEFAULT_LEVELS,
  takesWords,
  type PlaceKind,
  type DrawingLabelSpec,
  type DrawingPoint,
  type DrawingSpec,
} from './types.ts';

export interface ShapeLine {
  a: Pt;
  b: Pt;
  alpha?: number;
  dash?: readonly number[];
  arrow?: boolean;
}

export interface ShapeFill {
  pts: readonly Pt[];
  alpha: number;
  color?: string;
}

export interface ShapeLabel {
  x: number;
  y: number;
  lines: readonly string[];
  align: 'left' | 'center';
  anchor: 'top' | 'bottom';
  plate: 'fill' | 'ground' | 'none';
  color?: string;
  note?: boolean;
}

export interface Handle extends Pt {
  t: number;
  p: number;
  offset?: boolean;
}

export interface Shape {
  id: string;
  color: string;
  lines: ShapeLine[];
  fills: ShapeFill[];
  labels: ShapeLabel[];
  handles: Handle[];
  areas: Pt[][];
  texts: PlacedText[];
  labelAt: Pt | null;
  tags: { price: number; always: boolean }[];
  box: Rect;
}

export interface LabelMetrics {
  width(text: string, note: boolean): number;
  lineHeight(note: boolean): number;
  text?(font: string, text: string): number;
}

export interface ShapeOptions {
  agentColor: string;
  upColor: string;
  downColor: string;
  background?: string;
  family?: string;
}

const RIGHT_ALIGNED: ReadonlySet<PlaceKind> = new Set(['horizontal_line', 'vertical_line', 'cross_line']);
const LEFT_ALIGNED: ReadonlySet<PlaceKind> = new Set([
  'horizontal_ray',
  'rectangle',
  'price_range',
  'date_range',
  'fib_retracement',
  'fib_extension',
  'fib_fan',
]);

export function defaultLabel(kind: PlaceKind): DrawingLabelSpec {
  const align = RIGHT_ALIGNED.has(kind) ? 'right' : LEFT_ALIGNED.has(kind) ? 'left' : 'center';
  return {
    text: '',
    color: null,
    size: 12,
    bold: false,
    italic: false,
    align,
    position: 'above',
    showPrice: kind === 'fib_retracement' || kind === 'fib_extension',
    showLevels: true,
  };
}

const LABEL_INSET = 4;
const ANGLE_ARC_SEGMENTS = 16;
const ANGLE_ARC_MAX = 40;
const ANGLE_ARC_MIN = 16;
const LABEL_GAP = 2;

const PAD_X = 6;
const PAD_Y = 3;

export function labelSize(l: ShapeLabel, m: LabelMetrics): { w: number; h: number } {
  const note = l.note === true;
  let w = 0;
  for (const line of l.lines) w = Math.max(w, m.width(line, note));
  return { w: w + PAD_X * 2, h: l.lines.length * m.lineHeight(note) + PAD_Y * 2 };
}

export function labelRect(l: ShapeLabel, m: LabelMetrics): Rect {
  const { w, h } = labelSize(l, m);
  const x = l.align === 'center' ? l.x - w / 2 : l.x;
  const y = l.anchor === 'top' ? l.y : l.y - h;
  return { x, y, w, h };
}

function rectPts(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function signed(v: string, n: number): string {
  return n > 0 ? `+${v}` : v.replace(/^-/, MINUS);
}

export function channelOffset(points: readonly DrawingPoint[], axes: DrawingAxes): number {
  const [a, b, c] = points;
  if (!a || !b || !c) return 0;
  const xa = axes.xOfTime(a.t);
  const xb = axes.xOfTime(b.t);
  const xc = axes.xOfTime(c.t);
  const base = xb === xa ? a.price : a.price + ((b.price - a.price) * (xc - xa)) / (xb - xa);
  return Number.isFinite(base) ? c.price - base : 0;
}

export function shapeOf(d: DrawingSpec, axes: DrawingAxes, metrics: LabelMetrics, o: ShapeOptions): Shape | null {
  if (!axes.ready) return null;
  const pane = axes.pane;
  const color = d.agent ? o.agentColor : d.color;
  const pts = d.points.map((p) => ({ x: axes.xOfTime(p.t), y: axes.yOfPrice(p.price) }));
  const shape: Shape = {
    id: d.id,
    color,
    lines: [],
    fills: [],
    labels: [],
    handles: [],
    areas: [],
    texts: [],
    labelAt: null,
    tags: [],
    box: { x: 0, y: 0, w: 0, h: 0 },
  };
  const measure = measureOf(metrics);
  const label = d.label ?? null;
  const look = label ?? defaultLabel(d.kind);
  const font = textFont({ size: look.size, bold: look.bold, italic: look.italic, family: o.family ?? 'sans-serif' });
  const lineHeight = textLineHeight(look.size);
  const ground = o.background ?? '#000000';
  const priceOf = (p: number): string | null => (Number.isFinite(p) ? axes.formatPrice(p) : null);
  const place = (
    a: Pt,
    b: Pt,
    lines: readonly string[],
    on: { side: PlacedText['side']; plate: boolean },
    inset = LABEL_INSET,
    align = look.align,
  ): PlacedText | null => {
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;
    const angle = readingAngle(a, b);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const [start, end] = a.x * dx + a.y * dy <= b.x * dx + b.y * dy ? [a, b] : [b, a];
    const at =
      align === 'left'
        ? { x: start.x + dx * inset, y: start.y + dy * inset }
        : align === 'right'
          ? { x: end.x - dx * inset, y: end.y - dy * inset }
          : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return {
      ...at,
      angle,
      lines,
      font,
      lineHeight,
      align: align === 'left' ? 'start' : align === 'right' ? 'end' : 'center',
      side: on.side,
      gap: LABEL_GAP + d.width / 2,
      color: look.color ?? color,
      plate: on.plate ? { color: ground, alpha: 1 } : null,
    };
  };
  const wordsOnLine = (a: Pt, b: Pt, price: string | null = null, inset = LABEL_INSET) => {
    const side: PlacedText['side'] =
      look.position === 'above' ? 'above' : look.position === 'below' ? 'below' : 'middle';
    addWords(place(a, b, wordsOf(label, price), { side, plate: side === 'middle' }, inset));
  };
  const wordsOnBox = (x0: number, y0: number, x1: number, y1: number) => {
    const y = look.position === 'above' ? y0 : look.position === 'below' ? y1 : (y0 + y1) / 2;
    const side: PlacedText['side'] =
      look.position === 'above' ? 'above' : look.position === 'below' ? 'below' : 'middle';
    addWords(place({ x: x0, y }, { x: x1, y }, wordsOf(label, null), { side, plate: false }));
  };
  const addWords = (t: PlacedText | null) => {
    if (!t) return;
    shape.labelAt = textCentre(t, measure);
    if (t.lines.length > 0) shape.texts.push(t);
  };
  const levelSide: PlacedText['side'] =
    look.position === 'above' ? 'above' : look.position === 'below' ? 'below' : 'middle';
  const levelWords = (level: number, price: number | null): string =>
    [
      ...(look.showLevels ? [formatLevel(level)] : []),
      ...(look.showPrice && price !== null ? [axes.formatPrice(price)] : []),
    ].join('  ');
  const levelBands = (levels: readonly { level: number; price: number }[], from: number, to: number) => {
    let x0 = from;
    let x1 = to;
    if (d.extend === 'left' || d.extend === 'both') x0 = left;
    if (d.extend === 'right' || d.extend === 'both') x1 = right;
    const ys = levels.map((l) => axes.yOfPrice(l.price));
    for (let i = 1; i < ys.length; i++) {
      shape.fills.push({ pts: rectPts(x0, ys[i - 1]!, x1, ys[i]!), alpha: i % 2 ? 0.06 : 0.03 });
    }
    levels.forEach((l, i) => {
      const y = ys[i]!;
      const edge = l.level === 0 || l.level === 1;
      shape.lines.push({ a: { x: x0, y }, b: { x: x1, y }, alpha: edge ? 1 : 0.75 });
      const words = levelWords(l.level, l.price);
      if (!words) return;
      const t = place(
        { x: Math.max(x0, left), y },
        { x: Math.min(x1, right), y },
        [words],
        { side: levelSide, plate: levelSide === 'middle' },
        2,
      );
      if (t) shape.texts.push(t);
    });
    if (ys.length) shape.areas.push(rectPts(x0, Math.min(...ys), x1, Math.max(...ys)));
  };
  const [p0, p1, p2] = pts;
  const a0 = d.points[0];
  const a1 = d.points[1];
  const ok = (p: Pt | undefined, x = true, y = true): p is Pt =>
    !!p && (!x || Number.isFinite(p.x)) && (!y || Number.isFinite(p.y));
  const left = pane.x;
  const right = pane.x + pane.w;
  const handle = (i: number): Handle => ({ ...pts[i]!, t: i, p: i });
  switch (d.kind) {
    case 'trend_line':
    case 'ray':
    case 'extended_line': {
      if (!ok(p0) || !ok(p1)) return null;
      const seg = extendSegment(p0, p1, d.extend, pane);
      if (seg) shape.lines.push({ a: seg[0], b: seg[1] });
      shape.handles.push(handle(0), handle(1));
      shape.tags.push({ price: a0!.price, always: false }, { price: a1!.price, always: false });
      wordsOnLine(p0, p1);
      break;
    }
    case 'trend_angle': {
      if (!ok(p0) || !ok(p1)) return null;
      const seg = extendSegment(p0, p1, d.extend, pane);
      if (seg) shape.lines.push({ a: seg[0], b: seg[1] });
      shape.handles.push(handle(0), handle(1));
      shape.tags.push({ price: a0!.price, always: false }, { price: a1!.price, always: false });
      wordsOnLine(p0, p1);
      const degrees = screenAngle(p0, p1);
      if (!Number.isFinite(degrees)) break;
      const toward = p1.x >= p0.x ? 1 : -1;
      const radius = Math.min(ANGLE_ARC_MAX, Math.max(ANGLE_ARC_MIN, Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.35));
      const arm = Math.max(Math.abs(p1.x - p0.x), radius + 8);
      shape.lines.push({ a: p0, b: { x: p0.x + toward * arm, y: p0.y }, alpha: 0.5, dash: [3, 3] });
      const rad = (degrees * Math.PI) / 180;
      const arcAt = (k: number): Pt => {
        const th = (rad * k) / ANGLE_ARC_SEGMENTS;
        return { x: p0.x + toward * radius * Math.cos(th), y: p0.y - radius * Math.sin(th) };
      };
      for (let k = 0; k < ANGLE_ARC_SEGMENTS; k++) {
        shape.lines.push({ a: arcAt(k), b: arcAt(k + 1), alpha: 0.6, dash: [] });
      }
      const readout = formatAngle(degrees);
      const width = metrics.width(readout, false) + PAD_X * 2;
      const x = p0.x + toward * (radius + 4);
      shape.labels.push({
        x: toward > 0 ? x - PAD_X : x - width + PAD_X,
        y: degrees >= 0 ? p0.y + 1 : p0.y - 1,
        lines: [readout],
        align: 'left',
        anchor: degrees >= 0 ? 'top' : 'bottom',
        plate: 'none',
      });
      break;
    }
    case 'cross_line': {
      if (!ok(p0)) return null;
      shape.lines.push(
        { a: { x: left, y: p0.y }, b: { x: right, y: p0.y } },
        { a: { x: p0.x, y: pane.y }, b: { x: p0.x, y: pane.y + pane.h } },
      );
      shape.handles.push(handle(0));
      shape.tags.push({ price: a0!.price, always: true });
      wordsOnLine({ x: left, y: p0.y }, { x: right, y: p0.y }, priceOf(a0!.price), 8);
      break;
    }
    case 'horizontal_line': {
      if (!ok(p0, false)) return null;
      shape.lines.push({ a: { x: left, y: p0.y }, b: { x: right, y: p0.y } });
      const hx = Number.isFinite(p0.x) && p0.x > left && p0.x < right ? p0.x : left + pane.w / 2;
      shape.handles.push({ x: hx, y: p0.y, t: 0, p: 0 });
      shape.tags.push({ price: a0!.price, always: true });
      wordsOnLine({ x: left, y: p0.y }, { x: right, y: p0.y }, priceOf(a0!.price), 8);
      break;
    }
    case 'horizontal_ray': {
      if (!ok(p0)) return null;
      shape.lines.push({ a: p0, b: { x: Math.max(p0.x, right), y: p0.y } });
      shape.handles.push(handle(0));
      shape.tags.push({ price: a0!.price, always: true });
      wordsOnLine({ x: Math.max(p0.x, left), y: p0.y }, { x: right, y: p0.y }, priceOf(a0!.price));
      break;
    }
    case 'vertical_line': {
      if (!ok(p0, true, false)) return null;
      shape.lines.push({ a: { x: p0.x, y: pane.y }, b: { x: p0.x, y: pane.y + pane.h } });
      shape.handles.push({ x: p0.x, y: pane.y + pane.h / 2, t: 0, p: 0 });
      wordsOnLine({ x: p0.x, y: pane.y + pane.h }, { x: p0.x, y: pane.y }, null, 8);
      break;
    }
    case 'rectangle': {
      if (!ok(p0) || !ok(p1)) return null;
      let x0 = Math.min(p0.x, p1.x);
      let x1 = Math.max(p0.x, p1.x);
      if (d.extend === 'left' || d.extend === 'both') x0 = Math.min(x0, left);
      if (d.extend === 'right' || d.extend === 'both') x1 = Math.max(x1, right);
      const y0 = Math.min(p0.y, p1.y);
      const y1 = Math.max(p0.y, p1.y);
      const box = rectPts(x0, y0, x1, y1);
      shape.fills.push({ pts: box, alpha: 0.1 });
      for (let i = 0; i < 4; i++) shape.lines.push({ a: box[i]!, b: box[(i + 1) % 4]! });
      shape.areas.push(box);
      shape.handles.push(handle(0), handle(1), { x: p0.x, y: p1.y, t: 0, p: 1 }, { x: p1.x, y: p0.y, t: 1, p: 0 });
      shape.tags.push({ price: a0!.price, always: false }, { price: a1!.price, always: false });
      wordsOnBox(x0, y0, x1, y1);
      break;
    }
    case 'parallel_channel': {
      if (!ok(p0) || !ok(p1)) return null;
      const off = p2 && Number.isFinite(p2.x) ? channelOffset(d.points, axes) : 0;
      const dy = axes.yOfPrice(a0!.price + off) - p0.y;
      const q0 = { x: p0.x, y: p0.y + dy };
      const q1 = { x: p1.x, y: p1.y + dy };
      const base = extendSegment(p0, p1, d.extend, pane) ?? [p0, p1];
      const par = extendSegment(q0, q1, d.extend, pane) ?? [q0, q1];
      const mid0 = { x: (base[0].x + par[0].x) / 2, y: (base[0].y + par[0].y) / 2 };
      const mid1 = { x: (base[1].x + par[1].x) / 2, y: (base[1].y + par[1].y) / 2 };
      const body = [base[0], base[1], par[1], par[0]];
      shape.fills.push({ pts: body, alpha: 0.08 });
      shape.lines.push({ a: base[0], b: base[1] }, { a: par[0], b: par[1] });
      if (p2) shape.lines.push({ a: mid0, b: mid1, alpha: 0.5, dash: [4, 4] });
      shape.areas.push(body);
      shape.handles.push(handle(0), handle(1));
      if (p2) shape.handles.push({ ...q0, t: 0, p: 2, offset: true }, { ...q1, t: 1, p: 2, offset: true });
      {
        const upper = (p0.y + p1.y) / 2 <= (q0.y + q1.y) / 2;
        const [hi0, hi1, lo0, lo1] = upper ? [p0, p1, q0, q1] : [q0, q1, p0, p1];
        if (look.position === 'on') {
          const m0 = { x: (p0.x + q0.x) / 2, y: (p0.y + q0.y) / 2 };
          const m1 = { x: (p1.x + q1.x) / 2, y: (p1.y + q1.y) / 2 };
          addWords(place(m0, m1, wordsOf(label, null), { side: 'middle', plate: false }));
        } else if (look.position === 'above') wordsOnLine(hi0, hi1);
        else wordsOnLine(lo0, lo1);
      }
      break;
    }
    case 'fib_retracement': {
      if (!ok(p0) || !ok(p1)) return null;
      const levels = fibLevelPrices(a0!.price, a1!.price, d.levels ?? FIB_DEFAULT_LEVELS.fib_retracement);
      levelBands(levels, Math.min(p0.x, p1.x), Math.max(p0.x, p1.x));
      shape.lines.push({ a: p0, b: p1, alpha: 0.5, dash: [3, 3] });
      shape.handles.push(handle(0), handle(1));
      break;
    }
    case 'fib_extension': {
      if (!ok(p0) || !ok(p1)) return null;
      shape.lines.push({ a: p0, b: p1, alpha: 0.5, dash: [3, 3] });
      shape.handles.push(handle(0), handle(1));
      if (!ok(p2)) break;
      const a2 = d.points[2]!;
      const levels = fibExtensionPrices(a0!.price, a1!.price, a2.price, d.levels ?? FIB_DEFAULT_LEVELS.fib_extension);
      const span = Math.abs(p1.x - p0.x) || Math.abs(p2.x - p1.x);
      levelBands(levels, p2.x, p2.x + span);
      shape.lines.push({ a: p1, b: p2, alpha: 0.5, dash: [3, 3] });
      shape.handles.push(handle(2));
      break;
    }
    case 'fib_fan': {
      if (!ok(p0) || !ok(p1)) return null;
      const levels = fibFanPrices(a0!.price, a1!.price, d.levels ?? FIB_DEFAULT_LEVELS.fib_fan);
      const onward = d.extend === 'none' ? 'none' : p1.x >= p0.x ? 'right' : 'left';
      const room = Math.max(0, ...levels.map((l) => measure(font, levelWords(l.level, null)))) + 8;
      const rightward = p1.x >= p0.x ? p1.x + room <= right : p1.x - room < left;
      for (const l of levels) {
        const through = { x: p1.x, y: axes.yOfPrice(l.price) };
        const ray = extendSegment(p0, through, onward, pane);
        if (ray) shape.lines.push({ a: ray[0], b: ray[1], alpha: l.level === 1 ? 1 : 0.85 });
        const words = levelWords(l.level, null);
        if (!words) continue;
        const beyond = { x: through.x + (rightward ? 1 : -1), y: through.y };
        const t = place(through, beyond, [words], { side: 'middle', plate: true }, 4, rightward ? 'left' : 'right');
        if (t) shape.texts.push(t);
      }
      shape.lines.push({ a: p0, b: p1, alpha: 0.5, dash: [3, 3] });
      shape.handles.push(handle(0), handle(1));
      break;
    }
    case 'text': {
      if (!ok(p0)) return null;
      const lines = (d.text ?? '').split('\n');
      const label: ShapeLabel = {
        x: p0.x,
        y: p0.y,
        lines,
        align: 'left',
        anchor: 'top',
        plate: 'ground',
        note: true,
      };
      shape.labels.push(label);
      const r = labelRect(label, metrics);
      shape.areas.push(rectPts(r.x, r.y, r.x + r.w, r.y + r.h));
      break;
    }
    case 'price_range':
    case 'date_range':
    case 'measure': {
      if (!ok(p0) || !ok(p1)) return null;
      const x0 = Math.min(p0.x, p1.x);
      const x1 = Math.max(p0.x, p1.x);
      const y0 = Math.min(p0.y, p1.y);
      const y1 = Math.max(p0.y, p1.y);
      const s = measureStats(
        { price: a0!.price, t: a0!.t, index: axes.indexOfTime(a0!.t) },
        { price: a1!.price, t: a1!.t, index: axes.indexOfTime(a1!.t) },
        axes.tick,
      );
      const up = s.dPrice >= 0;
      const tint = d.kind === 'measure' ? (up ? o.upColor : o.downColor) : undefined;
      const box = rectPts(x0, y0, x1, y1);
      shape.fills.push({ pts: box, alpha: 0.12, ...(tint ? { color: tint } : {}) });
      shape.areas.push(box);
      if (d.kind !== 'measure') wordsOnBox(x0, y0, x1, y1);
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      const priceLine = `${signed(axes.formatPrice(s.dPrice), s.dPrice)}${Number.isFinite(s.ticks) ? ` (${signed(String(s.ticks), s.ticks)})` : ''}${Number.isFinite(s.pct) ? `  ${signed(s.pct.toFixed(2), s.pct)}%` : ''}`;
      const timeLine = `${String(Math.abs(s.bars))} bar${Math.abs(s.bars) === 1 ? '' : 's'}, ${formatDuration(Math.abs(s.ms))}`;
      if (d.kind !== 'date_range') {
        shape.lines.push({ a: { x: mx, y: p0.y }, b: { x: mx, y: p1.y }, arrow: true });
        shape.lines.push({ a: { x: x0, y: p0.y }, b: { x: x1, y: p0.y }, alpha: 0.6 });
        shape.lines.push({ a: { x: x0, y: p1.y }, b: { x: x1, y: p1.y }, alpha: 0.6 });
      }
      if (d.kind !== 'price_range') {
        shape.lines.push({ a: { x: p0.x, y: my }, b: { x: p1.x, y: my }, arrow: true });
        shape.lines.push({ a: { x: p0.x, y: y0 }, b: { x: p0.x, y: y1 }, alpha: 0.6 });
        shape.lines.push({ a: { x: p1.x, y: y0 }, b: { x: p1.x, y: y1 }, alpha: 0.6 });
      }
      const lines =
        d.kind === 'price_range' ? [priceLine] : d.kind === 'date_range' ? [timeLine] : [priceLine, timeLine];
      const below = d.kind === 'date_range' ? true : !up;
      shape.labels.push({
        x: mx,
        y: below ? y1 + 6 : y0 - 6,
        lines,
        align: 'center',
        anchor: below ? 'top' : 'bottom',
        plate: 'fill',
        ...(tint ? { color: tint } : {}),
      });
      shape.handles.push(handle(0), handle(1));
      break;
    }
    case 'profile_range':
    case 'profile_anchored': {
      const end = d.kind === 'profile_anchored' ? { x: Math.max(axes.lastBarX, p0?.x ?? Number.NaN), y: 0 } : p1;
      if (!ok(p0, true, false) || !ok(end, true, false)) return null;
      const half = axes.barSpacing / 2;
      const xa = Math.min(p0.x, end.x) - half;
      const xb = Math.max(p0.x, end.x) + half;
      const top = pane.y;
      const bottom = pane.y + pane.h;
      shape.fills.push({ pts: rectPts(xa, top, xb, bottom), alpha: 0.04 });
      shape.lines.push(
        { a: { x: xa, y: top }, b: { x: xa, y: bottom }, alpha: 0.35, dash: [2, 3] },
        { a: { x: xb, y: top }, b: { x: xb, y: bottom }, alpha: 0.35, dash: [2, 3] },
      );
      break;
    }
  }
  for (const l of shape.labels) if (l.plate === 'fill') keepInside(l, metrics, pane);
  for (const t of shape.texts) shape.areas.push(textCorners(t, measure));
  if (!takesWords(d.kind)) shape.labelAt = null;
  shape.box = boundsOf(shape, metrics, pane, measure);
  return shape;
}

function wordsOf(label: DrawingLabelSpec | null, price: string | null): string[] {
  const text = label?.text ?? '';
  const lines = text === '' ? [] : text.split('\n');
  if (price === null || !label?.showPrice) return lines;
  if (lines.length === 0) return [price];
  return [...lines.slice(0, -1), `${lines[lines.length - 1]!}  ${price}`];
}

export function measureOf(m: LabelMetrics): MeasureText {
  if (m.text) return (font, text) => m.text!(font, text);
  return (font, text) => {
    const px = /(\d+(?:\.\d+)?)px/.exec(font);
    return text.length * (px ? Number(px[1]) : 12) * 0.55;
  };
}

function keepInside(l: ShapeLabel, m: LabelMetrics, pane: Rect): void {
  const r = labelRect(l, m);
  if (r.x < pane.x + 2) l.x += pane.x + 2 - r.x;
  else if (r.x + r.w > pane.x + pane.w - 2) l.x -= r.x + r.w - (pane.x + pane.w - 2);
  if (r.y < pane.y + 2) {
    l.y = Math.max(l.y, pane.y + 2);
    l.anchor = 'top';
  } else if (r.y + r.h > pane.y + pane.h - 2) {
    l.y = Math.min(l.y, pane.y + pane.h - 2);
    l.anchor = 'bottom';
  }
}

function boundsOf(s: Shape, m: LabelMetrics, pane: Rect, measure: MeasureText): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: Pt) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  };
  for (const l of s.lines) {
    add(l.a);
    add(l.b);
  }
  for (const h of s.handles) add(h);
  for (const l of s.labels) {
    const r = labelRect(l, m);
    add({ x: r.x, y: r.y });
    add({ x: r.x + r.w, y: r.y + r.h });
  }
  for (const t of s.texts) for (const c of textCorners(t, measure)) add(c);
  if (x0 > x1) return { x: pane.x, y: pane.y, w: 0, h: 0 };
  const cx0 = Math.max(pane.x, x0);
  const cy0 = Math.max(pane.y, y0);
  const cx1 = Math.min(pane.x + pane.w, x1);
  const cy1 = Math.min(pane.y + pane.h, y1);
  return { x: cx0, y: cy0, w: Math.max(0, cx1 - cx0), h: Math.max(0, cy1 - cy0) };
}

export const HIT_PX = 6;

export interface ShapeHit {
  id: string;
  handle: number | null;
  distance: number;
}

export function hitShape(s: Shape, x: number, y: number, handles: boolean, m: LabelMetrics): ShapeHit | null {
  const p = { x, y };
  if (handles) {
    for (let i = 0; i < s.handles.length; i++) {
      const h = s.handles[i]!;
      if (Math.abs(h.x - x) <= HIT_PX && Math.abs(h.y - y) <= HIT_PX) return { id: s.id, handle: i, distance: 0 };
    }
  }
  let best = Infinity;
  for (const l of s.lines) best = Math.min(best, distToSegment(p, l.a, l.b));
  if (best <= HIT_PX) return { id: s.id, handle: null, distance: best };
  for (const a of s.areas) if (inPolygon(p, a)) return { id: s.id, handle: null, distance: HIT_PX };
  for (const l of s.labels) {
    if (l.plate === 'none') continue;
    const r = labelRect(l, m);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { id: s.id, handle: null, distance: HIT_PX };
  }
  return null;
}
