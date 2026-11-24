import type { Bucket, JournalStats } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';
import { pct, rLabel, tone } from './format.ts';

export interface Headline {
  label: string;
  text: string;
  tone?: 'up' | 'down' | undefined;
  hint: string;
  sub?: string;
}

function pf(b: Bucket): string {
  if (b.profitFactor !== null) return b.profitFactor.toFixed(2);
  return b.grossProfit > 0 ? '∞' : '—';
}

export function headline(s: JournalStats | null | undefined): Headline[] {
  const o = s?.overview;
  const a = o?.all;
  if (!o || !a) return [];
  const ci =
    o.winRateLow !== null && o.winRateHigh !== null
      ? `${o.winRateLow.toFixed(0)}–${o.winRateHigh.toFixed(0)}%`
      : undefined;
  const be = s.breakevenThreshold;
  return [
    {
      label: 'Net P&L',
      text: formatMoney(a.net, { signed: true }),
      tone: tone(a.net),
      hint: `Sum of closed trades' net P&L (after fees: ${formatMoney(-a.fees, { signed: true })}).`,
    },
    {
      label: 'Win rate',
      text: pct(a.winRate),
      ...(ci ? { sub: ci } : {}),
      hint: `${String(a.wins)} winners over ${String(a.wins + a.losses)} decided trades; ${String(a.breakevens)} within ±${formatMoney(be)} are breakeven and left out. The range is the Wilson 95% interval: how far chance alone could move it.`,
    },
    {
      label: 'Profit factor',
      text: pf(a),
      hint: `Gross profit ${formatMoney(a.grossProfit, { signed: true })} over gross loss ${formatMoney(-a.grossLoss, { signed: true })}.`,
    },
    {
      label: 'Expectancy',
      text: formatMoney(a.expectancy, { signed: true }),
      tone: tone(a.expectancy),
      hint: 'Win rate × average winner − loss rate × average loser: what a trade earned on average, measured, not promised.',
    },
    {
      label: 'Avg win · loss',
      text: `${formatMoney(a.avgWin, { signed: true })} · ${formatMoney(-a.avgLoss, { signed: true })}`,
      hint: `Average winner and loser; payoff ${o.payoffRatio === null ? '—' : o.payoffRatio.toFixed(2)}.`,
    },
    {
      label: 'Max drawdown',
      text: formatMoney(-o.maxDrawdown, { signed: true }),
      tone: o.maxDrawdown > 0 ? 'down' : undefined,
      hint: `Deepest fall of the equity curve from a peak${o.maxDrawdownPct === null ? '' : ` (${pct(o.maxDrawdownPct)} of that peak)`}; ${formatMoney(-o.currentDrawdown, { signed: true })} below the peak now.`,
    },
    {
      label: 'Trades',
      text: String(a.n),
      ...(o.open ? { sub: `${String(o.open)} open` } : {}),
      hint: `Closed trades over ${String(a.days)} trading days. Below about 30 trades, every rate here moves a lot by chance.`,
    },
    {
      label: 'Average R',
      text: rLabel(a.avgR),
      tone: tone(a.avgR),
      hint:
        a.nR > 0
          ? `Net P&L over the money at risk at the planned stop, on the ${String(a.nR)} trades with one.`
          : 'No trade here has a planned stop: add one on a trade (or trade with a bracket) to measure R.',
    },
  ];
}
