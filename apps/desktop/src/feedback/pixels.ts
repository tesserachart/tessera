export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type PixelSource = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;

export interface Painted {
  source: PixelSource;
  shown: Rect;
  copy: HTMLCanvasElement;
}

const HAVE_CURRENT_DATA = 2;

const IN_FLOW_RANK = -0.5;

export function rectOf(r: DOMRectReadOnly): Rect {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export function meet(a: Rect, b: Rect): Rect | null {
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

export function isPixelSource(el: Element): el is PixelSource {
  return el instanceof HTMLCanvasElement || el instanceof HTMLImageElement || el instanceof HTMLVideoElement;
}

function bitmapSize(el: PixelSource): { width: number; height: number } | null {
  if (el instanceof HTMLCanvasElement) return el.width > 0 && el.height > 0 ? el : null;
  if (el instanceof HTMLImageElement) {
    return el.complete && el.naturalWidth > 0 ? { width: el.naturalWidth, height: el.naturalHeight } : null;
  }
  return el.readyState >= HAVE_CURRENT_DATA && el.videoWidth > 0
    ? { width: el.videoWidth, height: el.videoHeight }
    : null;
}

function paddingBox(el: Element): Rect {
  const r = el.getBoundingClientRect();
  const left = r.left + el.clientLeft;
  const top = r.top + el.clientTop;
  return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight };
}

function shownRect(el: Element, view: Rect): Rect | null {
  let shown = meet(rectOf(el.getBoundingClientRect()), view);
  for (let up = el.parentElement; shown && up; up = up.parentElement) {
    const style = getComputedStyle(up);
    const x = style.overflowX !== 'visible';
    const y = style.overflowY !== 'visible';
    if (!x && !y) continue;
    const box = paddingBox(up);
    shown = meet(shown, {
      left: x ? box.left : -Infinity,
      right: x ? box.right : Infinity,
      top: y ? box.top : -Infinity,
      bottom: y ? box.bottom : Infinity,
    });
  }
  return shown;
}

export function bitmapPart(box: Rect, shown: Rect, size: { width: number; height: number }): Rect {
  const sx = size.width / (box.right - box.left);
  const sy = size.height / (box.bottom - box.top);
  return {
    left: Math.max(0, Math.floor((shown.left - box.left) * sx)),
    top: Math.max(0, Math.floor((shown.top - box.top) * sy)),
    right: Math.min(size.width, Math.ceil((shown.right - box.left) * sx)),
    bottom: Math.min(size.height, Math.ceil((shown.bottom - box.top) * sy)),
  };
}

function readable(source: PixelSource, probe: CanvasRenderingContext2D): boolean {
  try {
    probe.clearRect(0, 0, 1, 1);
    probe.drawImage(source, 0, 0, 1, 1);
    probe.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function shownOnScreen(el: Element): boolean {
  return 'checkVisibility' in el ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
}

export function copyPixels(source: PixelSource, frame: Rect, probe: CanvasRenderingContext2D): Painted | null {
  const size = bitmapSize(source);
  if (!size || !shownOnScreen(source)) return null;
  const shown = shownRect(source, frame);
  if (!shown || !readable(source, probe)) return null;
  const part = bitmapPart(rectOf(source.getBoundingClientRect()), shown, size);
  const width = part.right - part.left;
  const height = part.bottom - part.top;
  if (width <= 0 || height <= 0) return null;
  const copy = document.createElement('canvas');
  copy.width = width;
  copy.height = height;
  copy.getContext('2d')?.drawImage(source, part.left, part.top, width, height, 0, 0, width, height);
  return { source, shown, copy };
}

export type Rank = (el: Element) => number;

export function stackRank(): Rank {
  const known = new Map<Element, number>();
  return (el) => {
    const seen = known.get(el);
    if (seen !== undefined) return seen;
    const style = getComputedStyle(el);
    const parent = el.parentElement ? getComputedStyle(el.parentElement).display : '';
    const stacksAnywhere = /flex|grid/.test(parent) || style.position !== 'static';
    const z = style.zIndex === 'auto' || !stacksAnywhere ? null : Number.parseInt(style.zIndex, 10);
    const rank = z !== null && Number.isFinite(z) ? z : style.position === 'static' ? IN_FLOW_RANK : 0;
    known.set(el, rank);
    return rank;
  };
}

function branches(a: Element, b: Element): [Element, Element] | null {
  const pathOfA = new Map<Element, Element>();
  let child = a;
  for (let up = a.parentElement; up; child = up, up = up.parentElement) pathOfA.set(up, child);
  let fromB = b;
  for (let up = b.parentElement; up; fromB = up, up = up.parentElement) {
    const fromA = pathOfA.get(up);
    if (fromA) return [fromA, fromB];
  }
  return null;
}

export function paintsOver(under: Element, over: Element, rank: Rank): boolean {
  if (over.contains(under) || under.contains(over)) return false;
  const pair = branches(under, over);
  if (!pair) return false;
  const [u, o] = pair;
  const ru = rank(u);
  const ro = rank(o);
  if (ru !== ro) return ro > ru;
  return Boolean(under.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING);
}

export function inPaintOrder(painted: readonly Painted[], rank: Rank): Painted[] {
  return [...painted].sort((a, b) => (a === b ? 0 : paintsOver(a.source, b.source, rank) ? -1 : 1));
}
