import type { PullEstimate, PullRequest, PullSummary } from '@tessera/protocol';
import { makeStore } from '../../app/store.ts';
import { displaySymbol } from '../../market/instruments.ts';
import { plural } from './savedTrades.ts';
import { sizeWords } from './words.ts';

export const HISTORY_REFRESH_MS = 2_000;

export const OFFER_HEADING = 'Your market data stays on this computer';
export const OFFER_LABEL = 'Download the last week';
export const OFFER_STARTED = 'Downloading the last week';
export const OFFER_LATER = 'Settings › Data can download it later';
export const NOTHING_PICKED = 'Pick a market to download';
const ALREADY_SAVED = 'Already on this computer';
const DOWNLOADING_NOW = 'Downloading now. The status bar shows how far it is.';
export const NO_MARKETS = 'No markets to download yet';

export function offerLede(connection: string): string {
  return `Tessera charts the prices of your own feed, ${connection}, and saves what it reads here, nowhere else. Replay and the order-flow studies read that saved history, so a week of it fills them from the first day.`;
}

export interface OfferRow {
  input: string;
  estimate: PullEstimate;
  running: boolean;
}

const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export function offerMarkets(desk: readonly string[], watchlistRoots: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of [...desk, ...watchlistRoots]) {
    const input = raw.trim();
    if (input && !out.some((o) => same(o, input))) out.push(input);
  }
  return out;
}

export function deskRoots(
  instruments: readonly string[],
  specs: readonly ({ instrument: string; root: string | null } | null | undefined)[],
): string[] {
  const roots: string[] = [];
  instruments.forEach((_, i) => {
    const spec = specs[i];
    if (spec) roots.push(spec.root ?? spec.instrument);
  });
  return roots;
}

const askedDays = (e: PullEstimate): number => e.days - e.outOfReach;

const isSaved = (e: PullEstimate): boolean => e.saved >= askedDays(e);

export const isKnown = (e: PullEstimate): boolean => e.size !== null && e.seconds !== null;

export const isOpen = (row: OfferRow): boolean => !row.running && !isSaved(row.estimate);

export function offerRows(
  inputs: readonly string[],
  answers: ReadonlyMap<string, PullEstimate>,
  running: ReadonlySet<string> = new Set(),
): OfferRow[] {
  const rows: OfferRow[] = [];
  const contracts = new Set<string>();
  for (const input of inputs) {
    const estimate = answers.get(input);
    if (!estimate || askedDays(estimate) <= 0 || contracts.has(estimate.contract)) continue;
    contracts.add(estimate.contract);
    rows.push({ input, estimate, running: running.has(estimate.id) });
  }
  return rows;
}

export type Selection = { kind: 'desk' } | { kind: 'picked'; inputs: readonly string[] };

export const FOLLOWS_DESK: Selection = { kind: 'desk' };

export function checkedInputs(
  rows: readonly OfferRow[],
  desk: readonly string[],
  selection: Selection,
): ReadonlySet<string> {
  const open = rows.filter(isOpen);
  const chosen =
    selection.kind === 'desk'
      ? open.filter((r) => desk.some((d) => same(d, r.input)))
      : open.filter((r) => selection.inputs.includes(r.input));
  return new Set(chosen.map((r) => r.input));
}

export function toggled(
  rows: readonly OfferRow[],
  desk: readonly string[],
  selection: Selection,
  input: string,
): Selection {
  const next = new Set(checkedInputs(rows, desk, selection));
  if (!next.delete(input)) next.add(input);
  return { kind: 'picked', inputs: [...next] };
}

export function requestsOf(rows: readonly OfferRow[], checked: ReadonlySet<string>): PullRequest[] {
  return rows.filter((r) => checked.has(r.input)).map((r) => r.estimate.request);
}

export const marketName = (e: PullEstimate): string => displaySymbol(e.contract);

export function unknownWhy(kind: 'size' | 'time', root: string): string {
  return kind === 'size'
    ? `Tessera measures a day’s size from the trades of ${root.toUpperCase()} it has saved from this connection. None are saved yet.`
    : 'Tessera times downloads by this connection’s own pace. None has run yet.';
}

export function durationWords(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
}

export interface RowWords {
  days: string;
  size: string;
  why: string | null;
}

export function rowWords(row: OfferRow): RowWords {
  const { estimate } = row;
  const days = plural(askedDays(estimate), 'day');
  if (row.running) return { days, size: 'downloading', why: DOWNLOADING_NOW };
  if (isSaved(estimate)) return { days, size: 'saved', why: ALREADY_SAVED };
  if (estimate.size === null) return { days, size: 'size not known yet', why: unknownWhy('size', row.input) };
  return { days, size: `about ${sizeWords(estimate.size.bytes)}`, why: null };
}

export interface TotalWords {
  lead: string;
  hint: string | null;
  why: string | null;
}

export function totalWords(rows: readonly OfferRow[], checked: ReadonlySet<string>): TotalWords | null {
  const picked = rows.filter((r) => checked.has(r.input));
  if (picked.length === 0) return null;
  const sizeless = picked.find((r) => r.estimate.size === null);
  if (sizeless) return { lead: '', hint: 'Size not known yet', why: unknownWhy('size', sizeless.input) };
  const bytes = picked.reduce((n, r) => n + (r.estimate.size?.bytes ?? 0), 0);
  const timeless = picked.find((r) => r.estimate.seconds === null);
  if (timeless)
    return {
      lead: `About ${sizeWords(bytes)} · `,
      hint: 'time not known yet',
      why: unknownWhy('time', timeless.input),
    };
  const seconds = picked.reduce((n, r) => n + (r.estimate.seconds ?? 0), 0);
  return {
    lead: `About ${sizeWords(bytes)} and ${durationWords(seconds)}. It runs in the background while you chart.`,
    hint: null,
    why: null,
  };
}

export type HistoryProgress =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; days: number; lines: string[] }
  | { kind: 'failed'; days: number };

const doneDays = (p: PullSummary) => p.progress.days - p.progress.waiting;

function pullName(p: PullSummary): string {
  const newest = p.days.at(-1)?.contract;
  return newest ? displaySymbol(newest) : p.request.instrument.toUpperCase();
}

export function historyProgress(pulls: readonly PullSummary[], seen: readonly string[]): HistoryProgress {
  const running = pulls.filter((p) => p.state === 'running');
  if (running.length > 0)
    return {
      kind: 'running',
      done: running.reduce((n, p) => n + doneDays(p), 0),
      days: running.reduce((n, p) => n + p.progress.days, 0),
      lines: running.map((p) => `${pullName(p)} · ${String(doneDays(p))} of ${plural(p.progress.days, 'day')}`),
    };
  const failed = pulls.filter((p) => seen.includes(p.id)).reduce((n, p) => n + p.progress.failed, 0);
  return failed > 0 ? { kind: 'failed', days: failed } : { kind: 'idle' };
}

export function statusWords(p: Exclude<HistoryProgress, { kind: 'idle' }>): { shown: string; name: string } {
  return p.kind === 'running'
    ? {
        shown: `History ${String(p.done)}/${String(p.days)} days`,
        name: `Downloading history: ${String(p.done)} of ${String(p.days)} days`,
      }
    : { shown: `History: ${plural(p.days, 'day')} failed`, name: `History: ${plural(p.days, 'day')} failed` };
}

export const historyStore = makeStore<{ ran: readonly string[] }>({ ran: [] });
