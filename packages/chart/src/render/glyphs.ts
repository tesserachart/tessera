import type { CanvasLike } from '../engine.ts';
import { MINUS } from '../format.ts';
import type { Ctx2D } from '../layers/types.ts';

export const GLYPHS = `0123456789,.${MINUS}+k×`;

export interface GlyphAtlasOptions {
  createCanvas(width: number, height: number): CanvasLike;
  family: string;
  size: number;
  colors: readonly string[];
  weights?: readonly number[];
  dpr: number;
  cacheBytes?: number;
}

export const GLYPH_CACHE_BYTES = 6 * 1024 * 1024;
const CACHE_W = 2048;

interface AtlasContext {
  font: string;
  fillStyle: unknown;
  textBaseline: string;
  textAlign: string;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number; actualBoundingBoxAscent?: number; actualBoundingBoxDescent?: number };
  clearRect(x: number, y: number, w: number, h: number): void;
}

export type GlyphAlign = 'left' | 'right' | 'center';

const CODE_LIMIT = Math.max(...Array.from(GLYPHS, (c) => c.charCodeAt(0))) + 1;

export class GlyphAtlas {
  readonly canvas: CanvasLike;
  readonly dpr: number;
  readonly size: number;
  readonly digit: number;
  readonly height: number;
  private readonly cellW: number;
  private readonly cellH: number;
  private readonly pad: number;
  private readonly inkTop: number;
  private readonly inkH: number;
  private readonly colors: number;
  private readonly weights: number;
  private readonly column = new Int8Array(CODE_LIMIT).fill(-1);
  private readonly advance: Float32Array;
  private readonly inset: Float32Array;
  private readonly cache: CanvasLike | null;
  private readonly cacheCtx: Ctx2D | null;
  private readonly entries: Map<string, number>[] = [];
  private entryX = new Uint16Array(256);
  private entryW = new Uint16Array(256);
  private entryShelf = new Uint16Array(256);
  private entryCss = new Float32Array(256);
  private entryCount = 0;
  private shelfX = 0;
  private shelfY = 0;
  private full = false;
  private hits = 0;
  private misses = 0;

