import type { CoverageDay, CoverageDownload, DataCoverage, Held } from '@tessera/protocol';
import type { ChatCardMark, ChatCardState } from '@tessera/ui';

export type Lane = 'prints' | 'bars';

export interface LaneCount {
  saved: number;
  partial: number;
  missing: number;
}

export interface DayRun {
  from: string;
  to: string;
  days: number;
  note: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayWords(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ''} ${String(d ?? '')}`;
}

export function count(days: readonly CoverageDay[], lane: Lane): LaneCount {
  const out: LaneCount = { saved: 0, partial: 0, missing: 0 };
  for (const d of days) out[d[lane]] += 1;
  return out;
}

export function laneMark(c: LaneCount): ChatCardMark {
  if (c.missing === 0 && c.partial === 0) return 'done';
  if (c.saved === 0 && c.partial === 0) return 'missing';
  return 'partial';
}

export function laneWords(c: LaneCount): string {
  const total = c.saved + c.partial + c.missing;
  const parts = [`${String(c.saved)} of ${String(total)} days saved`];
  if (c.partial) parts.push(`${String(c.partial)} in part`);
  if (c.missing) parts.push(`${String(c.missing)} missing`);
  return parts.join(' · ');
}

function noteOf(d: CoverageDay, lane: Lane): string | null {
  return lane === 'prints' || d.outOfReach ? (d.note ?? null) : null;
}

export function gaps(days: readonly CoverageDay[], lane: Lane): DayRun[] {
  const out: DayRun[] = [];
  let open = false;
  for (const d of days) {
    if (d[lane] === 'saved') {
      open = false;
      continue;
    }
    const note = noteOf(d, lane);
    const run = open ? out.at(-1) : undefined;
    if (run?.note === note) {
      run.to = d.date;
      run.days += 1;
    } else {
      out.push({ from: d.date, to: d.date, days: 1, note });
      open = true;
    }
  }
  return out;
}

export function runWords(r: DayRun): string {
  const span = r.days === 1 ? dayWords(r.from) : `${dayWords(r.from)} – ${dayWords(r.to)} (${String(r.days)} days)`;
  return r.note ? `${span} · ${r.note}` : span;
}

export function spanWords(c: DataCoverage): string {
  return `${c.scope === 'rth' ? 'RTH' : 'Session'} · ${dayWords(c.from)} – ${dayWords(c.to)}`;
}

export function dayTitle(d: CoverageDay): string {
  const word: Record<Held, string> = { saved: 'saved', partial: 'in part', missing: 'missing' };
  const said = `${dayWords(d.date)} · ${d.contract} · prints ${word[d.prints]} · bars ${word[d.bars]}`;
  return d.note && d.prints !== 'saved' ? `${said} · ${d.note}` : said;
}

export function leftWords(seconds: number): string {
  if (seconds < 60) return 'under a minute left';
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${String(m)} min left`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `about ${String(h)} h${rest ? ` ${String(rest)} min` : ''} left`;
}

export function downloadState(d: CoverageDownload | null): ChatCardState {
  if (!d) return 'idle';
  if (d.state === 'running') return 'running';
  if (d.state === 'cancelled') return 'cancelled';
  return d.failed > 0 ? 'failed' : 'done';
}

const daysWord = (n: number) => `${String(n)} ${n === 1 ? 'day' : 'days'}`;

function waitingWords(d: CoverageDownload): string | null {
  if (!d.waitingFor) return null;
  return d.waitingWhy ? `waiting for ${d.waitingFor}: ${d.waitingWhy}` : `waiting for ${d.waitingFor} to connect`;
}

function underWay(d: CoverageDownload): string | null {
  if (!d.current) return null;
  return `${dayWords(d.current)}${d.pieces ? `, ${String(d.piecesDone)} of ${String(d.pieces)} half hours` : ''}`;
}

export function downloadWords(d: CoverageDownload): string {
  const of = `${String(d.fetched)} of ${daysWord(d.fetching)}`;
  const tail = [
    d.later ? `${String(d.later)} still coming` : null,
    d.failed ? `${String(d.failed)} not sent` : null,
    d.outOfReach ? `${String(d.outOfReach)} older than the connection keeps` : null,
  ].filter(Boolean);
  if (d.state === 'cancelled') return ['Download stopped', of, ...tail].join(' · ');
  if (d.state !== 'running') {
    if (d.fetching === 0) return ['Saved', ...tail].join(' · ');
    if (d.fetched === d.fetching) return ['Saved', daysWord(d.fetched), ...tail].join(' · ');
    return [`Saved ${of}`, ...tail].join(' · ');
  }
  const waiting = waitingWords(d);
  const started = d.fetched > 0 || d.piecesDone > 0 || d.etaSeconds !== null;
  if (!started && !waiting) return d.fetching ? `Downloading ${daysWord(d.fetching)}…` : 'Downloading…';
  const left = d.etaSeconds === null || waiting ? null : leftWords(d.etaSeconds);
  return ['Downloading', of, waiting ?? underWay(d), left].filter(Boolean).join(' · ');
}
