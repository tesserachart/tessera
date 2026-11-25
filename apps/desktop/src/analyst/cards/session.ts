import { tradeOpen } from '../../areas/journal/model/format.ts';
import type { SessionIssue, SessionTrade, TradingSessionReport } from '@tessera/protocol';
import { formatMoney, formatPrice, type ChatCardMark } from '@tessera/ui';
import { dateWords, sessionClock } from '../tradingSessions.ts';

export function sessionTitle(r: TradingSessionReport): string {
  return `${r.accountName} · ${dateWords(r.date)}`;
}

export function sessionMeta(r: TradingSessionReport): string {
  const n = r.trades.length;
  const trades = n === 0 ? 'no trades' : `${String(n)} trade${n === 1 ? '' : 's'}`;
  const net = n === 0 ? null : formatMoney(r.netPnl, { signed: true });
  return [`${sessionClock(r.startedAt)}–${sessionClock(r.endedAt)}`, trades, net].filter(Boolean).join(' · ');
}

export function tradeLabel(t: SessionTrade): string {
  return `${t.side === 'buy' ? 'Long' : 'Short'} ${String(t.qty)} ${t.symbol}`;
}

export function tradeWords(t: SessionTrade): string {
  const exit = tradeOpen(t) || t.exitPrice === null ? 'open' : formatPrice(t.exitPrice, t.priceDecimals);
  const r = t.rMultiple === null ? null : `${t.rMultiple.toFixed(2)}R`;
  return [
    sessionClock(t.openedAt),
    `${formatPrice(t.entryPrice, t.priceDecimals)} → ${exit}`,
    formatMoney(t.netPnl, { signed: true }),
    r,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function tradeMark(t: SessionTrade): ChatCardMark {
  if (tradeOpen(t)) return 'running';
  return t.netPnl < 0 ? 'failed' : 'done';
}

export function issueWords(i: SessionIssue): string {
  if (i.url) return 'Filed';
  return i.notFiled ? `Not filed: ${i.notFiled}` : 'Not filed';
}
