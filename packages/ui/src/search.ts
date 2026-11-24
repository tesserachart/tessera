export interface SearchOption<T extends string = string> {
  value: T;
  label: string;
  keywords?: readonly string[];
  group?: string;
  disabled?: boolean;
}

export interface SearchGroup<O> {
  group: string | undefined;
  options: O[];
}

export function normalizeQuery(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function subsequence(term: string, text: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === term[i] && ++i === term.length) return true;
  return false;
}

const WORD_START = /[\s\-/.(_:]/;

function termScore(term: string, label: string, keywords: readonly string[]): number {
  if (label === term) return 100;
  if (label.startsWith(term)) return 80;
  const at = label.indexOf(term);
  if (at > 0) {
    for (let i = at; i > 0; i = label.indexOf(term, i + 1)) if (WORD_START.test(label[i - 1] ?? '')) return 60;
    return 40;
  }
  let best = 0;
  for (const k of keywords) {
    if (k.startsWith(term)) best = Math.max(best, 30);
    else if (k.includes(term)) best = Math.max(best, 20);
  }
  if (best) return best;
  return term.length >= 2 && subsequence(term, label) ? 10 : 0;
}

export function scoreOption(option: Pick<SearchOption, 'label' | 'keywords'>, query: string): number {
  const q = normalizeQuery(query);
  if (!q) return 1;
  const label = normalizeQuery(option.label);
  const keywords = (option.keywords ?? []).map(normalizeQuery);
  let total = 0;
  for (const term of q.split(' ')) {
    const s = termScore(term, label, keywords);
    if (!s) return 0;
    total += s;
  }
  if (q.includes(' ') && label.startsWith(q)) total += 50;
  return total;
}

export function rankOptions<O extends Pick<SearchOption, 'label' | 'keywords'>>(
  options: readonly O[],
  query: string,
): O[] {
  if (!normalizeQuery(query)) return [...options];
  return options
    .map((option, i) => ({ option, i, score: scoreOption(option, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.option);
}

export function groupOptions<O extends Pick<SearchOption, 'group'>>(options: readonly O[]): SearchGroup<O>[] {
  const groups: SearchGroup<O>[] = [];
  const at = new Map<string | undefined, SearchGroup<O>>();
  for (const option of options) {
    let g = at.get(option.group);
    if (!g) {
      g = { group: option.group, options: [] };
      at.set(option.group, g);
      groups.push(g);
    }
    g.options.push(option);
  }
  return groups;
}

export type ListMove = number | 'first' | 'last';

export function moveActive<T extends string>(
  options: readonly Pick<SearchOption<T>, 'value' | 'disabled'>[],
  active: T | null,
  move: ListMove,
  loop = false,
): T | null {
  const enabled = options.filter((o) => !o.disabled);
  if (enabled.length === 0) return null;
  if (move === 'first') return enabled[0]!.value;
  if (move === 'last') return enabled[enabled.length - 1]!.value;
  const at = active === null ? -1 : enabled.findIndex((o) => o.value === active);
  if (at < 0) return (move > 0 ? enabled[0] : enabled[enabled.length - 1])!.value;
  let next = at + move;
  if (loop && Math.abs(move) === 1) next = (next + enabled.length) % enabled.length;
  else next = Math.min(enabled.length - 1, Math.max(0, next));
  return enabled[next]!.value;
}
