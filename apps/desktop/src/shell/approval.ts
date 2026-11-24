import {
  normalizeEpochMs,
  type Approval,
  type ApprovalKind,
  type Bracket,
  type Environment,
  type JsonValue,
  type McpClientInfo,
  type Money,
  type OrderPreview,
  type OrderRequest,
  type Origin,
  type PreTradeCheck,
  type Quote,
} from '@tessera/protocol';
import { envKind, formatClock, formatMoney, formatPrice, type EnvKind } from '@tessera/ui';
import { kindLabel } from '../areas/settings/agentClients.ts';
import { displaySymbol } from '../market/instruments.ts';
import { entryBracket, expectedFill, legWords, type OcoConfig, type OcoMarket } from './oco.ts';
import { marketReference } from './ticket.ts';
import { displayZone } from '../state/timeZone.ts';

export const ARM_MS = 600;

const ENV_WORD: Record<Environment, string> = {
  paper: 'paper',
  sim: 'sim',
  eval: 'eval',
  funded: 'funded',
  live: 'LIVE',
};

export function approveLabel(kind: ApprovalKind, env: Environment | null): string {
  const verb = 'Approve';
  if (env !== null) return `${verb} on ${ENV_WORD[env]}`;
  return kind === 'financial' ? `${verb} · no account` : `${verb} change`;
}

export function approvalEnv(a: Pick<Approval, 'environment' | 'kind'>): EnvKind {
  if (a.environment) return envKind(a.environment);
  return a.kind === 'financial' ? 'live' : 'paper';
}

