import type { AccountLockOutput, AccountUpdate, LockOption, LockSpan } from '@tessera/protocol';
import { runTool, useToolValue } from '../app/tools.ts';
import { deskToasts } from '../workspace/dock/deskToasts.ts';
import { untilWords } from './limits.ts';

export const UNLOCK_WORD = 'UNLOCK';

const LOCK_READS = ['risk.get_lock', 'risk.get_limits', 'portfolio.get_risk_status'] as const;

export function lockChipWords(update: AccountUpdate | null | undefined): string | null {
  const l = update?.limits;
  if (!l?.locked || l.lockedUntil === undefined) return null;
  return `Locked until ${untilWords(l.lockedUntil, l.asOf)}`;
}

interface LockRow {
  readonly key: string;
  readonly span: LockSpan;
  readonly label: string;
  readonly until: string | null;
  readonly why: string | null;
}

export function spanKey(span: LockSpan): string {
  switch (span.kind) {
    case 'minutes':
      return `minutes-${String(span.minutes)}`;
    case 'session':
      return `session-${span.session}`;
    default:
      return span.kind;
  }
}

function lockRow(o: LockOption, asOf: number): LockRow {
  return {
    key: spanKey(o.span),
    span: o.span,
    label: o.label,
    until: o.until === null ? null : untilWords(o.until, asOf),
    why: o.unavailable,
  };
}

export interface LockMenuGroups {
  readonly quick: readonly LockRow[];
  readonly day: readonly LockRow[];
  readonly sessions: readonly LockRow[];
}

export function lockMenu(out: AccountLockOutput, asOf: number): LockMenuGroups {
  const rows = out.options.map((o) => lockRow(o, asOf));
  return {
    quick: rows.filter((r) => r.span.kind === 'minutes'),
    day: rows.filter(
      (r) => r.span.kind === 'market_close' || r.span.kind === 'next_open' || r.span.kind === 'trading_day',
    ),
    sessions: rows.filter((r) => r.span.kind === 'session'),
  };
}

export function useLockState(accountId: string | null, instrument: string | null): AccountLockOutput | undefined {
  return useToolValue(
    'risk.get_lock',
    accountId === null ? null : { accountId, ...(instrument ? { instrument } : {}) },
    { keepPrevious: true, refreshEvery: 30_000 },
  );
}

function lockAccount(accountId: string, span: LockSpan, instrument: string | null) {
  return runTool(
    'risk.lock_account',
    { accountId, span, ...(instrument ? { instrument } : {}) },
    { refresh: LOCK_READS },
  );
}

export function unlockAccount(accountId: string, confirm: string) {
  return runTool('risk.unlock_account', { accountId, confirm }, { refresh: LOCK_READS });
}

export function unlockTyped(text: string): boolean {
  return text.trim() === UNLOCK_WORD;
}

export function refusal(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function lockTrading(account: AccountUpdate['account'], span: LockSpan, instrument: string | null): void {
  lockAccount(account.id, span, instrument).then(
    (out) =>
      deskToasts.push({
        key: `lock/${account.id}`,
        tone: 'ok',
        title: `${account.displayName}: ${out.summary}`,
        detail: out.copy ?? 'Exits, stops and targets still work.',
      }),
    (err: unknown) =>
      deskToasts.push({
        key: `lock/${account.id}`,
        tone: 'err',
        title: `${account.displayName} was not locked`,
        detail: refusal(err),
      }),
  );
}
