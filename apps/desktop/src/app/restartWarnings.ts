import type { AgentSessionSummary, Order, Position } from '@tessera/protocol';
import { sessionBusy } from '../analyst/activity.ts';
import { useAnalyst } from '../analyst/analystStore.ts';
import { isOpenOrder, useOpenOrders } from './orders.ts';
import { usePositions } from './portfolio.ts';

export interface RestartWarnings {
  readonly orders: number | null;
  readonly positions: number | null;
  readonly sessions: number | null;
}

export function restartWarnings(
  orders: readonly Order[] | null,
  positions: readonly Position[] | null,
  sessions: readonly AgentSessionSummary[] | null,
): RestartWarnings {
  return {
    orders: orders?.filter(isOpenOrder).length ?? null,
    positions: positions?.filter((p) => p.qty !== 0).length ?? null,
    sessions: sessions?.filter(sessionBusy).length ?? null,
  };
}

export function hasWarnings(w: RestartWarnings): boolean {
  return [w.orders, w.positions, w.sessions].some((n) => n === null || n > 0);
}

export function useRestartWarnings(): RestartWarnings {
  return restartWarnings(
    useOpenOrders(),
    usePositions(),
    useAnalyst((s) => s.sessions),
  );
}

const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export function restartWords(w: RestartWarnings): string[] {
  const words: string[] = [];
  const orders = w.orders ?? 0;
  const positions = w.positions ?? 0;
  if (orders + positions > 0) {
    const held = [
      orders > 0 ? count(orders, 'working order', 'working orders') : null,
      positions > 0 ? count(positions, 'open position', 'open positions') : null,
    ]
      .filter((part) => part !== null)
      .join(' and ');
    words.push(
      `You have ${held}. ${orders + positions === 1 ? 'It stays' : 'They stay'} at your broker, but Tessera will be offline for a moment while it restarts.`,
    );
  }
  const sessions = w.sessions ?? 0;
  if (sessions > 0) {
    words.push(
      sessions === 1
        ? '1 analyst session is in progress. The restart interrupts it; you can pick it up once Tessera is back.'
        : `${String(sessions)} analyst sessions are in progress. The restart interrupts them; you can pick them up once Tessera is back.`,
    );
  }
  if (w.orders === null || w.positions === null || w.sessions === null) {
    words.push('Tessera isn’t connected, so it can’t count your working orders and positions.');
  }
  return words;
}
