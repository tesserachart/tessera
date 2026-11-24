import { AT_ATTR, type Box } from './freeze.ts';
import { nextFrame, sleep, type Slice } from './pace.ts';
import { sheetFor, type Classes } from './slim.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

const TILE_ELEMENTS = 80;

const MIN_TILE = 64;

const BLEED = 8;

const REDRAW_AFTER_MS = 100;

export interface Tile {
  left: number;
  top: number;
  width: number;
  height: number;
}

function meets(box: Box, tile: Tile): boolean {
  if (box.right <= box.left || box.bottom <= box.top) return false;
  return (
    box.right >= tile.left - BLEED &&
    box.left <= tile.left + tile.width + BLEED &&
    box.bottom >= tile.top - BLEED &&
    box.top <= tile.top + tile.height + BLEED
  );
}

export function planTiles(boxes: readonly Box[], width: number, height: number, budget = TILE_ELEMENTS): Tile[] {
  const tiles: Tile[] = [];
  const split = (tile: Tile, inside: readonly Box[]) => {
    const here = inside.filter((b) => meets(b, tile));
    if (here.length <= budget || Math.max(tile.width, tile.height) <= MIN_TILE) {
      tiles.push(tile);
      return;
    }
    if (tile.width >= tile.height) {
      const half = Math.round(tile.width / 2);
      split({ ...tile, width: half }, here);
      split({ ...tile, left: tile.left + half, width: tile.width - half }, here);
    } else {
      const half = Math.round(tile.height / 2);
      split({ ...tile, height: half }, here);
      split({ ...tile, top: tile.top + half, height: tile.height - half }, here);
    }
  };
  split({ left: 0, top: 0, width, height }, boxes);
  return tiles;
}

function indexOf(el: Element): number | null {
  const at = el.getAttribute(AT_ATTR);
  return at === null ? null : Number(at);
}

interface Placed {
  el: Element;
  box: Box;
}

function placedIn(svg: SVGSVGElement, boxes: readonly Box[]): Placed[] {
  const placed: Placed[] = [];
  for (const el of svg.querySelectorAll(`[${AT_ATTR}]`)) {
    const i = indexOf(el);
    const box = i === null ? undefined : boxes[i];
    if (box) placed.push({ el, box });
  }
  return placed;
}

function keptFor(placed: readonly Placed[], tile: Tile): Set<Element> {
  const kept = new Set<Element>();
  for (const { el, box } of placed) {
    if (!meets(box, tile)) continue;
    for (let up: Element | null = el; up && !kept.has(up); up = up.parentElement) kept.add(up);
  }
  return kept;
}

function shell(el: Element, inline: boolean): Element {
  const out = el.cloneNode(inline) as Element;
  out.removeAttribute('src');
  out.removeAttribute('href');
  out.setAttribute('style', 'visibility:hidden !important');
  return out;
}

const isPicture = (el: Element) => el.localName === 'img' || el.localName === 'image';

function pieceFor(svg: SVGSVGElement, placed: readonly Placed[], boxes: readonly Box[], tile: Tile) {
  const kept = keptFor(placed, tile);
  let hasImages = false;
  const copy = (node: Node): Node => {
    if (!(node instanceof Element)) return node.cloneNode(false);
    const i = indexOf(node);
    if (i !== null && !kept.has(node)) return shell(node, boxes[i]?.inline ?? false);
    if (isPicture(node)) hasImages = true;
    const out = node.cloneNode(false) as Element;
    for (const child of node.childNodes) out.appendChild(copy(child));
    return out;
  };
  return { piece: copy(svg) as SVGSVGElement, hasImages };
}

interface SharedRule {
  text: string;
  classes: string[] | null;
  family: string | null;
}

const CLASS_IN_SELECTOR = /\.([^\s.:,>+~[\]()]+)/g;

function unquote(name: string): string {
  return name.trim().replace(/^["']|["']$/g, '');
}

function sharedRules(css: string): SharedRule[] {
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return [{ text: css, classes: null, family: null }];
  }
  return [...sheet.cssRules].map((rule) => {
    if (rule instanceof CSSFontFaceRule) {
      return { text: rule.cssText, classes: null, family: unquote(rule.style.getPropertyValue('font-family')) };
    }
    if (rule instanceof CSSStyleRule && rule.selectorText.includes('::')) {
      return {
        text: rule.cssText,
        classes: [...rule.selectorText.matchAll(CLASS_IN_SELECTOR)].map((m) => m[1]!),
        family: null,
      };
    }
    return { text: rule.cssText, classes: null, family: null };
  });
}

function familiesIn(css: string): Set<string> {
  const families = new Set<string>();
  for (const m of css.matchAll(/font-family:\s*([^;}]+)/g))
    for (const name of m[1]!.split(',')) families.add(unquote(name));
  return families;
}

function sharedFor(rules: readonly SharedRule[], piece: Element, own: string): string {
  const classes = new Set<string>();
  for (const el of piece.querySelectorAll('[class]')) for (const name of el.classList) classes.add(name);
  const kept = rules.filter((r) => r.family === null && (r.classes === null || r.classes.some((c) => classes.has(c))));
  const text = kept.map((r) => r.text).join('\n');
  const families = familiesIn(`${own}\n${text}`);
  const fonts = rules.filter((r) => r.family !== null && families.has(r.family));
  return [...fonts.map((r) => r.text), text].join('\n');
}

function takeShared(svg: SVGSVGElement): SharedRule[] {
  const styles = [...svg.querySelectorAll('style')];
  const css = styles.map((s) => s.textContent).join('\n');
  for (const s of styles) s.remove();
  return sharedRules(css);
}

function svgUrl(svg: SVGSVGElement): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

async function loaded(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

export async function drawTiles(
  svg: SVGSVGElement,
  boxes: readonly Box[],
  classes: Classes,
  {
    width,
    height,
    scale,
    background,
    slice,
  }: { width: number; height: number; scale: number; background: string | null; slice: Slice },
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas to draw on');
  const paint = (img: HTMLImageElement, t: Tile) => {
    const x = t.left * scale;
    const y = t.top * scale;
    const w = t.width * scale;
    const h = t.height * scale;
    ctx.clearRect(x, y, w, h);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(x, y, w, h);
    }
    ctx.drawImage(img, t.left, t.top, t.width, t.height, x, y, w, h);
    ctx.getImageData(x, y, 1, 1);
  };
  const shared = takeShared(svg);
  const placed = placedIn(svg, boxes);
  await slice();
  const withImages: { img: HTMLImageElement; tile: Tile }[] = [];
  for (const tile of planTiles(boxes, width, height)) {
    const { piece, hasImages } = pieceFor(svg, placed, boxes, tile);
    const own = sheetFor(piece, classes);
    const sheet = piece.ownerDocument.createElementNS(SVG_NS, 'style');
    sheet.textContent = `${sharedFor(shared, piece, own)}\n${own}`;
    piece.insertBefore(sheet, piece.firstChild);
    await slice();
    const url = svgUrl(piece);
    await nextFrame();
    const img = await loaded(url);
    await nextFrame();
    paint(img, tile);
    if (hasImages) withImages.push({ img, tile });
    await slice();
  }
  if (withImages.length > 0) await sleep(REDRAW_AFTER_MS);
  for (const { img, tile } of withImages) {
    await nextFrame();
    paint(img, tile);
  }
  return canvas;
}
