import type { JournalCatalog, Outcome, TradeFilter, TradeStatus } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';
import { dayLabel, emotionWord, resultWord } from './format.ts';

export type RangeKey = 'week' | 'month' | '30d' | '90d' | 'ytd' | 'all';

export const RANGES: readonly { value: RangeKey; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'ytd', label: 'Year' },
  { value: 'all', label: 'All' },
];

export interface Scope {
  account: string;
  range: RangeKey;
}

export const ALL_ACCOUNTS = 'all';

export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function rangeDates(range: RangeKey, today: string): { from: string | null; to: string | null } {
  switch (range) {
    case 'week': {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
      return { from: addDays(today, -dow), to: null };
    }
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: null };
    case '30d':
      return { from: addDays(today, -29), to: null };
    case '90d':
      return { from: addDays(today, -89), to: null };
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: null };
    case 'all':
      return { from: null, to: null };
  }
}

export function scopedFilter(scope: Scope, filter: TradeFilter, today: string): TradeFilter {
  const out: TradeFilter = { ...filter };
  if (scope.account !== ALL_ACCOUNTS) out.accounts = [scope.account];
  const { from, to } = rangeDates(scope.range, today);
  if (from && !filter.from) out.from = from;
  if (to && !filter.to) out.to = to;
  return clean(out);
}

export function clean(f: TradeFilter): TradeFilter {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f) as [string, unknown][]) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export interface FilterChip {
  key: keyof TradeFilter;
  label: string;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const OUTCOMES: Record<Outcome, string> = {
  win: 'Winners',
  loss: 'Losers',
  breakeven: 'Breakevens',
  open: 'Open',
};

const STATUSES: Record<TradeStatus, string> = { open: 'Open', closed: 'Closed' };

function range(lo: number | undefined, hi: number | undefined, f: (v: number) => string): string {
  if (lo !== undefined && hi !== undefined) return `${f(lo)} to ${f(hi)}`;
  if (lo !== undefined) return `${f(lo)} or more`;
  return `${f(hi ?? 0)} or less`;
}

export function filterChips(f: TradeFilter, catalog: JournalCatalog | null): FilterChip[] {
  const out: FilterChip[] = [];
  const name = (list: readonly { id: string; name: string }[] | undefined, id: string) =>
    list?.find((x) => x.id === id)?.name ?? id;
  if (f.search) out.push({ key: 'search', label: `“${f.search}”` });
  if (f.symbols?.length) out.push({ key: 'symbols', label: f.symbols.join(', ') });
  if (f.side) out.push({ key: 'side', label: f.side === 'buy' ? 'Longs' : 'Shorts' });
  if (f.status) out.push({ key: 'status', label: STATUSES[f.status] });
  if (f.outcome) out.push({ key: 'outcome', label: OUTCOMES[f.outcome] });
  if (f.results?.length) out.push({ key: 'results', label: f.results.map(resultWord).join(', ') });
  if (f.setups?.length)
    out.push({
      key: 'setups',
      label: f.setups.map((s) => (s === 'none' ? 'No setup' : name(catalog?.setups, s))).join(', '),
    });
  if (f.tags?.length) out.push({ key: 'tags', label: f.tags.map((t) => `#${name(catalog?.tags, t)}`).join(' ') });
  if (f.weekdays?.length) out.push({ key: 'weekdays', label: f.weekdays.map((d) => WEEKDAYS[d - 1]).join(' ') });
  if (f.hours?.length)
    out.push({
      key: 'hours',
      label: f.hours
        .slice()
        .sort((a, b) => a - b)
        .map((h) => `${String(h).padStart(2, '0')}h`)
        .join(' '),
    });
  if (f.sessions?.length) out.push({ key: 'sessions', label: f.sessions.join(', ') });
  if (f.minPnl !== undefined || f.maxPnl !== undefined)
    out.push({ key: 'minPnl', label: range(f.minPnl, f.maxPnl, (v) => formatMoney(v, { signed: true })) });
  if (f.minR !== undefined || f.maxR !== undefined)
    out.push({ key: 'minR', label: range(f.minR, f.maxR, (v) => `${String(v)}R`) });
  if (f.minQty !== undefined || f.maxQty !== undefined)
    out.push({ key: 'minQty', label: `Size ${range(f.minQty, f.maxQty, String)}` });
  if (f.reviewed !== undefined) out.push({ key: 'reviewed', label: f.reviewed ? 'Reviewed' : 'Not reviewed' });
  if (f.minRating !== undefined) out.push({ key: 'minRating', label: `${String(f.minRating)}★ or more` });
  if (f.emotions?.length) out.push({ key: 'emotions', label: f.emotions.map(emotionWord).join(', ') });
  if (f.from || f.to)
    out.push({
      key: 'from',
      label:
        f.from && f.to
          ? `${dayLabel(f.from)} – ${dayLabel(f.to)}`
          : f.from
            ? `From ${dayLabel(f.from)}`
            : `To ${dayLabel(f.to!)}`,
    });
  if (f.ids?.length) out.push({ key: 'ids', label: `${String(f.ids.length)} picked` });
  return out;
}

export function withoutChip(f: TradeFilter, key: keyof TradeFilter): TradeFilter {
  const out: TradeFilter = { ...f };
  const pairs: Partial<Record<keyof TradeFilter, (keyof TradeFilter)[]>> = {
    minPnl: ['minPnl', 'maxPnl'],
    minR: ['minR', 'maxR'],
    minQty: ['minQty', 'maxQty'],
    from: ['from', 'to'],
  };
  const drop = new Set<string>(pairs[key] ?? [key]);
  return Object.fromEntries(Object.entries(out).filter(([k]) => !drop.has(k)));
}

export function toggle<T>(list: readonly T[] | undefined, v: T): T[] | undefined {
  const has = list?.includes(v) ?? false;
  const next = has ? (list ?? []).filter((x) => x !== v) : [...(list ?? []), v];
  return next.length ? next : undefined;
}
