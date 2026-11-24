import type { Slice } from './pace.ts';
import { nextFrame } from './pace.ts';

const FROZEN_ATTR = 'data-feedback-frozen';

export const AT_ATTR = 'data-feedback-at';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  inline: boolean;
}

export interface Frozen {
  root: HTMLElement;
  boxes: Box[];
  thaw: () => void;
}

const STILL = `[${FROZEN_ATTR}], [${FROZEN_ATTR}] *, [${FROZEN_ATTR}] *::before, [${FROZEN_ATTR}] *::after { animation: none !important; transition: none !important; }`;

function snapshot(canvas: HTMLCanvasElement): Promise<Blob | null> {
  if (canvas.width === 0 || canvas.height === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, 'image/png');
    } catch {
      resolve(null);
    }
  });
}

function pinnedStyle(el: Element, properties: readonly string[]): string {
  const style = getComputedStyle(el);
  let css = '';
  for (const name of properties) {
    const value = style.getPropertyValue(name);
    if (value) css += `${name}:${value};`;
  }
  return css;
}

function canvasesToPictures(
  sources: readonly HTMLCanvasElement[],
  copies: readonly HTMLCanvasElement[],
  { leftOut, properties }: { leftOut: string; properties: readonly string[] },
): { picture: HTMLImageElement; blob: Promise<Blob | null> }[] {
  return copies.map((copy, i) => {
    const source = sources[i];
    const picture = document.createElement('img');
    for (const a of copy.attributes)
      if (a.name !== 'width' && a.name !== 'height' && a.name !== 'style') picture.setAttribute(a.name, a.value);
    picture.alt = '';
    if (source) picture.setAttribute('style', pinnedStyle(source, properties));
    copy.replaceWith(picture);
    return { picture, blob: !source || source.closest(leftOut) ? Promise.resolve(null) : snapshot(source) };
  });
}

async function fillPictures(pictures: ReturnType<typeof canvasesToPictures>, urls: string[], slice: Slice) {
  for (const { picture, blob } of pictures) {
    const shot = await blob;
    if (!shot) continue;
    const url = URL.createObjectURL(shot);
    urls.push(url);
    picture.src = url;
    await picture.decode().catch(() => undefined);
    await slice();
  }
}

async function measure(root: HTMLElement, slice: Slice): Promise<Box[]> {
  const boxes: Box[] = [];
  const all = [...root.getElementsByTagName('*')];
  for (const [i, el] of all.entries()) {
    const origin = root.getBoundingClientRect();
    el.setAttribute(AT_ATTR, String(i));
    const r = el.getBoundingClientRect();
    boxes.push({
      left: r.left - origin.left,
      top: r.top - origin.top,
      right: r.right - origin.left,
      bottom: r.bottom - origin.top,
      inline: getComputedStyle(el).display === 'inline',
    });
    await slice();
  }
  return boxes;
}

export async function freeze(
  root: HTMLElement,
  {
    width,
    height,
    leftOut,
    properties,
    slice,
  }: { width: number; height: number; leftOut: string; properties: readonly string[]; slice: Slice },
): Promise<Frozen> {
  const copy = root.cloneNode(true) as HTMLElement;
  const sources = [...root.getElementsByTagName('canvas')];
  const copies = [...copy.getElementsByTagName('canvas')];
  const style = document.createElement('style');
  style.textContent = STILL;
  const urls: string[] = [];
  const thaw = () => {
    copy.remove();
    style.remove();
    for (const url of urls) URL.revokeObjectURL(url);
  };
  try {
    const pictures = canvasesToPictures(sources, copies, { leftOut, properties });
    for (const el of copy.querySelectorAll(leftOut)) el.remove();
    copy.setAttribute(FROZEN_ATTR, '');
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    Object.assign(copy.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: `${String(width)}px`,
      height: `${String(height)}px`,
      transform: `translateX(${String(-2 * width - 100)}px)`,
      pointerEvents: 'none',
    });
    document.head.appendChild(style);
    document.documentElement.appendChild(copy);
    copy.getBoundingClientRect();
    await fillPictures(pictures, urls, slice);
    await nextFrame();
    return { root: copy, boxes: await measure(copy, slice), thaw };
  } catch (e) {
    thaw();
    throw e;
  }
}
