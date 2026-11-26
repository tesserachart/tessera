import {
  copyPixels,
  inPaintOrder,
  isPixelSource,
  meet,
  paintsOver,
  rectOf,
  stackRank,
  type Painted,
  type Rect,
} from './pixels.ts';

export const OUT_ATTR = 'data-fb-out';
export const ABOVE_ATTR = 'data-fb-above';
export const HIDDEN_ATTR = 'data-fb-hidden';

const XHTML = 'http://www.w3.org/1999/xhtml';

const MASK = '••••';

// eslint-disable-next-line no-control-regex
const XML_UNSAFE = /[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF￾￿]/gu;

const DROPPED = 'script, style, link, noscript, template, iframe';

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
  for (const a of cloned.attributes) {
    const clean = xmlSafe(maskText(a.value, words));
    if (clean !== a.value) a.value = clean;
  }
  if (cloned instanceof HTMLTextAreaElement) {
    const value = xmlSafe(maskText(cloned.value, words));
    cloned.value = value;
    cloned.textContent = value;
  } else if (cloned instanceof HTMLInputElement) {
    const value = xmlSafe(maskText(cloned.value, words));
    cloned.value = value;
    cloned.setAttribute('value', value);
    cloned.toggleAttribute('checked', cloned.checked);
  }
}

export interface PageRead {
  frame: Rect;
  painted: Painted[];
  out: ReadonlySet<Element>;
  above: ReadonlySet<Element>;
  hidden: ReadonlySet<Element>;
  scrolled: ReadonlyMap<Element, { x: number; y: number }>;
}

function outsideRoot(root: Element): Element[] {
  const out: Element[] = [];
  for (let child: Element = root; child.parentElement && child !== document.body; child = child.parentElement) {
    for (const sibling of child.parentElement.children) if (sibling !== child) out.push(sibling);
  }
  return out;
}

function withinAny(el: Element, roots: readonly Element[]): boolean {
  return roots.some((r) => r.contains(el));
}

function markAbove(all: readonly Element[], painted: readonly Painted[], skip: (el: Element) => boolean) {
  const rank = stackRank();
  const above = new Set<Element>();
  let last: Element | null = null;
  for (const el of all) {
    if (last?.contains(el) || isPixelSource(el) || skip(el)) continue;
    const box = rectOf(el.getBoundingClientRect());
    if (painted.some((p) => meet(box, p.shown) && paintsOver(p.source, el, rank))) {
      above.add(el);
      last = el;
    }
  }
  const hidden = new Set<Element>();
  for (const top of above) {
    for (const el of [top, ...top.querySelectorAll('*')]) {
      if (getComputedStyle(el).visibility !== 'visible') hidden.add(el);
    }
  }
  return { above, hidden, rank };
}

export function readPage(root: Element, leftOut: string): PageRead {
  const view: Rect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const frame = meet(rectOf(root.getBoundingClientRect()), view) ?? view;
  const left = [...document.body.querySelectorAll(leftOut)];
  const out = new Set<Element>([...left, ...(root === document.body ? [] : outsideRoot(root))]);
  const outRoots = [...out];
  const all = [...root.getElementsByTagName('*')];
  const skip = (el: Element) => withinAny(el, outRoots);
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const painted: Painted[] = [];
  if (probe) {
    for (const el of all) {
      if (!isPixelSource(el) || skip(el)) continue;
      const p = copyPixels(el, frame, probe);
      if (p) painted.push(p);
    }
  }
  const { above, hidden, rank } = painted.length > 0 ? markAbove(all, painted, skip) : EMPTY_MARKS;
  const scrolled = new Map<Element, { x: number; y: number }>();
  for (const el of document.body.getElementsByTagName('*')) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) scrolled.set(el, { x: el.scrollLeft, y: el.scrollTop });
  }
  return { frame, painted: inPaintOrder(painted, rank), out, above, hidden, scrolled };
}

