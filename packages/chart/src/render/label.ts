import type { Ctx2D } from '../layers/types.ts';

export interface TextLook {
  size: number;
  bold: boolean;
  italic: boolean;
  family: string;
}

const REGULAR = 500;
const BOLD = 700;

export function textFont(look: TextLook): string {
  return `${look.italic ? 'italic ' : ''}${String(look.bold ? BOLD : REGULAR)} ${String(look.size)}px ${look.family}`;
}

export function textLineHeight(size: number): number {
  return Math.round(size * 1.3);
}

export type MeasureText = (font: string, text: string) => number;

export const TEXT_PAD_X = 4;
export const TEXT_PAD_Y = 1;

export interface PlacedText {
  x: number;
  y: number;
  angle: number;
  lines: readonly string[];
  font: string;
  lineHeight: number;
  align: 'start' | 'center' | 'end';
  side: 'above' | 'middle' | 'below';
  gap: number;
  color: string;
  plate: { color: string; alpha: number } | null;
}

export interface TextPt {
  x: number;
  y: number;
}

export function textSize(t: Pick<PlacedText, 'lines' | 'font' | 'lineHeight'>, measure: MeasureText) {
  let w = 0;
  for (const line of t.lines) w = Math.max(w, measure(t.font, line));
  return { w: w + TEXT_PAD_X * 2, h: t.lines.length * t.lineHeight + TEXT_PAD_Y * 2 };
}

export function textFrame(t: PlacedText, measure: MeasureText): { x: number; y: number; w: number; h: number } {
  const { w, h } = textSize(t, measure);
  const x = t.align === 'start' ? 0 : t.align === 'end' ? -w : -w / 2;
  const y = t.side === 'above' ? -t.gap - h : t.side === 'below' ? t.gap : -h / 2;
  return { x, y, w, h };
}

function toScreen(t: PlacedText, lx: number, ly: number): TextPt {
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  return { x: t.x + lx * c - ly * s, y: t.y + lx * s + ly * c };
}

export function textCorners(t: PlacedText, measure: MeasureText): TextPt[] {
  const f = textFrame(t, measure);
  return [
    toScreen(t, f.x, f.y),
    toScreen(t, f.x + f.w, f.y),
    toScreen(t, f.x + f.w, f.y + f.h),
    toScreen(t, f.x, f.y + f.h),
  ];
}

export function textCentre(t: PlacedText, measure: MeasureText): TextPt {
  const f = textFrame(t, measure);
  return toScreen(t, f.x + f.w / 2, f.y + f.h / 2);
}

export function readingAngle(a: TextPt, b: TextPt): number {
  let ang = Math.atan2(b.y - a.y, b.x - a.x);
  if (ang > Math.PI / 2) ang -= Math.PI;
  else if (ang <= -Math.PI / 2) ang += Math.PI;
  if (Math.abs(Math.abs(ang) - Math.PI / 2) < 1e-9) ang = -Math.PI / 2;
  return ang;
}

export function drawPlacedText(ctx: Ctx2D, t: PlacedText, measure: MeasureText): void {
  if (t.lines.length === 0) return;
  const f = textFrame(t, measure);
  ctx.save();
  ctx.translate(t.x, t.y);
  if (t.angle !== 0) ctx.rotate(t.angle);
  if (t.plate) {
    ctx.globalAlpha = t.plate.alpha;
    ctx.fillStyle = t.plate.color;
    ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.globalAlpha = 1;
  }
  ctx.font = t.font;
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = t.align === 'start' ? 'left' : t.align === 'end' ? 'right' : 'center';
  const x = t.align === 'start' ? f.x + TEXT_PAD_X : t.align === 'end' ? f.x + f.w - TEXT_PAD_X : f.x + f.w / 2;
  for (let i = 0; i < t.lines.length; i++) {
    ctx.fillText(t.lines[i]!, x, f.y + TEXT_PAD_Y + t.lineHeight * i + t.lineHeight / 2 + 0.5);
  }
  ctx.restore();
}
