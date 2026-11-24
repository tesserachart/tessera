import type { AdapterInfo, ImportLevelHistoryOutput, LevelImportInfo, SeriesCoverageInfo } from '@tessera/protocol';

export interface CoverageGroup {
  key: string;
  title: string;
  levels: string;
  span: string;
  origins: string;
}

const ORIGIN_WORD: Record<string, string> = { live: 'recorded', import: 'imported', backfill: 'backfilled' };

const count = (n: number) => n.toLocaleString('en-US');

export function coverageGroups(series: readonly SeriesCoverageInfo[]): CoverageGroup[] {
  const groups = new Map<string, SeriesCoverageInfo[]>();
  for (const s of series) {
    const k = `${s.vendor}\u0000${s.instrument}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const first = list.reduce((a, s) => (s.firstDate < a ? s.firstDate : a), list[0]!.firstDate);
    const last = list.reduce((a, s) => (s.lastDate > a ? s.lastDate : a), list[0]!.lastDate);
    const days = Math.max(...list.map((s) => s.days));
    const origins = new Map<string, number>();
    for (const s of list) {
      for (const [o, n] of Object.entries(s.origins)) origins.set(o, (origins.get(o) ?? 0) + n);
    }
    return {
      key,
      title: `${list[0]!.vendor} · ${list[0]!.instrument}`,
      levels: [...new Set(list.map((s) => s.level))].join(', '),
      span: `${first === last ? first : `${first} to ${last}`} · ${String(days)} ${days === 1 ? 'day' : 'days'}`,
      origins: [...origins.entries()].map(([o, n]) => `${ORIGIN_WORD[o] ?? o} ${count(n)}`).join(' · '),
    };
  });
}

export function importSummary(out: ImportLevelHistoryOutput): string[] {
  const lines: string[] = [];
  const dates =
    out.firstDate && out.lastDate
      ? out.firstDate === out.lastDate
        ? ` on ${out.firstDate}`
        : ` from ${out.firstDate} to ${out.lastDate} (${String(out.days)} days)`
      : '';
  lines.push(
    `${out.vendor}: ${count(out.records)} values read, ${count(out.imported)} new${
      out.duplicates ? `, ${count(out.duplicates)} already stored` : ''
    }${dates}.`,
  );
  if (out.series.length) {
    lines.push(out.series.map((s) => `${s.name}${s.label ? ` (${s.label})` : ''} on ${s.instrument}`).join(' · '));
  }
  if (out.unreadable) {
    const first = out.problems[0];
    lines.push(
      `${count(out.unreadable)} rows not read${first ? `; line ${String(first.line)}: ${first.message}` : ''}.`,
    );
  }
  lines.push(...out.notes.filter((n) => !n.startsWith('a dry run')));
  return lines;
}

export function importLine(i: LevelImportInfo, date: (ns: number) => string): string {
  const span = i.from !== null && i.to !== null ? ` · ${date(i.from)} to ${date(i.to)}` : '';
  return `${i.vendor}${span} · ${i.adapter}`;
}

export function adapterOptions(adapters: readonly AdapterInfo[]): { value: string; label: string }[] {
  return adapters.map((a) => ({
    value: a.name,
    label: `${a.vendor} (saved ${a.kind})`,
  }));
}
