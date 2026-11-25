import type { AgentSessionSummary, Origin, RunDigest, Study } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';
import { displaySymbol } from '../../market/instruments.ts';
import { dateIn, displayZone } from '../../state/timeZone.ts';
import { dayLabel } from '../journal/model/format.ts';
import { VERDICT_WORD } from './model.ts';

export type Shelf = 'active' | 'archived';

export type Entry =
  { kind: 'run'; id: string; run: RunDigest; study: Study } | { kind: 'study'; id: string; study: Study };

export function ledgerEntries(studies: readonly Study[], runs: readonly RunDigest[]): Entry[] {
  const byId = new Map(studies.map((s) => [s.id, s]));
  const ran = new Set(runs.map((r) => r.studyId));
  const unrun: Entry[] = studies.filter((s) => !ran.has(s.id)).map((study) => ({ kind: 'study', id: study.id, study }));
  const done = [...runs]
    .sort((a, b) => b.at - a.at)
    .flatMap((run): Entry[] => {
      const study = byId.get(run.studyId);
      return study ? [{ kind: 'run', id: run.runId, run, study }] : [];
    });
  return [...unrun, ...done];
}

function shelfOf(e: Entry): Shelf {
  return e.kind === 'run' && e.run.archivedAt !== null ? 'archived' : 'active';
}

export function onShelf(entries: readonly Entry[], shelf: Shelf): Entry[] {
  return entries.filter((e) => shelfOf(e) === shelf);
}

export function pickEntry(entries: readonly Entry[], selected: string | null): Entry | null {
  if (selected === null) return null;
  return entries.find((e) => e.id === selected) ?? entries.find((e) => e.study.id === selected) ?? null;
}

export type Source =
  | { kind: 'you' }
  | { kind: 'chat'; sessionId: string; title: string | null; gone: boolean }
  | { kind: 'client'; clientId: string }
  | { kind: 'unknown' };

function sourceOf(origin: Origin | null, sessions: readonly AgentSessionSummary[] | null): Source {
  if (origin === null) return { kind: 'unknown' };
  if (origin.kind === 'user') return { kind: 'you' };
  if (origin.kind === 'external') return { kind: 'client', clientId: origin.clientId };
  const chat = sessions?.find((s) => s.id === origin.sessionId);
  return {
    kind: 'chat',
    sessionId: origin.sessionId,
    title: chat ? chat.title || 'Untitled chat' : null,
    gone: sessions !== null && !chat,
  };
}

export function entrySource(e: Entry, sessions: readonly AgentSessionSummary[] | null): Source {
  const known = [e.kind === 'run' ? e.run.origin : null, e.study.origin].map((o) => sourceOf(o, sessions));
  return known.find((s) => s.kind === 'chat') ?? known.find((s) => s.kind !== 'unknown') ?? { kind: 'unknown' };
}

export function sourceWords(s: Source): string {
  switch (s.kind) {
    case 'you':
      return 'You';
    case 'chat':
      return s.title ?? (s.gone ? 'A deleted chat' : 'An analyst chat');
    case 'client':
      return s.clientId;
    case 'unknown':
      return 'Unknown';
  }
}

export function entryTotals(e: Entry): { trades: number; net: number } | null {
  if (e.kind !== 'run') return null;
  const base = e.run.cases[0];
  if (!base) return null;
  return {
    trades: base.development.trades + base.later.trades,
    net: base.development.netPnl + base.later.netPnl,
  };
}

export function entryState(e: Entry): { word: string; verdict: string } {
  if (e.kind === 'study') return { word: 'Not run', verdict: 'draft' };
  return { word: VERDICT_WORD[e.run.verdict], verdict: e.run.verdict };
}

export function marketWords(s: Study): string {
  return `${displaySymbol(s.data.instrument)} ${s.data.tf}`;
}

function entryDay(e: Entry, zone: string = displayZone()): string | null {
  return e.kind === 'run' ? dateIn(e.run.at / 1e6, zone) : null;
}

export function dayWords(day: string | null, today: string): string {
  if (day === null) return 'Not run yet';
  return day === today ? 'Today' : dayLabel(day);
}

export function groupByDay(
  entries: readonly Entry[],
  zone: string = displayZone(),
): { day: string | null; entries: Entry[] }[] {
  const out: { day: string | null; entries: Entry[] }[] = [];
  for (const e of entries) {
    const day = entryDay(e, zone);
    const last = out[out.length - 1];
    if (last?.day === day) last.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

function searchText(e: Entry, sessions: readonly AgentSessionSummary[] | null): string {
  const totals = entryTotals(e);
  return [
    e.study.name,
    e.study.family,
    e.study.hypothesis,
    marketWords(e.study),
    entryState(e).word,
    sourceWords(entrySource(e, sessions)),
    totals ? formatMoney(totals.net, { signed: true }) : '',
  ]
    .join(' ')
    .toLowerCase();
}

export function matching(
  entries: readonly Entry[],
  query: string,
  sessions: readonly AgentSessionSummary[] | null,
): Entry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((e) => {
    const text = searchText(e, sessions);
    return words.every((w) => text.includes(w));
  });
}
