import type { CDPSession, Page } from 'playwright';

export const FORCED_STATES = ['hover', 'active', 'focus', 'focus-visible', 'focus-within'] as const;
export type ForcedState = (typeof FORCED_STATES)[number];
export type Subjects = Record<ForcedState, string[]>;

type Look = Record<string, string>;
type Changes = Record<string, Look>;

export interface Styles {
  base: Record<string, Look>;
  forced: Record<string, Changes>;
}

interface Snapshot {
  strings: string[];
  documents: {
    nodes: {
      parentIndex?: number[];
      nodeType?: number[];
      nodeName?: number[];
      pseudoType?: { index: number[]; value: number[] };
    };
    layout: { nodeIndex: number[]; styles: number[][]; bounds: number[][] };
  }[];
}

function subjectPaths(state: string): string[] {
  const splitTop = (text: string, at: (ch: string) => boolean) => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0 && at(ch)) {
        parts.push(text.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(text.slice(start));
    return parts;
  };
  const selectors: string[] = [];
  const collect = (rules: CSSRuleList, parent: string | null) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const own = parent ? rule.selectorText.replaceAll('&', `:is(${parent})`) : rule.selectorText;
        selectors.push(own);
        if (rule.cssRules.length > 0) collect(rule.cssRules, own);
      } else if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules, parent);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collect(sheet.cssRules, null);
    } catch {
      continue;
    }
  }
  const pseudo = new RegExp(`:${state}(?![-\\w])`);
  const found = new Set<Element>();
  for (const selector of selectors) {
    for (const part of splitTop(selector, (ch) => ch === ',')) {
      const trimmed = part.trim();
      if (!pseudo.test(trimmed)) continue;
      const compounds = splitTop(trimmed, (ch) => ch === ' ' || ch === '>' || ch === '+' || ch === '~');
      let length = 0;
      for (const compound of compounds) {
        length += compound.length + 1;
        if (pseudo.test(compound)) break;
      }
      const subject = trimmed
        .slice(0, length)
        .replace(new RegExp(pseudo.source, 'g'), '')
        .trim()
        .replace(/[>+~]$/, '')
        .trim();
      try {
        for (const el of document.querySelectorAll(subject || '*')) found.add(el);
      } catch {
        continue;
      }
    }
  }
  const pathOf = (el: Element): string => {
    const steps: string[] = [];
    for (let at: Element = el; at !== document.body && at.parentElement; at = at.parentElement) {
      steps.unshift(`${at.tagName.toLowerCase()}:${String(Array.from(at.parentElement.children).indexOf(at))}`);
    }
    return ['body', ...steps].join('>');
  };
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (!found.has(el) || el.getClientRects().length === 0) continue;
    const key = `${el.tagName}.${el.getAttribute('class') ?? ''}[${el.getAttribute('role') ?? ''}]`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(pathOf(el));
  }
  return kept;
}

function ruleProperties(): string[] {
  const names = new Set<string>(['display', 'visibility', 'opacity', 'position', 'z-index', 'transform']);
  const collect = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        for (let i = 0; i < rule.style.length; i++) {
          const name = rule.style.item(i);
          if (!name.startsWith('--')) names.add(name);
        }
      }
      if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collect(sheet.cssRules);
    } catch {
      continue;
    }
  }
  return [...names];
}

export interface Probe {
  subjects: Subjects;
  props: string[];
}

export async function probe(page: Page): Promise<Probe> {
  const subjects = {} as Subjects;
  for (const state of FORCED_STATES) subjects[state] = await page.evaluate(subjectPaths, state);
  return { subjects, props: await page.evaluate(ruleProperties) };
}

export function mergeProbes(a: Probe, b: Probe): Probe {
  const subjects = {} as Subjects;
  for (const state of FORCED_STATES) {
    subjects[state] = [...new Set([...a.subjects[state], ...b.subjects[state]])].sort();
  }
  return { subjects, props: [...new Set([...a.props, ...b.props])].sort() };
}

async function look(page: Page, cdp: CDPSession, props: string[]): Promise<Record<string, Look>> {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      try {
        animation.finish();
      } catch {
        animation.cancel();
      }
    }
  });
  const snap = (await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: props,
    includeDOMRects: true,
  })) as unknown as Snapshot;
  const doc = snap.documents[0];
  const out: Record<string, Look> = {};
  if (!doc) return out;
  const pseudoOf = new Map<number, string>();
  doc.nodes.pseudoType?.index.forEach((node, i) => {
    pseudoOf.set(node, snap.strings[doc.nodes.pseudoType?.value[i] ?? -1] ?? '');
  });
  const parents = doc.nodes.parentIndex ?? [];
  const names = (doc.nodes.nodeName ?? []).map((n) => snap.strings[n] ?? '');
  const types = doc.nodes.nodeType ?? [];
  const paths: (string | null)[] = [];
  const childCount = new Map<number, number>();
  for (let node = 0; node < names.length; node++) {
    const parent = parents[node] ?? -1;
    if (names[node] === 'BODY') {
      paths[node] = 'body';
      continue;
    }
    const parentPath = parent >= 0 ? paths[parent] : null;
    if (parentPath && pseudoOf.has(node)) {
      paths[node] = `${parentPath}::${pseudoOf.get(node) ?? ''}`;
      continue;
    }
    if (!parentPath || types[node] !== 1) {
      paths[node] = null;
      continue;
    }
    const nth = childCount.get(parent) ?? 0;
    childCount.set(parent, nth + 1);
    paths[node] = `${parentPath}>${names[node]?.toLowerCase() ?? ''}:${String(nth)}`;
  }
  doc.layout.nodeIndex.forEach((node, i) => {
    const key = paths[node];
    if (!key) return;
    const values: Look = { '@bounds': (doc.layout.bounds[i] ?? []).map((n) => n.toFixed(2)).join(',') };
    (doc.layout.styles[i] ?? []).forEach((s, p) => {
      const prop = props[p];
      if (prop) values[prop] = snap.strings[s] ?? '';
    });
    out[key] = values;
  });
  return out;
}

