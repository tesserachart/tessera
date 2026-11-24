import type { AccountUpdate, LimitsSetting, LimitsStatus, RiskLimits, Timestamp } from '@tessera/protocol';
import { normalizeEpochMs } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';
import { displayZone } from '../state/timeZone.ts';

export const LIMIT_KEYS = [
  'dailyLossLimit',
  'maxRiskPerTrade',
  'maxOrderQty',
  'maxPositionQty',
  'maxTradesPerDay',
] as const satisfies readonly (keyof RiskLimits)[];
export type LimitKey = (typeof LIMIT_KEYS)[number];

export function limitKind(key: LimitKey): 'money' | 'count' {
  return key === 'dailyLossLimit' || key === 'maxRiskPerTrade' ? 'money' : 'count';
}

const NEAR = 0.8;

function positive(v: unknown, whole: boolean): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return whole ? Math.floor(v) || undefined : v;
}

function readSet(v: unknown): RiskLimits {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const out: RiskLimits = {};
  for (const k of LIMIT_KEYS) {
    const n = positive(o[k], limitKind(k) === 'count');
    if (n !== undefined) out[k] = n;
  }
  return out;
}

export function readLimits(v: unknown): LimitsSetting {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const accounts: Record<string, RiskLimits> = {};
  if (o.accounts && typeof o.accounts === 'object')
    for (const [id, set] of Object.entries(o.accounts as Record<string, unknown>)) accounts[id] = readSet(set);
  return {
    every: readSet(o.every),
    accounts,
    useFirmLimits: o.useFirmLimits === true,
    allowEarlyUnlock: o.allowEarlyUnlock === true,
  };
}

export function limitsValue(s: LimitsSetting): Record<string, unknown> {
  const out: Record<string, unknown> = { every: readSet(s.every) };
  const ids = Object.keys(s.accounts);
  if (ids.length) out.accounts = Object.fromEntries(ids.map((id) => [id, readSet(s.accounts[id])]));
  if (s.useFirmLimits) out.useFirmLimits = true;
  if (s.allowEarlyUnlock) out.allowEarlyUnlock = true;
  return out;
}

export function setIsOff(set: RiskLimits): boolean {
  return LIMIT_KEYS.every((k) => set[k] === undefined);
}

export function withLimit(s: LimitsSetting, scope: string | null, key: LimitKey, value: number | null): LimitsSetting {
  const from = scope === null ? s.every : (s.accounts[scope] ?? s.every);
  const set: RiskLimits = {};
  for (const k of LIMIT_KEYS) {
    const v = k === key ? value : from[k];
    if (v !== null && v !== undefined) set[k] = v;
  }
  return scope === null ? { ...s, every: set } : { ...s, accounts: { ...s.accounts, [scope]: set } };
}

export function withOwn(s: LimitsSetting, accountId: string, own: boolean): LimitsSetting {
  const accounts = Object.fromEntries(Object.entries(s.accounts).filter(([id]) => id !== accountId));
  if (own) accounts[accountId] = { ...(s.accounts[accountId] ?? s.every) };
  return { ...s, accounts };
}

export function parseLimit(text: string, key: LimitKey): number | null | 'invalid' {
  const t = text.replace(/[$,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return 'invalid';
  if (limitKind(key) === 'count') return Number.isInteger(n) ? n : 'invalid';
  return Math.round(n * 100) / 100;
}

export function standingWords(l: LimitsStatus | null | undefined): string | null {
  if (!l) return null;
  if (l.locked && l.lockedWhy) return l.lockedWhy;
  const parts: string[] = [];
  if (l.dailyLossLimit && l.dailyLossLeft)
    parts.push(`${formatMoney(l.dailyLossLeft)} of ${formatMoney(l.dailyLossLimit)} left today`);
  if (l.maxTradesPerDay !== null && l.tradesToday !== null)
    parts.push(`${String(l.tradesToday)} of ${String(l.maxTradesPerDay)} trades today`);
  if (l.firmRoom) parts.push(`${formatMoney(l.firmRoom)} under the firm’s rules`);
  return parts.length ? parts.join(' · ') : 'Within your limits';
}

export function untilWords(ns: number, asOf: number, zone: string = displayZone()): string {
  const ms = normalizeEpochMs(ns);
  const nowMs = normalizeEpochMs(asOf);
  const hm = new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone });
  if (ms - nowMs < 24 * 3600 * 1000) return hm;
  return `${new Date(ms).toLocaleDateString('en-US', { weekday: 'short', timeZone: zone })} ${hm}`;
}

