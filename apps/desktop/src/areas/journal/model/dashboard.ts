import type { CalendarDay, ChecklistState, JournalTrade, Overview, Setup } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';
import { tone } from './format.ts';
import { plainText } from './markdown.ts';
import { addDays, rangeDates } from './scope.ts';

export type JournalStatus = 'not-started' | 'in-progress' | 'completed';

export function wordCount(md: string): number {
  const t = plainText(md);
  return t ? t.split(' ').length : 0;
}

export function checklistShare(items: readonly ChecklistState[]): number | null {
  if (!items.length) return null;
  return items.filter((i) => i.checked).length / items.length;
}

export function journalStatus(day: {
  startedAt: number | null;
  content: string;
  checklist: readonly ChecklistState[];
}): JournalStatus {
  const written = day.content.trim() !== '';
  if (day.startedAt === null && !written) return 'not-started';
  const share = checklistShare(day.checklist);
  if (share === null ? written : share >= 1) return 'completed';
  return 'in-progress';
}

export function journalCompletion(days: readonly CalendarDay[], today: string): { done: number; total: number } {
  const traded = days.filter((d) => d.stats.n > 0 && d.date <= today);
  return { done: traded.filter((d) => d.journaled).length, total: traded.length };
}

export function priorDays(today: string): { from: string; to: string } {
  return { from: rangeDates('30d', today).from ?? today, to: addDays(today, -1) };
}

export function vsAvgDay(
  net: number,
  prior: Pick<Overview, 'avgDay'> | undefined,
): { text: string; tone: ReturnType<typeof tone> } | null {
  const avg = prior?.avgDay ?? null;
  if (avg === null) return null;
  const vs = net - avg;
  return { text: `${vs < 0 ? '▼' : '▲'} ${formatMoney(vs, { signed: true })} vs avg day`, tone: tone(vs) };
}

export function streakKind(d: CalendarDay | undefined): 'journaled' | 'missed' | 'none' {
  if (!d || d.stats.n === 0) return 'none';
  return d.journaled ? 'journaled' : 'missed';
}

export function excerpt(md: string, max = 180): string {
  const t = plainText(md);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

export function ago(ns: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ns / 1e6) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${String(Math.floor(s / 60))}m ago`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))}h ago`;
  return `${String(Math.floor(s / 86_400))}d ago`;
}

export function topSetups(setups: readonly Setup[], n = 3): { top: Setup[]; more: number } {
  const traded = setups.filter((s) => s.stats.n > 0).sort((a, b) => b.stats.net - a.stats.net);
  return { top: traded.slice(0, n), more: Math.max(0, traded.length - n) };
}

export function pnlCurve(newestFirst: readonly Pick<JournalTrade, 'netPnl'>[]): number[] {
  return newestFirst.map((t) => t.netPnl).reverse();
}

export function complianceTone(share: number | null): 'up' | 'down' | 'brass' | 'mist' {
  if (share === null) return 'mist';
  if (share >= 0.8) return 'up';
  return share >= 0.5 ? 'brass' : 'down';
}
