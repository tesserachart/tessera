import { formatMoney } from '@tessera/ui';
import { type BacktestTrade, type CaseResult, type SplitResult, type Study } from '@tessera/protocol';
import { guessSessionOptions, tradingDayZone } from '../../market/instruments.ts';
import { dateIn, displayZone, zonedFormat } from '../../state/timeZone.ts';
import { moneyCi, pct, pctCi } from './model.ts';

export type Split = 'development' | 'later';

export const SPLIT_WORD: Record<Split, string> = { development: 'Development', later: 'Later' };

const SESSIONS_PER_YEAR = 252;

export function nsToMs(ns: number): number {
  return Math.round(ns / 1e6);
}

const CLOCK = zonedFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function tradeTime(ns: number, zone: string = displayZone()): string {
  return `${dateIn(nsToMs(ns), zone)} ${CLOCK(zone).format(nsToMs(ns))}`;
}

function splitOf(t: Pick<BacktestTrade, 'entryTime'>, laterFrom: number): Split {
  return t.entryTime < laterFrom ? 'development' : 'later';
}

export function tradesOf(c: CaseResult, split: Split): BacktestTrade[] {
  return c.trades.filter((t) => splitOf(t, c.later.from) === split);
}

export function tradeDayZone(study: Pick<Study, 'data'>): string {
  return tradingDayZone(guessSessionOptions(study.data.instrument));
}

function tradeDay(t: Pick<BacktestTrade, 'exitTime'>, zone: string): string {
  return dateIn(nsToMs(t.exitTime), zone);
}

interface QuantStats {
  sharpe: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  worstStreak: number;
}

function quantStats(trades: readonly BacktestTrade[], sessions: number, zone: string): QuantStats {
  const n = trades.length;
  const byDay = new Map<string, number>();
  let streak = 0;
  let worstStreak = 0;
  for (const t of trades) {
    const day = tradeDay(t, zone);
    byDay.set(day, (byDay.get(day) ?? 0) + t.pnl);
    streak = t.pnl > 0 ? 0 : streak + 1;
    worstStreak = Math.max(worstStreak, streak);
  }
  return {
    sharpe: sessionSharpe([...byDay.values()], Math.max(sessions, byDay.size)),
    avgMae: n ? trades.reduce((s, t) => s + t.mae, 0) / n : null,
    avgMfe: n ? trades.reduce((s, t) => s + t.mfe, 0) / n : null,
    worstStreak,
  };
}

export function sessionSharpe(tradedSessions: readonly number[], sessions: number): number | null {
  if (sessions < 2 || tradedSessions.length === 0) return null;
  const sum = tradedSessions.reduce((s, v) => s + v, 0);
  const squares = tradedSessions.reduce((s, v) => s + v * v, 0);
  const mean = sum / sessions;
  const variance = (squares - sessions * mean * mean) / (sessions - 1);
  if (!(variance > 0)) return null;
  return (mean / Math.sqrt(variance)) * Math.sqrt(SESSIONS_PER_YEAR);
}

export interface MonthRow {
  month: string;
  splits: Split[];
  trades: number;
  wins: number;
  net: number;
}

export function monthBreakdown(c: CaseResult, zone: string): MonthRow[] {
  const rows = new Map<string, MonthRow>();
  for (const t of c.trades) {
    const month = tradeDay(t, zone).slice(0, 7);
    const row = rows.get(month) ?? { month, splits: [], trades: 0, wins: 0, net: 0 };
    const split = splitOf(t, c.later.from);
    if (!row.splits.includes(split)) row.splits.push(split);
    row.trades += 1;
    row.wins += t.pnl > 0 ? 1 : 0;
    row.net += t.pnl;
    rows.set(month, row);
  }
  return [...rows.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function monthWords(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 15)).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export interface TradePoint {
  kind: 'start' | 'trade' | 'later';
  n: number;
  pnl: number;
  peak: number;
  drawdown: number;
  trade: IndexedTrade | null;
}

export interface TradeCurve {
  points: TradePoint[];
  laterAt: number;
  high: number;
  deepest: number;
  end: number;
}

export function tradeCurve(c: CaseResult): TradeCurve | null {
  const trades = numberedTrades(c);
  if (!trades.length) return null;
  const points: TradePoint[] = [{ kind: 'start', n: 0, pnl: 0, peak: 0, drawdown: 0, trade: null }];
  let pnl = 0;
  let peak = 0;
  let high = 0;
  let deepest = 0;
  let laterAt = trades.length;
  for (const t of trades) {
    if (t.split === 'later' && laterAt === trades.length) {
      laterAt = t.n - 1;
      peak = pnl;
      if (laterAt > 0) points.push({ kind: 'later', n: laterAt, pnl, peak, drawdown: 0, trade: null });
    }
    pnl += t.trade.pnl;
    peak = Math.max(peak, pnl);
    high = Math.max(high, pnl);
    deepest = Math.min(deepest, pnl - peak);
    points.push({ kind: 'trade', n: t.n, pnl, peak, drawdown: pnl - peak, trade: t });
  }
  return { points, laterAt, high, deepest, end: pnl };
}

export type TradeKey = 'entryTime' | 'side' | 'exit' | 'bars' | 'mae' | 'mfe' | 'pnl';

const TRADE_ORDER: Record<TradeKey, (t: BacktestTrade) => number | string> = {
  entryTime: (t) => t.entryTime,
  side: (t) => (t.qty > 0 ? 0 : 1),
  exit: (t) => t.exit,
  bars: (t) => t.bars,
  mae: (t) => t.mae,
  mfe: (t) => t.mfe,
  pnl: (t) => t.pnl,
};

export interface IndexedTrade {
  n: number;
  trade: BacktestTrade;
  split: Split;
}

export function numberedTrades(c: CaseResult): IndexedTrade[] {
  return c.trades.map((trade, i) => ({ n: i + 1, trade, split: splitOf(trade, c.later.from) }));
}

export function sortTrades(rows: readonly IndexedTrade[], key: TradeKey, ascending: boolean): IndexedTrade[] {
  const order = TRADE_ORDER[key];
  const sign = ascending ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = order(a.trade);
    const y = order(b.trade);
    const by = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
    return by === 0 ? a.n - b.n : sign * by;
  });
}

