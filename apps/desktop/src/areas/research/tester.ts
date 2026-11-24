import type { TradeOverlay } from '@tessera/chart';
import { formatMoney } from '@tessera/ui';
import {
  timeframeMs,
  type BacktestEquityPoint,
  type BacktestTrade,
  type CaseResult,
  type SplitResult,
  type GetCandlesInput,
  type Study,
  type StudyRun,
} from '@tessera/protocol';
import { guessSessionOptions, tradingDayZone } from '../../market/instruments.ts';
import { dateIn, displayZone, zonedFormat } from '../../state/timeZone.ts';
import { moneyCi, pct, pctCi } from './model.ts';

export type Split = 'development' | 'later';

export const SPLIT_WORD: Record<Split, string> = { development: 'Development', later: 'Later' };

const SESSIONS_PER_YEAR = 252;
const CANDLE_LIMIT = 5000;
const CHART_SPAN_BARS = 2000;

function nsToMs(ns: number): number {
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

export interface CurvePoint {
  time: number;
  pnl: number;
  drawdown: number;
}

export function curveOf(points: readonly BacktestEquityPoint[], width: number): CurvePoint[] {
  const start = points[0]?.equity ?? 0;
  const step = Math.max(1, Math.floor(points.length / Math.max(1, width)));
  const out: CurvePoint[] = [];
  let peak = start;
  let deepest = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    peak = Math.max(peak, p.equity);
    deepest = Math.min(deepest, p.equity - peak);
    if (i % step === 0 || i === points.length - 1) {
      out.push({ time: p.time, pnl: p.equity - start, drawdown: deepest });
      deepest = 0;
    }
  }
  return out;
}

export interface CurveFrame {
  points: CurvePoint[];
  t0: number;
  t1: number;
  low: number;
  high: number;
  deepest: number;
}

export function curveFrame(points: readonly BacktestEquityPoint[], width: number): CurveFrame | null {
  const pts = curveOf(points, width);
  if (pts.length < 2) return null;
  let low = 0;
  let high = 0;
  let deepest = 0;
  for (const p of pts) {
    low = Math.min(low, p.pnl);
    high = Math.max(high, p.pnl);
    deepest = Math.min(deepest, p.drawdown);
  }
  return { points: pts, t0: pts[0]!.time, t1: pts[pts.length - 1]!.time, low, high, deepest };
}

export function xOfTime(f: Pick<CurveFrame, 't0' | 't1'>, time: number, w: number): number {
  return ((time - f.t0) / (f.t1 - f.t0 || 1)) * w;
}

export function linePath(
  f: CurveFrame,
  w: number,
  h: number,
  value: (p: CurvePoint) => number,
  lo: number,
  hi: number,
) {
  const span = hi - lo || 1;
  return f.points
    .map((p, i) => {
      const x = xOfTime(f, p.time, w).toFixed(1);
      const y = (h - ((value(p) - lo) / span) * h).toFixed(1);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join('');
}

export function nearestPoint(f: CurveFrame, fraction: number): CurvePoint {
  const time = f.t0 + Math.min(1, Math.max(0, fraction)) * (f.t1 - f.t0);
  let best = f.points[0]!;
  for (const p of f.points) if (Math.abs(p.time - time) < Math.abs(best.time - time)) best = p;
  return best;
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

export const EXIT_WORD: Record<BacktestTrade['exit'], string> = {
  signal: 'Signal',
  stop: 'Stop',
  target: 'Target',
  end_of_data: 'End of data',
};

export function tradeOverlay(t: BacktestTrade, colors: TradeOverlay['colors']): TradeOverlay {
  const long = t.qty > 0;
  const open = nsToMs(t.entryTime);
  const close = nsToMs(t.exitTime);
  const qty = Math.abs(t.qty);
  return {
    long,
    open,
    close,
    entry: t.entryPrice,
    exit: t.exitPrice,
    stop: t.stop === null ? [] : [{ t: open, price: t.stop }],
    target: t.target === null ? [] : [{ t: open, price: t.target }],
    fills: [
      { t: open, price: t.entryPrice, side: long ? 'buy' : 'sell', qty },
      { t: close, price: t.exitPrice, side: long ? 'sell' : 'buy', qty },
    ],
    mae: null,
    mfe: null,
    colors,
  };
}

export function candlesInput(
  study: Pick<Study, 'data'>,
  run: Pick<StudyRun, 'from' | 'to'>,
  around: Pick<BacktestTrade, 'entryTime' | 'exitTime'> | null,
): GetCandlesInput {
  const step = timeframeMs(study.data.tf) * 1e6;
  const base = {
    instrument: study.data.instrument,
    tf: study.data.tf,
    limit: CANDLE_LIMIT,
    session: study.data.rthOnly ? 'rth' : 'all',
  } as const;
  const lastBar = run.to + step;
  if ((lastBar - run.from) / step <= CANDLE_LIMIT || around === null) {
    return { ...base, from: run.from, to: lastBar };
  }
  const half = (CHART_SPAN_BARS / 2) * step;
  const mid = (around.entryTime + around.exitTime) / 2;
  const from = Math.max(run.from, Math.min(mid - half, lastBar - 2 * half));
  return { ...base, from, to: Math.min(lastBar, from + 2 * half) };
}

export function inCandles(input: GetCandlesInput, t: Pick<BacktestTrade, 'entryTime' | 'exitTime'>): boolean {
  return (input.from ?? -Infinity) <= t.entryTime && t.exitTime <= (input.to ?? Infinity);
}

export function tradeFrame(t: BacktestTrade, stepMs: number, lastMs: number): { from: number; to: number } {
  const open = nsToMs(t.entryTime);
  const close = nsToMs(t.exitTime);
  const pad = Math.max(48 * stepMs, (close - open) * 1.5);
  return { from: open - pad, to: Math.min(lastMs, close + pad) };
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
