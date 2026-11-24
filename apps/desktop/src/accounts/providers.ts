import type { LevelSourceInfo, PoolCalls, SeriesCoverageInfo } from '@tessera/protocol';

const count = (n: number) => n.toLocaleString('en-US');

export function providerPackageKeys(infos: readonly LevelSourceInfo[]): Set<string> {
  return new Set(infos.flatMap((s) => s.packages.map((p) => p.key)));
}

export function requestWords(calls: readonly PoolCalls[]): string | null {
  if (calls.length === 0) return null;
  if (calls.length === 1 && calls[0]!.pool === 'default') {
    const c = calls[0]!;
    return c.cap !== null ? `${count(c.used)} of ${count(c.cap)} requests` : `${count(c.used)} requests`;
  }
  return calls.map((c) => `${c.pool} ${count(c.used)}${c.cap !== null ? ` of ${count(c.cap)}` : ''}`).join(' · ');
}

export function storedWords(series: readonly SeriesCoverageInfo[], vendor: string): string | null {
  const by = new Map<string, { first: string; last: string }>();
  for (const s of series) {
    if (s.vendor !== vendor) continue;
    const g = by.get(s.instrument);
    by.set(s.instrument, {
      first: g && g.first < s.firstDate ? g.first : s.firstDate,
      last: g && g.last > s.lastDate ? g.last : s.lastDate,
    });
  }
  if (by.size === 0) return null;
  return [...by.entries()]
    .map(([i, d]) => `${i} ${d.first === d.last ? d.first : `${d.first} to ${d.last}`}`)
    .join(' · ');
}

export function nyDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function backfillSpans(daysBack: number): { value: string; label: string }[] {
  return [
    { days: 7, label: 'Last week' },
    { days: 30, label: 'Last 30 days' },
    { days: 90, label: 'Last 90 days' },
  ]
    .filter((s) => s.days <= Math.max(daysBack, 7))
    .map((s) => ({ value: String(s.days), label: s.label }));
}

export function backfillRange(todayNy: string, days: number): { from: string; to: string } {
  const to = shift(todayNy, -1);
  return { from: shift(to, -(days - 1)), to };
}

export function backfillWords(files: readonly { status: string; imported: number }[], imported: number): string {
  const n = (s: string) => files.filter((f) => f.status === s).length;
  const would = n('would_ask');
  const already = n('already');
  const failed = n('failed');
  const later = n('later');
  const parts: string[] = [];
  if (would) parts.push(`${String(would)} ${would === 1 ? 'file' : 'files'} to ask for`);
  const stored = n('stored');
  if (stored) parts.push(`${count(imported)} values stored from ${String(stored)} ${stored === 1 ? 'file' : 'files'}`);
  if (already) parts.push(`${String(already)} stored before`);
  if (failed) parts.push(`${String(failed)} not read`);
  if (later) parts.push(`${String(later)} left for the next run`);
  return parts.length ? `${parts.join(' · ')}.` : 'Nothing to ask for in that span.';
}

export const ADD_WITH_ANALYST =
  'Help me add a provider of levels. Draft its spec from what I give you (its docs, a description, a sample answer), try it with intel.test_source on the sample (or live when it needs no key) and show me what it read under the vendor’s own names, then put it in Settings › Connections with intel.draft_source for me to try with my key and save. The provider: ';