export function sideWord(t: Pick<BacktestTrade, 'qty'>): string {
  return `${t.qty > 0 ? 'Long' : 'Short'} ${String(Math.abs(t.qty))}`;
}

interface StatValue {
  text: string;
  tone?: 'up' | 'down';
}

export interface StatRow {
  label: string;
  hint?: string;
  development: StatValue;
  later: StatValue;
}

function signed(v: number | null | undefined): StatValue {
  const text = formatMoney(v, { signed: true });
  if (v === null || v === undefined || v === 0 || !Number.isFinite(v)) return { text };
  return { text, tone: v > 0 ? 'up' : 'down' };
}

function plain(text: string): StatValue {
  return { text };
}

function ratio(v: number | null): StatValue {
  return plain(v === null || !Number.isFinite(v) ? '—' : v.toFixed(2));
}

export function testerStats(c: CaseResult, zone: string): { headline: StatRow[]; quant: StatRow[] } {
  const quant = {
    development: quantStats(tradesOf(c, 'development'), c.development.sessions, zone),
    later: quantStats(tradesOf(c, 'later'), c.later.sessions, zone),
  };
  const r = (label: string, of: (s: SplitResult, q: QuantStats) => StatValue, hint?: string): StatRow => ({
    label,
    ...(hint ? { hint } : {}),
    development: of(c.development, quant.development),
    later: of(c.later, quant.later),
  });
  return {
    headline: [
      r('Net', (s) => signed(s.metrics.netPnl)),
      r('Profit factor', (s) => ratio(s.metrics.profitFactor)),
      r('Win rate', (s) => plain(pct(s.metrics.winRate))),
      r('Max drawdown', (s) => plain(formatMoney(s.metrics.maxDrawdown))),
      r('Trades', (s) => plain(String(s.metrics.trades))),
    ],
    quant: [
      r(
        'Expectancy',
        (s) => ({ ...signed(s.metrics.avgTrade), text: moneyCi(s.metrics.avgTrade, s.meanCiBlock5) }),
        'Mean trade after costs, with its 95% interval from 5-session blocks',
      ),
      r(
        'Sharpe',
        (_s, q) => ratio(q.sharpe),
        'Mean session P&L over its spread, sessions without a trade counted as flat, times √252',
      ),
      r('Win rate (95%)', (s) => plain(pctCi(s.metrics.winRate, s.metrics.winRateCi))),
      r('Average win', (s) => signed(s.metrics.avgWin)),
      r('Average loss', (s) => signed(s.metrics.avgLoss)),
      r('Best trade', (s) => signed(s.metrics.largestWin)),
      r('Worst trade', (s) => signed(s.metrics.largestLoss)),
      r('Average MAE', (_s, q) => signed(q.avgMae), 'Mean of the most a trade was against you while open'),
      r('Average MFE', (_s, q) => signed(q.avgMfe), 'Mean of the most a trade was in your favour while open'),
      r('Longest losing run', (_s, q) => plain(String(q.worstStreak))),
      r('Bars held', (s) => plain(s.metrics.avgBars === null ? '—' : s.metrics.avgBars.toFixed(1))),
      r('Long · short', (s) => plain(`${String(s.metrics.longTrades)} · ${String(s.metrics.shortTrades)}`)),
      r('Trades per session', (s) => plain(s.tradesPerSession.toFixed(2))),
      r('Sessions', (s) => plain(String(s.sessions))),
      r('Costs', (s) => plain(formatMoney(s.metrics.costs))),
    ],
  };
}
