import { afterPaint } from '../app/onceShown.ts';
import type { Screenshot } from './model.ts';
import { encodePicture } from './encode.ts';
import { ABOVE_ATTR, copyPage, HIDDEN_ATTR, OUT_ATTR, readPage } from './page.ts';
import type { Painted, Rect } from './pixels.ts';
import { cssFor, dataUrlOf, pageCss } from './sheets.ts';

export { cleanClone, maskText, xmlSafe } from './page.ts';

export const LEFT_OUT_ATTR = 'data-feedback-leave-out';

const LEFT_OUT = `[${LEFT_OUT_ATTR}], .t-scrim, .ui-dialog-overlay`;

const ALL = (sel: string) => `${sel},${sel} *,${sel}::before,${sel}::after,${sel} *::before,${sel} *::after`;

const STILL = '*,*::before,*::after{animation:none!important;transition:none!important}';

const LEFT_OUT_RULE = `${ALL(`[${OUT_ATTR}]`)}{visibility:hidden!important}`;

const ONLY_ABOVE = [
  '*,*::before,*::after{visibility:hidden!important}',
  `${ALL(`[${ABOVE_ATTR}]`)}{visibility:visible!important}`,
  `[${HIDDEN_ATTR}],[${HIDDEN_ATTR}]::before,[${HIDDEN_ATTR}]::after{visibility:hidden!important}`,
  LEFT_OUT_RULE,
].join('\n');

export function privateWordsOf(
  accounts: readonly { id: string; displayName: string; externalRefMasked: string | null; environment: string }[],
  { paper = false }: { paper?: boolean } = {},
): string[] {
  const words = new Set<string>();
  for (const a of accounts) {
    if (a.environment === 'paper' && !paper) continue;
    for (const w of [a.id, a.displayName, a.externalRefMasked, a.id.split(':')[1]]) {
      const t = w?.trim();
      if (t && t.length >= 3) words.add(t);
    }
  }
  return [...words].sort((x, y) => y.length - x.length);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    afterPaint(resolve);
  });
}

export function blobOf(canvas: HTMLCanvasElement, type: Screenshot['type'], quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the picture could not be encoded'))),
      type,
      quality,
    );
  });
}

function xmlText(css: string): string {
  return css.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function pictureOf(markup: string, slot: string, css: string): Promise<HTMLImageElement> {
  const width = String(window.innerWidth);
  const height = String(window.innerHeight);
  const rem = getComputedStyle(document.documentElement).fontSize;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="font-size:${rem}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">${markup.replace(slot, () => xmlText(css))}</foreignObject></svg>`;
  const img = new Image();
  img.decoding = 'async';
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  return img;
}

function placed(shown: Rect, frame: Rect, scale: number) {
  return {
    x: (shown.left - frame.left) * scale,
    y: (shown.top - frame.top) * scale,
    w: (shown.right - shown.left) * scale,
    h: (shown.bottom - shown.top) * scale,
  };
}

function compose(
  ctx: CanvasRenderingContext2D,
  {
    under,
    over,
    painted,
    frame,
    scale,
  }: {
    under: HTMLImageElement;
    over: HTMLImageElement | null;
    painted: readonly Painted[];
    frame: Rect;
    scale: number;
  },
) {
  const { width, height } = ctx.canvas;
  const page = [frame.left, frame.top, frame.right - frame.left, frame.bottom - frame.top] as const;
  ctx.drawImage(under, ...page, 0, 0, width, height);
  for (const p of painted) {
    const at = placed(p.shown, frame, scale);
    ctx.drawImage(p.copy, 0, 0, p.copy.width, p.copy.height, at.x, at.y, at.w, at.h);
  }
  if (!over) return;
  ctx.save();
  ctx.beginPath();
  for (const p of painted) {
    const at = placed(p.shown, frame, scale);
    ctx.rect(at.x, at.y, at.w, at.h);
  }
  ctx.clip();
  ctx.drawImage(over, ...page, 0, 0, width, height);
  ctx.restore();
}

export type Stamp = (canvas: HTMLCanvasElement, scale: number) => Promise<void> | void;

export async function captureWindow(
  words: readonly string[],
  root: HTMLElement = document.body,
  alsoLeftOut: readonly string[] = [],
  stamp?: Stamp,
): Promise<Screenshot> {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const background = getComputedStyle(document.body).backgroundColor || null;
  const css = pageCss();
  const slot = `fb-css-${crypto.randomUUID()}`;
  const read = readPage(root, [LEFT_OUT, ...alsoLeftOut].join(', '));
  const { markup, classes } = copyPage(read, words, slot);
  const { frame, painted } = read;
  const width = Math.round(frame.right - frame.left);
  const height = Math.round(frame.bottom - frame.top);
  await nextFrame();
  const sheet = `${cssFor(await css, classes)}\n${STILL}\n${LEFT_OUT_RULE}`;
  const under = await pictureOf(markup, slot, sheet);
  await nextFrame();
  const over = read.above.size > 0 ? await pictureOf(markup, slot, `${sheet}\n${ONLY_ABOVE}`) : null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas to draw on');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  compose(ctx, { under, over, painted, frame, scale });
  if (stamp) await stamp(canvas, scale);
  const { full, preview } = await encodePicture(canvas);
  const url = await dataUrlOf(full);
  const previewUrl = await dataUrlOf(preview);
  const type: Screenshot['type'] = full.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return { type, data: url.slice(url.indexOf(',') + 1), preview: previewUrl, width, height, bytes: full.size };
}
