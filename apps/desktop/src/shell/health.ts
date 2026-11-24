import type { ConnectionStatus, HealthStatus, ProviderHealth, TradingAccount } from '@tessera/protocol';
import type { DotState } from '@tessera/ui';
import { healthWords } from '../accounts/connections.ts';
import type { Holding } from '../app/portfolio.ts';
import { ordinal } from './deskWords.ts';

export function dotFor(status: HealthStatus): DotState {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'degraded':
      return 'degraded';
    case 'down':
      return 'down';
    case 'disconnected':
    case 'unknown':
    case 'disabled':
      return 'off';
  }
}

export interface HealthProblem {
  key: string;
  severity: 'down' | 'stale';
  text: string;
  src: string;
  fact: string;
  next?: string;
  action?: 'retry' | 'connections';
}

export interface LinkState {
  status: ConnectionStatus;
  everConnected: boolean;
  attempt: number;
  lastErrorCode?: string | null;
}

function linkProblem(link: LinkState): HealthProblem {
  const code = link.lastErrorCode ?? null;
  const base = { key: 'runtime', severity: 'down' as const, src: 'Runtime' };
  if (code === 'session_expired' || code === 'session_missing') {
    const fact = code === 'session_expired' ? 'restarted with a new token.' : 'has no session for this page.';
    const next = 'Open the latest link it printed (…/#ticket=…).';
    return { ...base, fact, next, text: `Runtime ${fact} ${next}` };
  }
  if (code === 'data_dir_locked') {
    const fact = 'dropped. Another runtime holds the data directory.';
    return { ...base, fact, next: 'Retrying.', action: 'retry', text: `Runtime ${fact} Retrying.` };
  }
  if (code === 'runtime_failed') {
    const fact = 'failed to restart; its output is in the bun run dev terminal.';
    return { ...base, fact, next: 'Retrying.', action: 'retry', text: `Runtime ${fact} Retrying.` };
  }
  const next = link.attempt > 1 ? `Reconnecting, ${ordinal(link.attempt)} try.` : 'Reconnecting.';
  return { ...base, fact: 'dropped.', next, action: 'retry', text: `Runtime dropped. ${next}` };
}

export function healthProblems(link: LinkState, providers: readonly ProviderHealth[]): HealthProblem[] {
  if (link.everConnected && link.status !== 'open') return [linkProblem(link)];
  const failing = providers.filter((p) => p.kind !== 'agent' && (p.status === 'down' || p.status === 'degraded'));
  const out: HealthProblem[] = [];
  for (const p of [...failing].sort((a, b) => Number(b.status === 'down') - Number(a.status === 'down'))) {
    const down = p.status === 'down';
    const name = p.kind === 'runtime' ? 'Runtime' : p.displayName;
    const fact = healthWords(p);
    out.push({
      key: p.kind === 'runtime' ? 'runtime' : p.providerId,
      severity: down ? 'down' : 'stale',
      text: `${name}: ${fact}`,
      src: name,
      fact,
      action: p.kind === 'runtime' ? undefined : 'connections',
    });
  }
  return out;
}

export function exposedPositions(
  runtimeDown: boolean,
  providers: readonly ProviderHealth[],
  positions: readonly Holding[],
  accounts: readonly TradingAccount[],
): Holding[] {
  const open = positions.filter((p) => p.qty !== 0);
  if (runtimeDown) return open;
  const down = new Set(providers.filter((p) => p.status === 'down').map((p) => p.providerId));
  const connectionOf = new Map(accounts.map((a) => [a.id, a.connectionId]));
  return open.filter((p) => {
    const connection = connectionOf.get(p.accountId);
    return connection !== undefined && down.has(connection);
  });
}