const EMPTY_MARKS = { above: new Set<Element>(), hidden: new Set<Element>(), rank: () => 0 };

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) {
      if (part) parts.push(part);
      part = '';
    } else {
      part += ch;
    }
  }
  if (part) parts.push(part);
  return parts;
}

export function shiftedTranslate(computed: string, x: number, y: number): string {
  const [tx = '0px', ty = '0px', tz] = computed === 'none' ? [] : splitTopLevel(computed);
  const moved = `calc(${tx} - ${String(x)}px) calc(${ty} - ${String(y)}px)`;
  return tz ? `${moved} ${tz}` : moved;
}

function shiftChildren(source: Element, copy: Element, by: { x: number; y: number }) {
  const sources = [...source.childNodes];
  for (const [i, node] of [...copy.childNodes].entries()) {
    const from = sources[i];
    if (node instanceof HTMLElement || node instanceof SVGElement) {
      if (!(from instanceof Element)) continue;
      const style = getComputedStyle(from);
      if (style.position === 'sticky' || style.position === 'fixed') continue;
      if (style.display === 'inline' && style.position === 'static') {
        node.style.setProperty('position', 'relative');
        node.style.setProperty('left', `${String(-by.x)}px`);
        node.style.setProperty('top', `${String(-by.y)}px`);
      } else {
        node.style.setProperty('translate', shiftedTranslate(style.translate || 'none', by.x, by.y));
      }
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      const span = document.createElement('span');
      span.style.cssText = `position:relative;left:${String(-by.x)}px;top:${String(-by.y)}px`;
      node.replaceWith(span);
      span.append(node);
    }
  }
}

function keepFormState(source: Element, copy: Element) {
  if (
    (source instanceof HTMLInputElement && copy instanceof HTMLInputElement) ||
    (source instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement)
  ) {
    copy.value = source.value;
    if (copy instanceof HTMLInputElement && source instanceof HTMLInputElement) copy.checked = source.checked;
  } else if (source instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
    for (const [i, option] of [...copy.options].entries()) {
      option.toggleAttribute('selected', source.options[i]?.selected ?? false);
    }
  } else if (source instanceof HTMLDetailsElement) {
    copy.toggleAttribute('open', source.open);
  }
}

function stripPixels(copy: Element) {
  for (const name of ['src', 'srcset', 'poster']) copy.removeAttribute(name);
}

export interface PageCopy {
  markup: string;
  classes: ReadonlySet<string>;
}

export function copyPage(read: PageRead, words: readonly string[], cssSlot: string): PageCopy {
  const body = document.body;
  const copy = body.cloneNode(true) as HTMLElement;
  const sources = [...body.getElementsByTagName('*')];
  const copies = [...copy.getElementsByTagName('*')];
  for (const [i, source] of sources.entries()) {
    const el = copies[i];
    if (!el) continue;
    keepFormState(source, el);
    cleanClone(el, words);
    if (read.out.has(source) || isPixelSource(source)) el.setAttribute(OUT_ATTR, '');
    if (isPixelSource(source)) stripPixels(el);
    if (read.above.has(source)) el.setAttribute(ABOVE_ATTR, '');
    if (read.hidden.has(source)) el.setAttribute(HIDDEN_ATTR, '');
    const by = read.scrolled.get(source);
    if (by) shiftChildren(source, el, by);
  }
  cleanClone(copy, words);
  for (const el of copy.querySelectorAll(DROPPED)) el.remove();
  const html = document.documentElement.cloneNode(false) as HTMLElement;
  cleanClone(html, words);
  const head = document.createElementNS(XHTML, 'head');
  const style = document.createElementNS(XHTML, 'style');
  style.textContent = cssSlot;
  head.append(style);
  html.append(head, copy);
  const classes = new Set<string>();
  for (const el of [html, ...html.getElementsByTagName('*')]) for (const name of el.classList) classes.add(name);
  return { markup: new XMLSerializer().serializeToString(html), classes };
}
