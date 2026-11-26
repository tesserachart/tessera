const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

const KEPT_AS_IS = /^(?:data:|#)/;

type Load = (url: string) => Promise<string>;

const loaded = new Map<string, Promise<string | null>>();

export function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('the file could not be read'));
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsDataURL(blob);
  });
}

async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${String(res.status)} for ${url}`);
  return dataUrlOf(await res.blob());
}

function loadOnce(url: string, load: Load): Promise<string | null> {
  let seen = loaded.get(url);
  if (!seen) {
    seen = load(url).catch((e: unknown) => {
      console.warn('[feedback] a file the picture uses could not be read', e);
      loaded.delete(url);
      return null;
    });
    loaded.set(url, seen);
  }
  return seen;
}

export async function inlineUrls(css: string, base: string, load: Load = fetchAsDataUrl): Promise<string> {
  const wanted = new Map<string, Promise<string | null>>();
  for (const m of css.matchAll(URL_IN_CSS)) {
    const raw = m[2]!.trim();
    if (KEPT_AS_IS.test(raw) || wanted.has(raw)) continue;
    let absolute: string;
    try {
      absolute = new URL(raw, base).href;
    } catch {
      continue;
    }
    wanted.set(raw, loadOnce(absolute, load));
  }
  if (wanted.size === 0) return css;
  const found = new Map<string, string>();
  for (const [raw, data] of wanted) {
    const url = await data;
    if (url) found.set(raw, url);
  }
  return css.replace(URL_IN_CSS, (whole, _quote: string, raw: string) => {
    const url = found.get(raw.trim());
    return url ? `url("${url}")` : whole;
  });
}

export type Matches = (media: string) => boolean;

const live: Matches = (media) => window.matchMedia(media).matches;

interface Piece {
  text: string;
  needs: readonly (readonly string[])[] | null;
}

interface Block {
  open: string;
  items: CssItem[];
}

export type CssItem = Piece | Block;

function isA<T>(rule: CSSRule, kind: (abstract new () => T) | undefined): rule is CSSRule & T {
  return kind !== undefined && rule instanceof kind;
}

function identAt(s: string, start: number): [string, number] {
  let out = '';
  let i = start;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\') {
      const hex = /^[0-9a-fA-F]{1,6} ?/.exec(s.slice(i + 1, i + 8));
      if (hex) {
        out += String.fromCodePoint(Number.parseInt(hex[0].trim(), 16));
        i += 1 + hex[0].length;
      } else {
        out += s[i + 1] ?? '';
        i += 2;
      }
    } else if (/[\w-]/.test(ch) || ch.charCodeAt(0) > 127) {
      out += ch;
      i++;
    } else {
      break;
    }
  }
  return [out, i];
}

export function classesNeeded(selectors: string): string[][] | null {
  const lists: string[][] = [];
  let current: string[] = [];
  let depth = 0;
  let quote = '';
  for (let i = 0; i < selectors.length; i++) {
    const ch = selectors[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '\\') {
      i++;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
    } else if (depth === 0 && ch === ',') {
      lists.push(current);
      current = [];
    } else if (depth === 0 && ch === '.') {
      const [name, end] = identAt(selectors, i + 1);
      if (name) current.push(name);
      i = end - 1;
    }
  }
  lists.push(current);
  return lists.some((l) => l.length === 0) ? null : lists;
}

export function itemsOf(rules: Iterable<CSSRule>, matches: Matches): CssItem[] {
  const items: CssItem[] = [];
  for (const rule of rules) {
    if (isA(rule, globalThis.CSSMediaRule)) {
      if (matches(rule.media.mediaText)) items.push(...itemsOf(rule.cssRules, matches));
    } else if (isA(rule, globalThis.CSSLayerBlockRule)) {
      items.push({ open: `@layer ${rule.name}`, items: itemsOf(rule.cssRules, matches) });
    } else if (isA(rule, globalThis.CSSSupportsRule)) {
      items.push({ open: `@supports ${rule.conditionText}`, items: itemsOf(rule.cssRules, matches) });
    } else if (isA(rule, globalThis.CSSStyleRule)) {
      items.push({ text: rule.cssText, needs: classesNeeded(rule.selectorText) });
    } else {
      items.push({ text: rule.cssText, needs: null });
    }
  }
  return items;
}

export function cssFor(items: readonly CssItem[], present: ReadonlySet<string>): string {
  let css = '';
  for (const item of items) {
    if ('open' in item) {
      css += `${item.open}{\n${cssFor(item.items, present)}}\n`;
    } else if (!item.needs || item.needs.some((all) => all.every((c) => present.has(c)))) {
      css += `${item.text}\n`;
    }
  }
  return css;
}

async function withUrlsInlined(items: readonly CssItem[], base: string): Promise<CssItem[]> {
  return Promise.all(
    items.map(async (item): Promise<CssItem> => {
      if ('open' in item) return { open: item.open, items: await withUrlsInlined(item.items, base) };
      return item.text.includes('url(') ? { ...item, text: await inlineUrls(item.text, base) } : item;
    }),
  );
}

function itemsOfSheet(sheet: CSSStyleSheet, base: string): Promise<CssItem[]> {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return Promise.resolve([]);
  }
  const parts: Promise<CssItem[]>[] = [];
  let run: CSSRule[] = [];
  const flush = () => {
    parts.push(withUrlsInlined(itemsOf(run, live), base));
    run = [];
  };
  for (const rule of rules) {
    if (rule instanceof CSSImportRule && rule.styleSheet) {
      flush();
      if (!rule.media.mediaText || live(rule.media.mediaText)) {
        parts.push(itemsOfSheet(rule.styleSheet, rule.styleSheet.href ?? base));
      }
    } else {
      run.push(rule);
    }
  }
  flush();
  return Promise.all(parts).then((p) => p.flat());
}

function applies(sheet: CSSStyleSheet): boolean {
  if (sheet.disabled) return false;
  const media = sheet.media.mediaText;
  return !media || live(media);
}

const read = new WeakMap<CSSStyleSheet, { key: string; items: Promise<CssItem[]> }>();

const MEDIA_THAT_CHANGES = [
  '(prefers-color-scheme: dark)',
  '(prefers-reduced-motion: reduce)',
  '(prefers-contrast: more)',
];

function mediaKey(): string {
  const prefs = MEDIA_THAT_CHANGES.map((m) => (live(m) ? '1' : '0')).join('');
  return `${String(window.innerWidth)}x${String(window.innerHeight)}@${String(window.devicePixelRatio)}:${prefs}`;
}

function ruleCount(sheet: CSSStyleSheet): number {
  try {
    return sheet.cssRules.length;
  } catch {
    return 0;
  }
}

function sheetItems(sheet: CSSStyleSheet, base: string, media: string): Promise<CssItem[]> {
  const key = `${String(ruleCount(sheet))}|${media}`;
  const seen = read.get(sheet);
  if (seen?.key === key) return seen.items;
  const items = itemsOfSheet(sheet, base);
  read.set(sheet, { key, items });
  return items;
}

export async function pageCss(doc: Document = document): Promise<CssItem[]> {
  const sheets = [...doc.styleSheets, ...doc.adoptedStyleSheets].filter(applies);
  const media = mediaKey();
  const all = await Promise.all(sheets.map((s) => sheetItems(s, s.href ?? doc.baseURI, media)));
  return all.flat();
}
