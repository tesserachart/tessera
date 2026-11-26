import { createContext, domToForeignObjectSvg } from 'modern-screenshot';
import { freeze, type Frozen } from './freeze.ts';
import type { Screenshot } from './model.ts';
import { nextFrame, timeSlicer } from './pace.ts';
import { classify, defaultsIn, drawnProperties, slimmer, slimPseudoRules } from './slim.ts';
import { drawTiles } from './tiles.ts';

export const LEFT_OUT_ATTR = 'data-feedback-leave-out';

const LEFT_OUT = `[${LEFT_OUT_ATTR}], .t-scrim, .ui-dialog-overlay`;

const MAX_PNG_BYTES = 5 * 1024 * 1024;

const JPEG_QUALITY = 0.85;

const PREVIEW_WIDTH = 960;

const MASK = '••••';

// eslint-disable-next-line no-control-regex
const XML_UNSAFE = /[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF￾￿]/gu;

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

export function maskText(text: string, words: readonly string[]): string {
  let out = text;
  for (const w of words) if (out.includes(w)) out = out.split(w).join(MASK);
  return out;
}

export function xmlSafe(text: string): string {
  return text.replace(XML_UNSAFE, '');
}

export function cleanClone(cloned: Node, words: readonly string[]): void {
  if (!(cloned instanceof Element)) return;
  for (const child of cloned.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent) {
      child.textContent = xmlSafe(maskText(child.textContent, words));
    }
  }
  if (cloned instanceof HTMLInputElement || cloned instanceof HTMLTextAreaElement) {
    cloned.value = xmlSafe(maskText(cloned.value, words));
  }
  for (const a of cloned.attributes) {
    const clean = xmlSafe(maskText(a.value, words));
    if (clean !== a.value) a.value = clean;
  }
}

function loadedSandbox(): Promise<HTMLIFrameElement> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute(LEFT_OUT_ATTR, '');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.width = '0';
    frame.height = '0';
    frame.style.cssText = 'position:fixed;visibility:hidden;border:0;';
    frame.addEventListener('load', () => resolve(frame), { once: true });
    frame.srcdoc = '<!DOCTYPE html><meta charset="UTF-8"><title></title><body>';
    document.body.appendChild(frame);
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

function shrunk(canvas: HTMLCanvasElement, width: number): HTMLCanvasElement {
  if (canvas.width <= width) return canvas;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.max(1, Math.round((canvas.height * width) / canvas.width));
  const ctx = out.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('the picture could not be read'));
    reader.onerror = () => reject(reader.error ?? new Error('the picture could not be read'));
    reader.readAsDataURL(blob);
  });
}

export type Stamp = (canvas: HTMLCanvasElement, scale: number) => Promise<void> | void;

export async function captureWindow(
  words: readonly string[],
  root: HTMLElement = document.body,
  alsoLeftOut: readonly string[] = [],
  stamp?: Stamp,
): Promise<Screenshot> {
  const width = root.clientWidth || window.innerWidth;
  const height = root.clientHeight || window.innerHeight;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const background = getComputedStyle(document.body).backgroundColor || null;
  const slice = timeSlicer();
  const properties = drawnProperties();
  const sandbox = await loadedSandbox();
  let frozen: Frozen | null = null;
  try {
    const leftOut = [LEFT_OUT, ...alsoLeftOut].join(', ');
    frozen = await freeze(root, { width, height, leftOut, properties, slice });
    const defaults = defaultsIn(sandbox);
    const slim = slimmer(defaults);
    const context = await createContext(frozen.root, {
      width,
      height,
      scale,
      backgroundColor: background,
      features: { removeControlCharacter: false },
      includeStyleProperties: properties,
      style: { transform: 'none' },
      autoDestruct: true,
      onCloneEachNode: (cloned: Node) => {
        cleanClone(cloned, words);
        slim.children(cloned);
        return slice();
      },
      onCloneNode: async (clone: Node) => {
        const pseudo = context.svgStyleElement?.lastChild;
        if (pseudo && context.svgStyles.size > 0 && clone instanceof Element) {
          pseudo.textContent = await slimPseudoRules(context.svgStyles, clone, { slim, defaultsOf: defaults, slice });
        }
      },
    });
    context.sandbox = sandbox;
    const svg = (await domToForeignObjectSvg(context)) as SVGSVGElement;
    const { boxes } = frozen;
    frozen.thaw();
    frozen = null;
    const classes = await classify(svg, slice);
    const canvas = await drawTiles(svg, boxes, classes, { width, height, scale, background, slice });
    if (stamp) await stamp(canvas, scale);
    await nextFrame();
    let blob = await blobOf(canvas, 'image/png');
    if (blob.size > MAX_PNG_BYTES) blob = await blobOf(canvas, 'image/jpeg', JPEG_QUALITY);
    const url = await dataUrlOf(blob);
    const preview = await dataUrlOf(await blobOf(shrunk(canvas, PREVIEW_WIDTH), 'image/jpeg', JPEG_QUALITY));
    const type: Screenshot['type'] = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return { type, data: url.slice(url.indexOf(',') + 1), preview, width, height, bytes: blob.size };
  } finally {
    frozen?.thaw();
    sandbox.remove();
  }
}
