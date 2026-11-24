import type { Slice } from './pace.ts';

const INHERITED = new Set([
  'border-collapse',
  'border-spacing',
  'caption-side',
  'caret-color',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'color-scheme',
  'cursor',
  'direction',
  'dominant-baseline',
  'empty-cells',
  'fill',
  'fill-opacity',
  'fill-rule',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-optical-sizing',
  'font-palette',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-synthesis-small-caps',
  'font-synthesis-style',
  'font-synthesis-weight',
  'font-variant',
  'font-variant-alternates',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-emoji',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-variant-position',
  'font-variation-settings',
  'font-weight',
  'hyphenate-character',
  'hyphens',
  'image-orientation',
  'image-rendering',
  'letter-spacing',
  'line-break',
  'line-height',
  'list-style-image',
  'list-style-position',
  'list-style-type',
  'marker-end',
  'marker-mid',
  'marker-start',
  'orphans',
  'overflow-wrap',
  'paint-order',
  'pointer-events',
  'print-color-adjust',
  'quotes',
  'ruby-position',
  'shape-rendering',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'tab-size',
  'text-align',
  'text-align-last',
  'text-anchor',
  'text-combine-upright',
  'text-decoration-skip-ink',
  'text-emphasis-color',
  'text-emphasis-position',
  'text-emphasis-style',
  'text-indent',
  'text-orientation',
  'text-rendering',
  'text-shadow',
  'text-size-adjust',
  'text-transform',
  'text-underline-offset',
  'text-underline-position',
  'text-wrap',
  'text-wrap-mode',
  'text-wrap-style',
  'visibility',
  'white-space',
  'white-space-collapse',
  'widows',
  'word-break',
  'word-spacing',
  'writing-mode',
  '-webkit-font-smoothing',
  '-webkit-text-fill-color',
  '-webkit-text-stroke-color',
  '-webkit-text-stroke-width',
]);

const FOLLOWS_COLOR = new Set([
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'column-rule-color',
  'outline-color',
  'row-rule-color',
  'text-decoration-color',
]);

const LOGICAL =
  /^(?:(?:border|margin|padding|inset|scroll-margin|scroll-padding|overflow|overscroll-behavior)-(?:inline|block)|(?:min-|max-)?(?:inline|block)-size$|contain-intrinsic-(?:inline|block)-size$)/;

export function drawnProperties(style: CSSStyleDeclaration = getComputedStyle(document.documentElement)): string[] {
  return [...style].filter((name) => !name.startsWith('--') && !LOGICAL.test(name));
}

type Styled = Element & ElementCSSInlineStyle;

function styled(node: Node): node is Styled {
  return node instanceof Element && 'style' in node && node.style instanceof CSSStyleDeclaration;
}

function declared(style: CSSStyleDeclaration): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    out.set(name, style.getPropertyValue(name));
  }
  return out;
}

export type DefaultsOf = (el: Element, pseudo?: string) => ReadonlyMap<string, string>;

export function defaultsIn(sandbox: HTMLIFrameElement): DefaultsOf {
  const known = new Map<string, Map<string, string>>();
  return (el, pseudo) => {
    const key = `${el.namespaceURI ?? ''} ${el.localName} ${pseudo ?? ''}`;
    const seen = known.get(key);
    if (seen) return seen;
    const doc = sandbox.contentDocument;
    const view = sandbox.contentWindow;
    const found = new Map<string, string>();
    if (doc?.body && view) {
      const probe = doc.createElementNS(el.namespaceURI, el.localName);
      const inSvg = el.namespaceURI === 'http://www.w3.org/2000/svg' && el.localName !== 'svg';
      const host = inSvg ? doc.createElementNS(el.namespaceURI, 'svg') : probe;
      if (inSvg) host.appendChild(probe);
      doc.body.appendChild(host);
      for (const [name, value] of declared(view.getComputedStyle(probe, pseudo ?? null))) found.set(name, value);
      host.remove();
    }
    known.set(key, found);
    return found;
  };
}

export interface Slimmer {
  children: (parent: Node) => void;
  fullOf: (el: Element) => ReadonlyMap<string, string> | null;
}

function slimmed(
  style: CSSStyleDeclaration,
  mine: ReadonlyMap<string, string>,
  theirs: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, string>,
) {
  const color = mine.get('color') ?? theirs.get('color');
  for (const [name, value] of mine) {
    if (name === 'content') continue;
    const inherited = INHERITED.has(name) && theirs.get(name) === value;
    const followsColor = FOLLOWS_COLOR.has(name) && value === color;
    const unset = base.get(name) === value && (theirs.get(name) ?? value) === value;
    if (inherited || followsColor || unset) style.removeProperty(name);
  }
}

export function slimmer(defaultsOf: DefaultsOf): Slimmer {
  const full = new WeakMap<Element, Map<string, string>>();
  const fullOf = (el: Styled) => {
    let seen = full.get(el);
    if (!seen) {
      seen = declared(el.style);
      full.set(el, seen);
    }
    return seen;
  };
  return {
    children: (parent) => {
      if (!styled(parent)) return;
      const theirs = fullOf(parent);
      for (const child of parent.children) {
        if (styled(child)) slimmed(child.style, fullOf(child), theirs, defaultsOf(child));
      }
    },
    fullOf: (el) => (styled(el) ? fullOf(el) : null),
  };
}

const PSEUDO_SELECTOR = /^\.([^\s.:,]+)(::[\w-]+)$/;

export async function slimPseudoRules(
  rules: ReadonlyMap<string, readonly string[]>,
  root: Element,
  { slim, defaultsOf, slice }: { slim: Slimmer; defaultsOf: DefaultsOf; slice: Slice },
): Promise<string> {
  const scratch = document.createElement('div').style;
  const bySlimmed = new Map<string, string[]>();
  for (const [cssText, selectors] of rules) {
    for (const selector of selectors) {
      const m = PSEUDO_SELECTOR.exec(selector);
      const owner = m ? root.querySelector(`.${CSS.escape(m[1]!)}`) : null;
      scratch.cssText = cssText;
      if (m && owner) {
        slimmed(scratch, declared(scratch), slim.fullOf(owner) ?? new Map(), defaultsOf(owner, m[2]));
      }
      const text = scratch.cssText;
      const group = bySlimmed.get(text);
      if (group) group.push(selector);
      else bySlimmed.set(text, [selector]);
      await slice();
    }
  }
  let css = '';
  for (const [text, selectors] of bySlimmed) css += `${selectors.join(',')}{${text}}\n`;
  return css;
}

export type Classes = ReadonlyMap<string, string>;

const CLASS_PREFIX = 'fbs';

export async function classify(root: Element, slice: Slice): Promise<Classes> {
  const byStyle = new Map<string, string>();
  const classes = new Map<string, string>();
  for (const el of root.querySelectorAll('[style]')) {
    const text = el.getAttribute('style') ?? '';
    let name = byStyle.get(text);
    if (!name) {
      name = `${CLASS_PREFIX}${byStyle.size.toString(36)}`;
      byStyle.set(text, name);
      classes.set(name, text);
    }
    el.removeAttribute('style');
    el.classList.add(name);
    await slice();
  }
  return classes;
}

export function sheetFor(root: Element, classes: Classes): string {
  const used = new Set<string>();
  for (const el of root.querySelectorAll(`[class*="${CLASS_PREFIX}"]`)) {
    for (const name of el.classList) if (classes.has(name)) used.add(name);
  }
  let css = '';
  for (const name of used) css += `.${name}{${classes.get(name) ?? ''}}\n`;
  return css;
}
