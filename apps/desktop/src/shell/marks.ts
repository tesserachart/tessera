import type { Approval } from '@tessera/protocol';

export function isFinancialDraft(a: Approval): boolean {
  return a.risk === 'financial' && a.status === 'pending';
}

export function windowTitle(opts: {
  symbol: string | null;
  last: string | null;
  pct: string | null;
  drafts: number;
}): string {
  const market = [opts.symbol, opts.last, opts.pct].filter((s): s is string => !!s).join(' ');
  const parts = [market || 'Tessera'];
  if (opts.drafts > 0) parts.push(`${String(opts.drafts)} draft${opts.drafts === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
