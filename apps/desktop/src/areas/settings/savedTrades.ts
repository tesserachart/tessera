import type {
  ExportTradesInput,
  ExportTradesOutput,
  PullRequest,
  PullSummary,
  HistoryPulled,
  SavedContractInfo,
  Scope,
} from '@tessera/protocol';
import { sizeWords } from './words.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

const count = (n: number) => n.toLocaleString('en-US');
export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

export const SCOPE_OPTIONS: readonly { value: Scope; label: string }[] = [
  { value: 'rth', label: 'RTH' },
  { value: 'session', label: 'Full session' },
];

const SCOPE_WORD: Record<Scope, string> = { rth: 'RTH', session: 'full session' };

function parts(iso: string): { y: number; m: number; d: number } | null {
  const hit = ISO.exec(iso);
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? { y, m, d } : null;
}

export function dayWords(iso: string, withYear = false): string {
  const p = parts(iso);
  if (!p) return iso;
  const day = `${MONTHS[p.m - 1]!} ${String(p.d)}`;
  return withYear ? `${day}, ${String(p.y)}` : day;
}

export function rangeWords(from: string, to: string): string {
  if (from === to) return dayWords(from, true);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${dayWords(from, !sameYear)} to ${dayWords(to, true)}`;
}

export function pullTitle(r: PullRequest): string {
  return `${r.instrument.toUpperCase()} · ${rangeWords(r.from, r.to)} · ${SCOPE_WORD[r.scope]}`;
}

export function pullStateWords(p: PullSummary): string {
  if (p.state === 'cancelled') return 'Cancelled';
  if (p.state === 'done') {
    if (p.progress.failed) return 'Done, some days failed';
    return p.progress.later ? 'Done, some days still coming' : 'Done';
  }
  if (!p.current) return p.progress.waiting ? 'Waiting its turn' : 'Finishing';
  if (p.current.waitingFor) {
    return p.current.waitingWhy
      ? `Waiting for ${p.current.waitingFor}: ${p.current.waitingWhy}`
      : `Waiting for ${p.current.waitingFor} to connect`;
  }
  const pct = p.current.pieces ? Math.floor((p.current.piecesDone / p.current.pieces) * 100) : 0;
  return `Fetching ${dayWords(p.current.date)} · ${String(pct)}%`;
}

export function progressWords(p: PullSummary): string {
  const g = p.progress;
  const done = g.days - g.waiting;
  const out = [`${count(done)} of ${plural(g.days, 'day')}`];
  if (g.saved) out.push(`${count(g.saved)} fetched`);
  if (g.alreadySaved) out.push(`${count(g.alreadySaved)} already saved`);
  if (g.noTrades) out.push(`${count(g.noTrades)} without trades`);
  if (g.outOfReach) out.push(`${count(g.outOfReach)} older than the connection keeps`);
  if (g.later) out.push(`${count(g.later)} not all sent yet`);
  if (g.failed) out.push(`${count(g.failed)} failed`);
  if (g.prints) out.push(plural(g.prints, 'print'));
  return out.join(' · ');
}

export function failureWords(p: PullSummary): string | null {
  const failed = p.days.flatMap((d) => (d.status.kind === 'failed' ? [{ date: d.date, reason: d.status.reason }] : []));
  const first = failed[0];
  if (!first) return null;
  const more = failed.length > 1 ? ` (and ${plural(failed.length - 1, 'other day')})` : '';
  return `${dayWords(first.date)} failed${more}: ${first.reason}`;
}

export interface PullActions {
  cancel: boolean;
  resume: boolean;
}

export function pullActions(p: PullSummary): PullActions {
  return {
    cancel: p.state === 'running',
    resume: p.state === 'cancelled' || (p.state === 'done' && p.progress.failed + p.progress.later > 0),
  };
}

export function finishedDays(pulls: readonly PullSummary[] | undefined): number {
  return (pulls ?? []).reduce((n, p) => n + p.progress.days - p.progress.waiting, 0);
}

export function anyRunning(pulls: readonly PullSummary[] | undefined): boolean {
  return (pulls ?? []).some((p) => p.state === 'running');
}

const PULLS_RUNNING_EVERY_MS = 1_000;
const PULLS_IDLE_EVERY_MS = 5_000;

export function pullsRefreshEvery(pulls: readonly PullSummary[] | undefined, shown: boolean): number | undefined {
  if (!shown) return undefined;
  return anyRunning(pulls) ? PULLS_RUNNING_EVERY_MS : PULLS_IDLE_EVERY_MS;
}

export function contractHelp(c: SavedContractInfo): string {
  const span = c.first && c.last ? rangeWords(c.first, c.last) : 'nothing yet';
  return `${c.source} · ${span}`;
}

export function pulledLines(p: HistoryPulled): readonly [string, string] {
  const used = (u: HistoryPulled['today']) => `${sizeWords(u.bytes)} · ${plural(u.requests, 'request')}`;
  return [`Today ${used(p.today)}`, `7 days ${used(p.week)}`];
}

export function contractFact(c: SavedContractInfo): string {
  return `${plural(c.days, 'day')} · ${plural(c.prints, 'print')}`;
}

export interface PullForm {
  instrument: string;
  from: string;
  to: string;
  scope: Scope;
}

export type FormRead = { ok: true; request: PullRequest } | { ok: false; why: string };

export function readPullForm(f: PullForm): FormRead {
  const instrument = f.instrument.trim();
  if (!instrument) return { ok: false, why: 'Name a contract (NQZ6) or a root (NQ).' };
  if (!parts(f.from)) return { ok: false, why: 'Pick the first day.' };
  if (!parts(f.to)) return { ok: false, why: 'Pick the last day.' };
  if (f.from > f.to) return { ok: false, why: 'The first day is after the last.' };
  return { ok: true, request: { instrument, from: f.from, to: f.to, scope: f.scope } };
}

const isoOf = (d: Date) =>
  `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DEFAULT_PULL_DAYS = 91;

export function defaultPullForm(today: Date): PullForm {
  const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - DEFAULT_PULL_DAYS);
  return { instrument: 'NQ', from: isoOf(from), to: isoOf(to), scope: 'rth' };
}

export function exportFolder(dataDir: string | null | undefined): string {
  if (!dataDir) return '';
  const sep = dataDir.includes('\\') && !dataDir.includes('/') ? '\\' : '/';
  return `${dataDir.replace(/[\\/]+$/, '')}${sep}exports`;
}

export function pullExport(p: PullSummary, dir: string): ExportTradesInput {
  return { ...p.request, dir };
}

export function contractExport(c: SavedContractInfo, dir: string): ExportTradesInput | null {
  if (!c.first || !c.last) return null;
  return { instrument: c.instrument, from: c.first, to: c.last, scope: 'session', dir, source: c.source };
}

export function exportWords(out: ExportTradesOutput): string {
  const partial = out.files.filter((f) => !f.complete).length;
  const said = [`${plural(out.files.length, 'file')} in ${out.dir}`];
  if (partial) said.push(`${plural(partial, 'day')} saved only in part`);
  if (out.missing.length) said.push(`${plural(out.missing.length, 'day')} with nothing saved`);
  return said.join(' · ');
}