export type LockCause =
  | { kind: 'manual'; until: Timestamp }
  | { kind: 'daily_loss'; until: Timestamp | null }
  | { kind: 'firm_rules' }
  | { kind: 'firm_platform' };

export function lockCause(l: LimitsStatus | null | undefined): LockCause | null {
  if (!l?.locked) return null;
  if (l.lockedUntil !== undefined)
    return { kind: l.lockKind === 'manual' ? 'manual' : 'daily_loss', until: l.lockedUntil };
  if (l.dailyLossLimit && l.dailyLossLeft?.amount === 0) return { kind: 'daily_loss', until: null };
  if (l.firmRoom?.amount === 0) return { kind: 'firm_rules' };
  return { kind: 'firm_platform' };
}

export function limitLockWords(update: AccountUpdate | null | undefined): string | null {
  const l = update?.limits;
  const cause = lockCause(l);
  if (!l || !cause) return null;
  switch (cause.kind) {
    case 'manual':
      return `Trading locked until ${untilWords(cause.until, l.asOf)} · exits, stops and targets work`;
    case 'daily_loss':
      return cause.until === null
        ? 'Daily loss limit reached · exits work'
        : `Daily loss limit reached · new entries from ${untilWords(cause.until, l.asOf)} · exits work`;
    case 'firm_rules':
      return 'Your firm’s rules leave no room · exits work';
    case 'firm_platform':
      return 'Your firm’s platform has the account locked · exits work';
  }
}

export interface TradeAtLimits {
  stopRisk: number | null;
  qty: number | null;
  position: number;
}

export function limitLine(update: AccountUpdate | null | undefined, t: TradeAtLimits): string | null {
  const l = update?.limits;
  if (!update || !l) return null;
  const currency = update.account.currency;
  const lock = limitLockWords(update);
  if (lock) return lock;
  const over: string[] = [];
  const near: string[] = [];
  const opens = t.position === 0;
  if (l.maxOrderQty !== null && t.qty !== null && t.qty > l.maxOrderQty)
    over.push(`${String(t.qty)} contracts: over your ${String(l.maxOrderQty)} an order`);
  if (l.maxPositionQty !== null && t.qty !== null) {
    const held = Math.abs(t.position) + t.qty;
    if (t.position !== 0 && held > l.maxPositionQty)
      over.push(`Adding ${String(t.qty)} holds ${String(held)}: over your ${String(l.maxPositionQty)}`);
    else if (held > l.maxPositionQty)
      over.push(`${String(held)} contracts: over your ${String(l.maxPositionQty)} held`);
  }
  if (l.maxTradesPerDay !== null && l.tradesToday !== null && opens) {
    if (l.tradesToday >= l.maxTradesPerDay)
      over.push(`${String(l.tradesToday)} trades today: no new trades until tomorrow`);
    else if (l.tradesToday === l.maxTradesPerDay - 1) near.push(`Your last trade today (${String(l.maxTradesPerDay)})`);
  }
  if (l.maxRiskPerTrade) {
    const max = l.maxRiskPerTrade.amount;
    if (t.stopRisk === null) over.push(`No stop: your ${formatMoney(l.maxRiskPerTrade)} a trade needs one`);
    else if (t.stopRisk > max)
      over.push(
        `This stop risks ${formatMoney(t.stopRisk, { currency })}: over your ${formatMoney(l.maxRiskPerTrade)} a trade`,
      );
    else if (t.stopRisk >= max * NEAR)
      near.push(
        `This stop risks ${formatMoney(t.stopRisk, { currency })} of your ${formatMoney(l.maxRiskPerTrade)} a trade`,
      );
  }
  if (l.dailyLossLeft && t.stopRisk !== null) {
    const left = l.dailyLossLeft.amount;
    if (t.stopRisk > left)
      over.push(
        `This stop risks ${formatMoney(t.stopRisk, { currency })}: over the ${formatMoney(l.dailyLossLeft)} left today`,
      );
    else if (t.stopRisk >= left * NEAR)
      near.push(
        `This stop risks ${formatMoney(t.stopRisk, { currency })} of the ${formatMoney(l.dailyLossLeft)} left today`,
      );
  }
  const line = over[0] ?? near[0];
  return line ? `${line}.` : null;
}
