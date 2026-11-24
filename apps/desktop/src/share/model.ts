import type { AccountState } from '@tessera/protocol';

const SHARE_ENTITLEMENT = 'share';

export const CHART_CANVAS_ATTR = 'data-chart-canvas';

export function canShare(account: AccountState | null): boolean {
  return (
    account?.phase === 'signed_in' && account.access === 'full' && account.entitlements.includes(SHARE_ENTITLEMENT)
  );
}

export function sharedOnWords(createdAt: string, zone: string, now: number): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return '';
  const sameYear =
    new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: zone }).format(at) ===
    new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: zone }).format(now);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: zone,
  }).format(at);
}