  constructor(o: GlyphAtlasOptions) {
    const dpr = Math.max(1, o.dpr);
    const weights = o.weights ?? [400, 600];
    this.dpr = dpr;
    this.size = o.size;
    this.colors = o.colors.length;
    this.weights = weights.length;
    const chars = GLYPHS.split('');
    this.advance = new Float32Array(chars.length);
    this.inset = new Float32Array(chars.length);
    const scratch = o.createCanvas(4, 4).getContext('2d') as AtlasContext;
    const fontAt = (w: number, px: number) => `${String(w)} ${String(px)}px ${o.family}`;
    let digit = 0;
    const widths = chars.map((ch) => {
      let w = 0;
      for (const weight of weights) {
        scratch.font = fontAt(weight, this.size);
        w = Math.max(w, scratch.measureText(ch).width);
      }
      return w;
    });
    chars.forEach((ch, k) => {
      if (ch >= '0' && ch <= '9') digit = Math.max(digit, widths[k]!);
    });
    this.digit = digit;
    chars.forEach((ch, k) => {
      const isDigit = ch >= '0' && ch <= '9';
      this.advance[k] = isDigit ? digit : widths[k]!;
      this.inset[k] = isDigit ? (digit - widths[k]!) / 2 : 0;
      this.column[ch.charCodeAt(0)] = k;
    });
    this.pad = 1;
    const maxW = Math.max(...widths);
    this.cellW = Math.ceil(maxW * dpr) + 2 * this.pad;
    this.cellH = Math.ceil(this.size * 1.3 * dpr);
    this.height = this.cellH / dpr;
    this.canvas = o.createCanvas(this.cellW * chars.length, this.cellH * this.colors * this.weights);
    const ctx = this.canvas.getContext('2d') as AtlasContext;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let wi = 0; wi < this.weights; wi++) {
      ctx.font = fontAt(weights[wi]!, this.size * dpr);
      for (let ci = 0; ci < this.colors; ci++) {
        ctx.fillStyle = o.colors[ci]!;
        const y = (wi * this.colors + ci) * this.cellH + this.cellH / 2;
        chars.forEach((ch, k) => {
          ctx.fillText(ch, k * this.cellW + this.pad, y);
        });
      }
    }
    let ascent = 0;
    let descent = 0;
    scratch.textBaseline = 'middle';
    for (const weight of weights) {
      scratch.font = fontAt(weight, this.size * dpr);
      const m = scratch.measureText(GLYPHS);
      ascent = Math.max(ascent, m.actualBoundingBoxAscent ?? 0);
      descent = Math.max(descent, m.actualBoundingBoxDescent ?? 0);
    }
    const inkTop = ascent > 0 ? Math.max(0, Math.floor(this.cellH / 2 - ascent) - 1) : 0;
    const inkBottom = ascent > 0 ? Math.min(this.cellH, Math.ceil(this.cellH / 2 + descent) + 1) : this.cellH;
    this.inkTop = inkTop;
    this.inkH = Math.max(1, inkBottom - inkTop);
    const cacheBytes = o.cacheBytes ?? GLYPH_CACHE_BYTES;
    const shelves = Math.floor(cacheBytes / 4 / CACHE_W / this.inkH);
    this.cache = shelves > 0 ? o.createCanvas(CACHE_W, shelves * this.inkH) : null;
    this.cacheCtx = this.cache ? (this.cache.getContext('2d') as Ctx2D) : null;
  }

  beginFrame(): void {
    if (this.full && this.misses > this.hits) this.resetCache();
    this.hits = 0;
    this.misses = 0;
  }

  private resetCache(): void {
    for (const m of this.entries) m.clear();
    this.entryCount = 0;
    this.shelfX = 0;
    this.shelfY = 0;
    this.full = false;
    if (this.cache && this.cacheCtx) {
      this.cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.cacheCtx.clearRect(0, 0, this.cache.width, this.cache.height);
    }
  }

  get cached(): number {
    return this.entryCount;
  }

  holds(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= CODE_LIMIT || this.column[c]! < 0) return false;
    }
    return true;
  }

  measure(text: string): number {
    let w = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const k = c < CODE_LIMIT ? this.column[c]! : -1;
      w += k >= 0 ? this.advance[k]! : this.digit;
    }
    return w;
  }

  /** Writing to the cache makes the next blit from it copy the whole bitmap. */
  draw(
    ctx: Ctx2D,
    text: string,
    x: number,
    y: number,
    align: GlyphAlign,
    color = 0,
    weight = 0,
    reusable = true,
  ): void {
    const dpr = this.dpr;
    const row = Math.min(weight, this.weights - 1) * this.colors + Math.min(color, this.colors - 1);
    const dh = this.cellH / dpr;
    // a blit between device pixels blurs the figure
    const dy = Math.round((y - dh / 2) * dpr) / dpr;
    if (text.length > 1 && this.cache) {
      const map = (this.entries[row] ??= new Map());
      const e = map.get(text) ?? (reusable ? this.compose(map, text, row) : undefined);
      if (e !== undefined) {
        this.hits++;
        const width = this.entryCss[e]!;
        const left = align === 'left' ? x : align === 'right' ? x - width : x - width / 2;
        const w = this.entryW[e]!;
        const dx = Math.round(left * dpr - this.pad) / dpr;
        ctx.drawImage(
          this.cache as unknown as CanvasImageSource,
          this.entryX[e]!,
          this.entryShelf[e]! * this.inkH,
          w,
          this.inkH,
          dx,
          dy + this.inkTop / dpr,
          w / dpr,
          this.inkH / dpr,
        );
        return;
      }
      if (reusable) this.misses++;
    }
    const width = align === 'left' ? 0 : this.measure(text);
    const left = align === 'left' ? x : align === 'right' ? x - width : x - width / 2;
    this.blitGlyphs(ctx, text, left, dy, row);
  }

  private blitGlyphs(ctx: Ctx2D, text: string, left: number, top: number, row: number): void {
    const scale = this.dpr;
    const sy = row * this.cellH + this.inkTop;
    const dw = this.cellW / scale;
    const dh = this.inkH / scale;
    const pad = this.pad / scale;
    const dy = top + this.inkTop / scale;
    let cx = left;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const k = c < CODE_LIMIT ? this.column[c]! : -1;
      if (k < 0) {
        cx += this.digit;
        continue;
      }
      const dx = Math.round((cx + this.inset[k]! - pad) * scale) / scale;
      ctx.drawImage(
        this.canvas as unknown as CanvasImageSource,
        k * this.cellW,
        sy,
        this.cellW,
        this.inkH,
        dx,
        dy,
        dw,
        dh,
      );
      cx += this.advance[k]!;
    }
  }

  private compose(map: Map<string, number>, text: string, row: number): number | undefined {
    const width = this.measure(text);
    const e = this.allocate(width);
    if (e === undefined) return undefined;
    this.blitGlyphs(this.cacheCtx!, text, (this.entryX[e]! + this.pad) / this.dpr, this.shelfTop(e), row);
    map.set(text, e);
    return e;
  }

  private shelfTop(e: number): number {
    return (this.entryShelf[e]! * this.inkH - this.inkTop) / this.dpr;
  }

  private allocate(width: number): number | undefined {
    const cache = this.cache;
    const cctx = this.cacheCtx;
    if (!cache || !cctx || this.full) return undefined;
    const w = Math.ceil(width * this.dpr) + 2 * this.pad + 1;
    if (w > cache.width) return undefined;
    if (this.shelfX + w > cache.width) {
      this.shelfX = 0;
      this.shelfY++;
    }
    if ((this.shelfY + 1) * this.inkH > cache.height) {
      this.full = true;
      return undefined;
    }
    cctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const e = this.entryCount++;
    if (e === this.entryX.length) {
      const grow = <T extends Uint16Array | Float32Array>(a: T, make: (n: number) => T): T => {
        const b = make(a.length * 2);
        b.set(a);
        return b;
      };
      this.entryX = grow(this.entryX, (n) => new Uint16Array(n));
      this.entryW = grow(this.entryW, (n) => new Uint16Array(n));
      this.entryShelf = grow(this.entryShelf, (n) => new Uint16Array(n));
      this.entryCss = grow(this.entryCss, (n) => new Float32Array(n));
    }
    this.entryX[e] = this.shelfX;
    this.entryW[e] = w;
    this.entryShelf[e] = this.shelfY;
    this.entryCss[e] = width;
    this.shelfX += w;
    return e;
  }

  get bytes(): number {
    return this.canvas.width * this.canvas.height * 4;
  }

  get cacheBytes(): number {
    return this.cache ? this.cache.width * this.cache.height * 4 : 0;
  }
}

export function formatCount(v: number, signed = false): string {
  if (!Number.isFinite(v)) return '';
  const neg = v < 0;
  const a = Math.abs(v);
  let body: string;
  if (a >= 10_000) {
    const k = a / 1000;
    body = k >= 100 ? group(Math.round(k)) : (Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, '');
    body += 'k';
  } else if (Number.isInteger(a)) {
    body = group(a);
  } else {
    const d = a < 10 ? 2 : a < 100 ? 1 : 0;
    body = d === 0 ? group(Math.round(a)) : a.toFixed(d).replace(/\.?0+$/, '');
  }
  if (body === '0' || body === '0k') return '0';
  return neg ? `${MINUS}${body}` : signed ? `+${body}` : body;
}

function group(n: number): string {
  const s = String(n);
  if (n < 1000) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i]!;
  }
  return out;
}
