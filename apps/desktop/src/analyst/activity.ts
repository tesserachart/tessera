import type { SessionOptions } from '@tessera/chart';
import type { AgentSessionSummary, Approval, OrderRequest } from '@tessera/protocol';
import { formatPrice } from '@tessera/ui';
import type { Transcript } from '../app/agentTranscript.ts';
import { displaySymbol, sessionOptionsFor, tradingDayZone } from '../market/instruments.ts';
import { zoneOffsetMs } from '../state/timeZone.ts';
import { asOrderPreview, toolTitle } from '../shell/approval.ts';

type AnalystPhase = 'idle' | 'working' | 'waiting' | 'stopped';

export interface Activity {
  phase: AnalystPhase;
  words: string | null;
  since: number | null;
}

export const IDLE: Activity = { phase: 'idle', words: null, since: null };

export function activityWords(t: Transcript): string {
  const status = t.status && t.status.state !== 'idle' ? t.status : null;
  if (status?.text) return status.text;
  for (let i = t.items.length - 1; i >= 0; i--) {
    const it = t.items[i]!;
    if (it.kind === 'tool' && it.outcome === 'running') return it.title ?? toolTitle(it.tool);
    if (it.kind === 'user' || it.kind === 'turn') break;
  }
  if (status?.state === 'thinking') return 'Thinking';
  if (status?.state === 'writing') return 'Writing';
  if (status?.state === 'waiting_approval') return 'Waiting for you';
  if (status?.state === 'running_tool') return 'Running a tool';
  return 'Thinking';
}

function lastTurnFailed(t: Transcript): boolean {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const it = t.items[i]!;
    if (it.kind === 'user') return false;
    if (it.kind === 'error') return true;
    if (it.kind === 'turn') return it.end === 'failed';
  }
  return false;
}

export function sessionBusy(session: AgentSessionSummary): boolean {
  return session.status === 'running' || session.status === 'needs_you';
}

export function analystActivity(t: Transcript | null, session: AgentSessionSummary | null): Activity {
  if (!t) {
    if (session?.status === 'running') return { phase: 'working', words: 'Working', since: null };
    if (session?.status === 'needs_you') return { phase: 'waiting', words: 'Waiting for you', since: null };
    return IDLE;
  }
  const running =
    (t.turnStartedAt !== null || (t.status !== null && t.status.state !== 'idle')) &&
    (session === null || sessionBusy(session));
  if (running) {
    const waiting = t.status?.state === 'waiting_approval';
    return { phase: waiting ? 'waiting' : 'working', words: activityWords(t), since: t.turnStartedAt };
  }
  if (lastTurnFailed(t)) return { phase: 'stopped', words: 'Stopped', since: null };
  return IDLE;
}

export function isWorking(a: Activity): boolean {
  return a.phase === 'working' || a.phase === 'waiting';
}

export function needsYouCount(approvals: readonly Approval[], sessions: readonly AgentSessionSummary[]): number {
  const withApproval = new Set(approvals.map((a) => a.sessionId).filter((id): id is string => id !== null));
  const asking = sessions.filter((s) => s.status === 'needs_you' && !withApproval.has(s.id)).length;
  return approvals.length + asking;
}

export function waitingIn(approvals: readonly Approval[], sessionId: string): number {
  return approvals.filter((a) => a.sessionId === sessionId).length;
}

function orderWords(r: OrderRequest): string {
  return `${r.side === 'buy' ? 'Buy' : 'Sell'} ${String(r.qty)} ${displaySymbol(r.instrument)}`;
}

function priceWords(r: OrderRequest, precision: number): string {
  if (r.orderType === 'market') return 'market';
  const px = r.orderType === 'limit' ? r.limitPrice : r.stopPrice;
  const kind = r.orderType === 'stop_limit' ? 'stop limit' : r.orderType;
  return px === null ? kind : `${kind} ${formatPrice(px, precision)}`;
}

export function jumpWords(a: Approval): string {
  const order = asOrderPreview(a.preview);
  if (a.kind === 'financial') return order ? `Draft waits · ${orderWords(order.request)}` : 'Draft waits';
  return `Waits for you · ${toolTitle(a.tool)}`;
}

export function notifyBody(a: Approval, precision = 2): string {
  const order = asOrderPreview(a.preview);
  if (order) return `Draft · ${orderWords(order.request)} ${priceWords(order.request, precision)}`;
  return `${a.kind === 'financial' ? 'Draft' : 'Change'} · ${toolTitle(a.tool)}`;
}

export function briefLabel(symbol: string | null, lastActivityMs: number | null, dayStartMs: number): string | null {
  if (!symbol) return null;
  if (lastActivityMs !== null && lastActivityMs >= dayStartMs) return null;
  return `Brief ${symbol} for today`;
}

export function briefPrompt(symbol: string): string {
  return `Brief me on ${symbol} for today's session: where it is against yesterday's levels, what matters, what I should watch.`;
}

export interface Starter {
  label: string;
  note: string;
  prompt: string;
}

export function starters(symbol: string | null, opts: { brief: boolean; levels: boolean }): Starter[] {
  if (!symbol) return [];
  const out: Starter[] = [];
  if (opts.brief)
    out.push({
      label: `Brief ${symbol} for today`,
      note: 'Against yesterday’s levels',
      prompt: briefPrompt(symbol),
    });
  if (opts.levels) {
    out.push({
      label: `Where ${symbol} trades against its levels`,
      note: 'Measured apart from the vendor’s model',
      prompt: `Where is ${symbol} trading against the levels on my chart? Say how far each is, and which are measured and which are the vendor's model.`,
    });
  }
  out.push({
    label: `Plan a pullback entry on ${symbol}`,
    note: 'Drafted for you to review',
    prompt: `Plan a pullback entry on ${symbol} with a stop and a target from the chart. Draft it for me to review; send nothing.`,
  });
  out.push({
    label: `What moved ${symbol} this session`,
    note: 'The data apart from the reading of it',
    prompt: `What moved ${symbol} this session? Separate what the data shows from your reading of it.`,
  });
  return out.slice(0, 4);
}

export function tradingDayStart(nowMs: number, day: SessionOptions = sessionOptionsFor('cme_globex')): number {
  const off = zoneOffsetMs(tradingDayZone(day), nowMs);
  const local = nowMs + off;
  const midnight = Math.floor(local / 86_400_000) * 86_400_000;
  let start = midnight + day.dayStartMinutes * 60_000;
  if (start > local) start -= 86_400_000;
  return start - off;
}

export function resumable(
  sessions: readonly AgentSessionSummary[] | null,
  currentId: string | null,
  n = 3,
): AgentSessionSummary[] {
  return (sessions ?? [])
    .filter((s) => s.id !== currentId && !['', 'analyst', 'new session'].includes(s.title.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, n);
}