export function expiresIn(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const s = Math.ceil(ms / 1000);
  return `expires in ${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
}

export function validUntil(staleAtMs: number, nowMs: number): string {
  if (!Number.isFinite(staleAtMs) || staleAtMs <= nowMs) return 'expired';
  return `valid until ${formatClock(staleAtMs, displayZone(), false)}`;
}

export function draftedBy(
  origin: Origin,
  sessionTitle?: string | null,
  clients: readonly McpClientInfo[] = [],
): string {
  switch (origin.kind) {
    case 'agent':
      return sessionTitle ? `${sessionTitle} · drafted by the analyst` : 'Drafted by the analyst';
    case 'external': {
      const name = clients.find((c) => c.id === origin.clientId)?.name;
      return `Drafted by ${!name || name === kindLabel('other') ? 'an MCP client' : name}`;
    }
    case 'user':
      return 'Drafted by you';
  }
}

export function isExpired(a: Pick<Approval, 'status' | 'staleAt'>, nowMs: number): boolean {
  return a.status === 'stale' || normalizeEpochMs(a.staleAt) <= nowMs;
}

export function toolTitle(tool: string): string {
  const last = tool.split('.').pop() ?? tool;
  const words = last.replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : tool;
}

interface Fact {
  label: string;
  value: string;
}

export interface OrderLines {
  side: 'Buy' | 'Sell';
  qty: string;
  symbol: string;
  pre: string;
  price: string | null;
  post: string;
}

export interface ApprovalView {
  heading: string;
  copies: { words: string; accounts: string[] } | null;
  order: OrderLines | null;
  title: string | null;
  restatement: string | null;
  facts: Fact[];
  checks: PreTradeCheck[];
  blocked: boolean;
  raw: string | null;
}

const TIF: Record<OrderRequest['tif'], string> = { day: 'day', gtc: 'GTC', ioc: 'IOC', fok: 'FOK' };

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asOrderPreview(v: JsonValue): OrderPreview | null {
  if (!isObject(v) || !isObject(v.request)) return null;
  const r = v.request;
  if ((r.side !== 'buy' && r.side !== 'sell') || typeof r.qty !== 'number' || typeof r.instrument !== 'string')
    return null;
  return v as unknown as OrderPreview;
}

function money(m: Money | null): string | null {
  return m ? formatMoney(m) : null;
}

const qtyFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });

export function orderLines(r: OrderRequest, precision = 2): OrderLines {
  const px = (p: number | null) => (p === null ? null : formatPrice(p, precision));
  const tif = TIF[r.tif];
  const base = {
    side: r.side === 'buy' ? ('Buy' as const) : ('Sell' as const),
    qty: qtyFmt.format(r.qty),
    symbol: displaySymbol(r.instrument),
  };
  let pre = 'at';
  let price: string | null = null;
  let post = `market · ${tif}`;
  if (r.orderType === 'limit') {
    price = px(r.limitPrice);
    post = `limit · ${tif}`;
  } else if (r.orderType === 'stop') {
    pre = 'stop at';
    price = px(r.stopPrice);
    post = `· ${tif}`;
  } else if (r.orderType === 'stop_limit') {
    pre = 'stop';
    price = px(r.stopPrice);
    post = `, limit ${px(r.limitPrice) ?? '—'} · ${tif}`;
  }
  return { ...base, pre, price, post };
}

function positionWord(qty: number): string {
  if (qty === 0) return 'Flat';
  return `${qty > 0 ? 'Long' : 'Short'} ${qtyFmt.format(Math.abs(qty))}`;
}

function scalar(v: JsonValue): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

export function copiesOf(preview: JsonValue): ApprovalView['copies'] {
  if (!isObject(preview) || !isObject(preview.copies)) return null;
  const { words, accounts } = preview.copies;
  if (typeof words !== 'string' || !Array.isArray(accounts)) return null;
  return { words, accounts: accounts.filter((x): x is string => typeof x === 'string') };
}

export function describeApproval(a: Approval, precision = 2): ApprovalView {
  const order = asOrderPreview(a.preview);
  const copies = copiesOf(a.preview);
  if (order) {
    const pos = order.request.qty === 0 ? null : order.positionAfter;
    const facts: Fact[] = [
      { label: 'Stop', value: legWords(order.request.bracket, 'stop', precision) },
      { label: 'Target', value: legWords(order.request.bracket, 'target', precision) },
      { label: 'Risk', value: money(order.riskToStop) },
      { label: 'After fill', value: pos === null ? null : positionWord(pos) },
      { label: 'Value', value: money(order.estValue) },
      { label: 'Est. fees', value: money(order.estFees) },
    ]
      .filter((f): f is Fact => f.value !== null)
      .slice(0, 4);
    return {
      heading: 'Draft',
      copies,
      order: orderLines(order.request, precision),
      title: null,
      restatement: order.restatement || null,
      facts,
      checks: order.checks,
      blocked: order.checks.some((c) => c.severity === 'block'),
      raw: null,
    };
  }
  const p = a.preview;
  const restatement = isObject(p) && typeof p.restatement === 'string' ? p.restatement : null;
  const facts: Fact[] = isObject(p)
    ? Object.entries(p)
        .filter(([k]) => k !== 'restatement')
        .map(([k, v]) => ({ label: toolTitle(k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()), value: scalar(v) }))
        .filter((f): f is Fact => f.value !== null)
        .slice(0, 6)
    : [];
  const readable = restatement !== null || facts.length > 0;
  return {
    heading: a.kind === 'financial' ? 'Draft' : 'Change',
    copies,
    order: null,
    title: toolTitle(a.tool),
    restatement,
    facts,
    checks: [],
    blocked: false,
    raw: readable || p === null ? null : JSON.stringify(p, null, 2).slice(0, 800),
  };
}

export interface EntryLegs {
  bracket: Bracket | null;
  risk: string | null;
  yours: string | null;
  input: JsonValue | null;
}

export interface YourBracket {
  oco: OcoConfig;
  market: OcoMarket;
  quote: Pick<Quote, 'bid' | 'ask' | 'last'> | undefined;
}

type LegRole = 'stop' | 'target';

function opensOrAdds(order: OrderPreview): boolean {
  const { side, reduceOnly } = order.request;
  if (reduceOnly) return false;
  const after = order.positionAfter;
  return after === null || (side === 'buy' ? after > 0 : after < 0);
}

function entryPrice(r: OrderRequest): number | null {
  if (r.orderType === 'limit' || r.orderType === 'stop_limit') return r.limitPrice;
  if (r.orderType === 'stop') return r.stopPrice;
  return null;
}

function hasLeg(b: Bracket | null | undefined, role: LegRole): boolean {
  if (!b) return false;
  return role === 'stop'
    ? b.stopLoss !== null || b.stopTicks !== undefined
    : b.takeProfit !== null || b.targetTicks !== undefined;
}

function withLegOf(b: Bracket, from: Bracket, role: LegRole): Bracket {
  const out: Bracket = { ...b };
  if (role === 'stop') {
    out.stopLoss = from.stopLoss;
    delete out.stopTicks;
    if (from.stopTicks !== undefined) out.stopTicks = from.stopTicks;
    delete out.breakeven;
    delete out.trail;
    if (from.breakeven) out.breakeven = from.breakeven;
    if (from.trail) out.trail = from.trail;
  } else {
    out.takeProfit = from.takeProfit;
    delete out.targetTicks;
    if (from.targetTicks !== undefined) out.targetTicks = from.targetTicks;
  }
  return out;
}

function stopTicksFrom(b: Bracket, fill: number | null, tick: number): number | null {
  if (b.stopTicks !== undefined) return b.stopTicks;
  return b.stopLoss !== null && fill !== null ? Math.round(Math.abs(fill - b.stopLoss) / tick) : null;
}

const legsFromForm = new Set<string>();

export function setLegsFromForm(draftId: string | null, on: boolean): void {
  if (draftId === null) return;
  if (on) legsFromForm.add(draftId);
  else legsFromForm.delete(draftId);
}

export function hasLegsFromForm(draftId: string | null): boolean {
  return draftId !== null && legsFromForm.has(draftId);
}

export function entryLegs(
  a: Pick<Approval, 'tool' | 'input'>,
  order: OrderPreview,
  yours: YourBracket | null,
): EntryLegs | null {
  if (a.tool !== 'orders.submit' || !opensOrAdds(order)) return null;
  const r = order.request;
  const drafted = r.bracket;
  const price = entryPrice(r);
  const touch = marketReference(r.side, yours?.quote);
  const planned = yours ? entryBracket(r.side, r.orderType, price, touch, yours.oco, yours.market) : null;
  const added = (['stop', 'target'] as const).filter((role) => !hasLeg(drafted, role) && hasLeg(planned, role));
  if (added.length === 0 || !yours || !planned || !isObject(a.input)) {
    return { bracket: drafted, risk: money(order.riskToStop), yours: null, input: null };
  }
  const bracket = added.reduce(
    (b, role) => withLegOf(b, planned, role),
    drafted ?? { stopLoss: null, takeProfit: null },
  );
  let risk = money(order.riskToStop);
  if (added.includes('stop')) {
    const m = yours.market;
    const ticks = stopTicksFrom(bracket, expectedFill(r.side, r.orderType, price, touch), m.tick);
    risk =
      ticks === null
        ? null
        : money({ amount: ticks * m.tickValue * r.qty, currency: order.estValue?.currency ?? 'USD' });
  }
  const words = added.length === 2 ? 'stop and target' : added[0] === 'stop' ? 'stop' : 'target';
  return {
    bracket,
    risk,
    yours: `${words} from your bracket`,
    input: { ...a.input, bracket } as unknown as JsonValue,
  };
}

export interface EditField {
  path: string;
  label: string;
  value: string;
  kind: 'number' | 'text';
}

const FIXED = new Set(['account', 'accountId', 'clientOrderId', 'idempotencyKey']);

function humanize(key: string): string {
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words[0]!.toUpperCase() + words.slice(1);
}

export function editFields(input: JsonValue): EditField[] {
  if (!isObject(input)) return [];
  const out: EditField[] = [];
  const visit = (obj: { [key: string]: JsonValue }, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (FIXED.has(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number' || v === null) {
        out.push({ path, label: humanize(k), value: v === null ? '' : String(v), kind: 'number' });
      } else if (typeof v === 'string') {
        out.push({ path, label: humanize(k), value: v, kind: 'text' });
      } else if (!prefix && isObject(v)) {
        visit(v, k);
      }
    }
  };
  visit(input, '');
  return out;
}

export function applyEdit(
  input: JsonValue,
  fields: readonly EditField[],
  values: Readonly<Record<string, string>>,
): JsonValue {
  if (!isObject(input)) return input;
  const next = structuredClone<{ [key: string]: JsonValue }>(input);
  for (const f of fields) {
    const raw = (values[f.path] ?? f.value).trim();
    let value: JsonValue;
    if (f.kind === 'number') {
      const n = Number(raw.replace(/,/g, ''));
      if (raw !== '' && !Number.isFinite(n)) throw new Error(`${f.label} is not a number`);
      value = raw === '' ? null : n;
    } else {
      value = raw;
    }
    const [head, leaf] = f.path.split('.') as [string, string | undefined];
    if (leaf === undefined) next[head] = value;
    else {
      const inner = next[head];
      if (isObject(inner)) inner[leaf] = value;
    }
  }
  return next;
}