function changesFrom(base: Record<string, Look>, now: Record<string, Look>): Changes {
  const changes: Changes = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(now)])) {
    const a = base[key];
    const b = now[key];
    if (!a || !b) {
      changes[key] = { '@present': b ? 'yes' : 'no' };
      continue;
    }
    const changed: Look = {};
    for (const prop of Object.keys(b)) if (a[prop] !== b[prop]) changed[prop] = b[prop] ?? '';
    if (Object.keys(changed).length > 0) changes[key] = changed;
  }
  return changes;
}

export async function baseStyles(page: Page, cdp: CDPSession): Promise<Record<string, Look>> {
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const every = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Array.from({ length: style.length }, (_, i) => style.item(i)).filter((n) => !n.startsWith('--'));
  });
  return look(page, cdp, every);
}

export async function readStyles(
  page: Page,
  cdp: CDPSession,
  { subjects, props }: Probe,
  base: Record<string, Look>,
): Promise<Styles> {
  const selectorOf = (path: string) =>
    path
      .split('>')
      .map((step, i) => (i === 0 ? 'body' : `:nth-child(${String(Number(step.split(':')[1]) + 1)})`))
      .join(' > ');
  const nodeAt = async (path: string) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    return (await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: selectorOf(path) })).nodeId;
  };
  const forcedLook = async (path: string, state: ForcedState): Promise<Changes | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const nodeId = await nodeAt(path);
      if (!nodeId) return null;
      const held = await cdp
        .send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [state] })
        .then(() => true)
        .catch(() => false);
      if (!held) continue;
      const now = await look(page, cdp, props);
      const still = (await nodeAt(path)) === nodeId;
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => undefined);
      if (still) return changesFrom(base, now);
    }
    return null;
  };
  const forced: Styles['forced'] = {};
  const total = FORCED_STATES.reduce((n, state) => n + subjects[state].length, 0);
  const started = Date.now();
  for (const state of FORCED_STATES) {
    for (const path of subjects[state]) {
      if (Object.keys(forced).length % 50 === 0)
        console.info(`  forced ${String(Object.keys(forced).length)}/${String(total)} (${String(props.length)} properties, ${String(Math.round((Date.now() - started) / 1000))} s)`);
      const key = `${state}@${path}`;
      forced[key] = (await forcedLook(path, state)) ?? { '@node': { '@present': 'replaced while forced' } };
    }
  }
  return { base, forced };
}

const INVISIBLE_SHADOW = /^rgba\(0, 0, 0, 0\) 0px 0px 0px 0px$/;

function seen(prop: string, value: string | undefined): string | undefined {
  if (prop !== 'box-shadow' || value === undefined) return value;
  const layers = value.split(/,(?![^(]*\))/).map((l) => l.trim());
  const visible = layers.filter((l) => !INVISIBLE_SHADOW.test(l) && l !== 'none');
  return visible.length > 0 ? visible.join(', ') : 'none';
}

function same(prop: string, a: string | undefined, b: string | undefined): boolean {
  return seen(prop, a) === seen(prop, b);
}

const imageless = (look: Look | undefined) => (look?.['background-image'] ?? 'none') === 'none';

function lookDiff(a: Look | undefined, b: Look | undefined): string[] {
  if (!a || !b) return [a ? 'gone after' : 'only after'];
  const out: string[] = [];
  for (const prop of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (prop.startsWith('background-position') && imageless(a) && imageless(b)) continue;
    if (!same(prop, a[prop], b[prop])) out.push(`${prop}: ${a[prop] ?? '∅'} → ${b[prop] ?? '∅'}`);
  }
  return out;
}

export function stylesReport(a: Styles, b: Styles): string[] {
  const report: string[] = [];
  for (const key of new Set([...Object.keys(a.base), ...Object.keys(b.base)])) {
    const changed = lookDiff(a.base[key], b.base[key]);
    if (changed.length > 0) report.push(`${key}: ${changed.join('; ')}`);
  }
  for (const state of new Set([...Object.keys(a.forced), ...Object.keys(b.forced)])) {
    const ca = a.forced[state] ?? {};
    const cb = b.forced[state] ?? {};
    for (const key of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
      const props = new Set([...Object.keys(ca[key] ?? {}), ...Object.keys(cb[key] ?? {})]);
      const value = (side: Styles, change: Look | undefined, prop: string) => change?.[prop] ?? side.base[key]?.[prop];
      const effective = (side: Styles, change: Look | undefined): Look => ({ ...(side.base[key] ?? {}), ...(change ?? {}) });
      const noImage = imageless(effective(a, ca[key])) && imageless(effective(b, cb[key]));
      const changed = [...props].flatMap((prop) => {
        if (prop.startsWith('background-position') && noImage) return [];
        const va = value(a, ca[key], prop);
        const vb = value(b, cb[key], prop);
        return same(prop, va, vb) ? [] : [`${prop}: ${va ?? '∅'} → ${vb ?? '∅'}`];
      });
      if (changed.length > 0) report.push(`:${state} ${key}: ${changed.join('; ')}`);
    }
  }
  return report;
}
