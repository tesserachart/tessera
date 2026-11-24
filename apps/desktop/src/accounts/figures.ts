import { normalizeEpochMs, type AccountUpdate, type Money, type RiskStatus } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';
import { displayZone } from '../state/timeZone.ts';

const LOW_SHARE = 0.25;

export function todayWords(dayPnl: Money | null | undefined): string {
  return dayPnl ? `${formatMoney(dayPnl, { signed: true })} today` : '';
}

export function dailyLeftLow(r: RiskStatus | null | undefined): boolean {
  const left = r?.dailyLossRemaining?.amount;
  const limit = r?.dailyLossLimit?.amount;
  return left !== undefined && limit !== undefined && limit > 0 && left < limit * LOW_SHARE;
}

export function trailLow(r: RiskStatus | null | undefined): boolean {
  const room = r?.trailingRoom?.amount;
  const hwm = r?.highWaterMark?.amount;
  const threshold = r?.trailingThreshold?.amount;
  if (room === undefined || hwm === undefined || threshold === undefined) return false;
  const distance = hwm - threshold;
  return distance > 0 && room < distance * LOW_SHARE;
}

export function dailyLossLeft(u: AccountUpdate): { left: Money; low: boolean } | null {
  const l = u.limits;
  if (l?.dailyLossLeft && l.dailyLossLimit)
    return { left: l.dailyLossLeft, low: l.dailyLossLeft.amount < l.dailyLossLimit.amount * LOW_SHARE };
  const r = u.risk;
  return r?.dailyLossRemaining ? { left: r.dailyLossRemaining, low: dailyLeftLow(r) } : null;
}

function clockTime(ts: number): string {
  return new Date(normalizeEpochMs(ts)).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: displayZone(),
  });
}

export function lockedWords(r: RiskStatus | null | undefined): string | null {
  if (!r?.locked) return null;
  return r.lockedUntil !== null ? `Locked until ${clockTime(r.lockedUntil)} · exits work` : 'Locked · exits work';
}

export function contractLimitWords(r: RiskStatus | null | undefined): string | null {
  const l = r?.contractLimits;
  if (!l) return null;
  const parts: string[] = [];
  if (l.buy !== null) parts.push(`${String(l.buy)} long`);
  if (l.sell !== null) parts.push(`${String(l.sell)} short`);
  if (l.perOrder !== null) parts.push(`${String(l.perOrder)} an order`);
  return parts.length ? parts.join(' · ') : null;
}

export const ENV_WORDS: Record<AccountUpdate['account']['environment'], string> = {
  paper: 'Paper: simulated by Tessera',
  sim: 'Simulated by the broker',
  eval: 'Evaluation: simulated money under a firm’s rules',
  funded: 'Funded: real payouts under a firm’s rules',
  live: 'Live: real money',
};

export function workingWords(working: number): string {
  return working > 0 ? `${String(working)} working` : '';
}
