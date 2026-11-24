import type { Ctx2D, RenderContext } from '../layers/types.ts';
import { dashOf } from '../indicators/types.ts';
import { crispStroke, font, isLight } from '../render/draw.ts';
import { drawPlacedText } from '../render/label.ts';
import { labelRect, measureOf, type LabelMetrics, type Shape, type ShapeLabel } from './shape.ts';
import type { DrawingSpec } from './types.ts';

export interface DrawState {
  hovered: boolean;
  selected: boolean;
  preview: boolean;
}

export function labelFont(rc: Pick<RenderContext, 'theme'>, note: boolean): string {
  return note ? font(rc.theme.fontSize + 2, rc.theme.font, 500) : font(rc.theme.fontSize, rc.theme.font, 500);
}

export function lineHeightOf(rc: Pick<RenderContext, 'theme'>, note: boolean): number {
  return Math.round((note ? rc.theme.fontSize + 2 : rc.theme.fontSize) * 1.45);
}

export function drawShape(rc: RenderContext, d: DrawingSpec, s: Shape, st: DrawState, m: LabelMetrics): void {
  const { ctx } = rc;
  ctx.save();
  if (st.preview) ctx.globalAlpha = 0.85;
  const base = ctx.globalAlpha;
  for (const f of s.fills) {
    if (f.pts.length < 3) continue;
    ctx.globalAlpha = base * f.alpha;
    ctx.fillStyle = f.color ?? s.color;
    ctx.beginPath();
    ctx.moveTo(f.pts[0]!.x, f.pts[0]!.y);
    for (let i = 1; i < f.pts.length; i++) ctx.lineTo(f.pts[i]!.x, f.pts[i]!.y);
    ctx.closePath();
    ctx.fill();
  }
  const width = d.width;
  const dash = dashOf(d.dash, width);
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  for (const l of s.lines) {
    ctx.globalAlpha = base * (l.alpha ?? 1);
    ctx.strokeStyle = s.color;
    ctx.setLineDash(l.dash ? [...l.dash] : dash);
    ctx.beginPath();
    const flatY = l.a.y === l.b.y;
    const flatX = l.a.x === l.b.x;
    const ay = flatY ? crispStroke(l.a.y, width, rc.dpr) : l.a.y;
    const by = flatY ? ay : l.b.y;
    const ax = flatX ? crispStroke(l.a.x, width, rc.dpr) : l.a.x;
    const bx = flatX ? ax : l.b.x;
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    if (l.arrow) arrowHead(ctx, l.a.x, l.a.y, l.b.x, l.b.y, s.color);
  }
  ctx.globalAlpha = base;
  ctx.setLineDash([]);
  for (const l of s.labels) drawLabel(rc, l, s.color, m);
  if (s.texts.length) {
    const measure = measureOf(m);
    for (const t of s.texts) drawPlacedText(ctx, t, measure);
  }
  if (st.selected || st.hovered || st.preview) drawHandles(rc, s, st.selected && !d.locked);
  if (st.selected && d.kind === 'text') {
    const r = s.box;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
  }
  ctx.restore();
}

function arrowHead(ctx: Ctx2D, ax: number, ay: number, bx: number, by: number, color: string): void {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 12) return;
  const ang = Math.atan2(by - ay, bx - ax);
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - 7 * Math.cos(ang - 0.45), by - 7 * Math.sin(ang - 0.45));
  ctx.lineTo(bx - 7 * Math.cos(ang + 0.45), by - 7 * Math.sin(ang + 0.45));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawLabel(rc: RenderContext, l: ShapeLabel, color: string, m: LabelMetrics): void {
  const { ctx, theme } = rc;
  const note = l.note === true;
  const r = labelRect(l, m);
  const lh = m.lineHeight(note);
  const c = l.color ?? color;
  ctx.save();
  if (l.plate === 'fill') {
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = c;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
  } else if (l.plate === 'ground') {
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = theme.background;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
  }
  ctx.font = labelFont(rc, note);
  ctx.textBaseline = 'middle';
  ctx.textAlign = l.align === 'center' ? 'center' : 'left';
  ctx.fillStyle = l.plate === 'fill' ? (isLight(c) ? theme.background : theme.text) : c;
  const x = l.align === 'center' ? r.x + r.w / 2 : l.plate === 'none' ? r.x : r.x + 6;
  for (let i = 0; i < l.lines.length; i++) ctx.fillText(l.lines[i]!, x, r.y + 3 + lh * i + lh / 2 + 0.5);
  ctx.restore();
}

function drawHandles(rc: RenderContext, s: Shape, solid: boolean): void {
  const { ctx, theme } = rc;
  const color = theme.handles ?? s.color;
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  for (const h of s.handles) {
    if (!Number.isFinite(h.x) || !Number.isFinite(h.y)) continue;
    const x = Math.round(h.x) - 3.5;
    const y = Math.round(h.y) - 3.5;
    ctx.fillStyle = solid ? color : theme.background;
    ctx.fillRect(x, y, 7, 7);
    ctx.strokeStyle = solid ? theme.background : color;
    ctx.strokeRect(x + 0.5, y + 0.5, 6, 6);
  }
  ctx.restore();
}
