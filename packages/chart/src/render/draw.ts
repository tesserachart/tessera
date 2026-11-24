import type { AxisTag, Ctx2D } from '../layers/types.ts';

export function crisp(v: number, dpr: number): number {
  return (Math.round(v * dpr) + 0.5) / dpr;
}

export function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

export function oddDeviceWidth(width: number, dpr: number): boolean {
  return Math.round(width * dpr) % 2 === 1;
}

export function crispStroke(v: number, width: number, dpr: number): number {
  return snap(v, dpr) + (oddDeviceWidth(width, dpr) ? 0.5 / dpr : 0);
}

export function font(size: number, family: string, weight = 400): string {
  return `${String(weight)} ${String(size)}px ${family}`;
}

export class TextMeasurer {
  private readonly cache = new Map<string, number>();

  measure(ctx: Ctx2D, fontSpec: string, text: string): number {
    const key = `${fontSpec}|${text}`;
    let w = this.cache.get(key);
    if (w === undefined) {
      ctx.save();
      ctx.font = fontSpec;
      w = ctx.measureText(text).width;
      ctx.restore();
      if (this.cache.size > 4096) this.cache.clear();
      this.cache.set(key, w);
    }
    return w;
  }

  clear(): void {
    this.cache.clear();
  }
}

export function deOverlap(
  items: readonly { y: number; h: number; priority: number }[],
  minY: number,
  maxY: number,
  gap = 1,
): number[] {
  const n = items.length;
  const out = items.map((it) => it.y);
  if (n < 2) return out.map((y, i) => clampCentre(y, items[i]!.h, minY, maxY));
  const order = [...items.keys()].sort((a, b) => items[a]!.y - items[b]!.y);
  let moved = false;
  for (let iter = 0; iter < 100; iter++) {
    moved = false;
    for (let k = 1; k < n; k++) {
      const a = order[k - 1]!;
      const b = order[k]!;
      const need = (items[a]!.h + items[b]!.h) / 2 + gap;
      const d = out[b]! - out[a]!;
      if (d < need) {
        const push = need - d;
        const pa = items[a]!.priority;
        const pb = items[b]!.priority;
        if (pa > pb) out[b]! += push;
        else if (pb > pa) out[a]! -= push;
        else {
          out[a]! -= push / 2;
          out[b]! += push / 2;
        }
        moved = true;
      }
    }
    for (let k = 0; k < n; k++) out[k] = clampCentre(out[k]!, items[k]!.h, minY, maxY);
    if (!moved) break;
  }
  if (moved) {
    for (let k = 1; k < n; k++) {
      const a = order[k - 1]!;
      const b = order[k]!;
      const need = (items[a]!.h + items[b]!.h) / 2 + gap;
      if (out[b]! - out[a]! < need) out[b] = out[a]! + need;
    }
  }
  return out;
}

function clampCentre(y: number, h: number, minY: number, maxY: number): number {
  return Math.min(maxY - h / 2, Math.max(minY + h / 2, y));
}

export function colorChannels(color: string): [number, number, number, number] | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    const h = hex[1]!.length <= 4 ? hex[1]!.replace(/./g, (d) => d + d) : hex[1]!;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(c);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

export function isClear(color: string): boolean {
  if (color.trim().toLowerCase() === 'transparent') return true;
  const c = colorChannels(color);
  return c !== null && c[3] <= 0;
}

const INK_TEXT_LUMINANCE_SPLIT = 0.18;

export function isLight(color: string): boolean {
  const c = colorChannels(color);
  if (!c) return true;
  return relativeLuminance(c[0], c[1], c[2]) > INK_TEXT_LUMINANCE_SPLIT;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function drawAxisTag(
  ctx: Ctx2D,
  tag: AxisTag,
  x: number,
  cy: number,
  w: number,
  h: number,
  dpr: number,
  fontSpec: string,
  ink: string,
  textColor: string,
  background: string,
): void {
  const top = snap(cy - h / 2, dpr);
  ctx.save();
  if (tag.style === 'filled') {
    ctx.fillStyle = tag.color;
    ctx.fillRect(x, top, w, h);
  } else {
    ctx.fillStyle = background;
    ctx.fillRect(x, top, w, h);
    ctx.strokeStyle = tag.color;
    ctx.lineWidth = 1 / dpr;
    ctx.setLineDash(tag.dashed ? [3, 2] : []);
    ctx.strokeRect(crisp(x, dpr), crisp(top, dpr), w - 1 / dpr, h - 1 / dpr);
  }
  ctx.font = fontSpec;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = tag.style === 'filled' ? ink : tag.style === 'neutral' ? tag.color : textColor;
  if (tag.sub) {
    ctx.fillText(tag.text, x + 5, top + h / 4 + 0.5);
    ctx.fillText(tag.sub, x + 5, top + (3 * h) / 4);
  } else {
    ctx.fillText(tag.text, x + 5, top + h / 2 + 0.5);
  }
  ctx.restore();
}
