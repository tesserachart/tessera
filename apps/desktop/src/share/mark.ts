import { TOKENS } from '@tessera/ui';
import wordmark from '@tessera/ui/brand/wordmark-text.svg';
import type { Stamp } from '../feedback/capture.ts';

export const WORDMARK_VIEWBOX = { width: 327.379, height: 101.224 };

const MARK_MIN_PX = 9;
const MARK_MAX_PX = 14;
const MARK_SHARE_OF_SHORT_SIDE = 0.022;
const MARK_ALPHA = 0.55;
const LIGHT_GROUND = 0.55;
export const LIGHT_INK = TOKENS.mist;
export const DARK_INK = TOKENS.ink;

export interface MarkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function markBox(canvasWidth: number, canvasHeight: number, scale: number): MarkBox {
  const shortSide = Math.min(canvasWidth, canvasHeight) / scale;
  const cssHeight = Math.min(MARK_MAX_PX, Math.max(MARK_MIN_PX, shortSide * MARK_SHARE_OF_SHORT_SIDE));
  const height = Math.round(cssHeight * scale);
  const width = Math.round((height * WORDMARK_VIEWBOX.width) / WORDMARK_VIEWBOX.height);
  return { x: canvasWidth - height - width, y: canvasHeight - 2 * height, width, height };
}

export function inkOn(pixels: ArrayLike<number>): string {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 2 < pixels.length; i += 4) {
    sum += 0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
    count += 1;
  }
  return count > 0 && sum / count / 255 > LIGHT_GROUND ? DARK_INK : LIGHT_INK;
}

let loaded: Promise<HTMLImageElement> | null = null;

function wordmarkImage(): Promise<HTMLImageElement> {
  loaded ??= new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('the wordmark could not be loaded'));
    image.src = wordmark;
  }).catch((error: unknown) => {
    loaded = null;
    throw error;
  });
  return loaded;
}

function groundUnder(ctx: CanvasRenderingContext2D, box: MarkBox): string {
  try {
    return inkOn(ctx.getImageData(box.x, box.y, box.width, box.height).data);
  } catch {
    return LIGHT_INK;
  }
}

export const stampMark: Stamp = async (canvas, scale) => {
  const ctx = canvas.getContext('2d');
  const image = await wordmarkImage().catch(() => null);
  if (!ctx || !image) return;
  const box = markBox(canvas.width, canvas.height, scale);
  if (box.x < 0 || box.y < 0) return;
  const inked = document.createElement('canvas');
  inked.width = box.width;
  inked.height = box.height;
  const ink = inked.getContext('2d');
  if (!ink) return;
  ink.drawImage(image, 0, 0, box.width, box.height);
  ink.globalCompositeOperation = 'source-in';
  ink.fillStyle = groundUnder(ctx, box);
  ink.fillRect(0, 0, box.width, box.height);
  ctx.save();
  ctx.globalAlpha = MARK_ALPHA;
  ctx.drawImage(inked, box.x, box.y);
  ctx.restore();
};
