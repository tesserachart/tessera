import type { JournalStats, JournalTrade, TradeDetail, TradeFilter } from '@tessera/protocol';
import { formatMoney, formatPrice } from '@tessera/ui';
import { askAnalyst } from '../../shell/tradeActions.ts';
import { setChartInstrument } from '../../workspace/controller.ts';
import { showArea } from '../store.ts';
import { dayLabel, pct, plural, rLabel, sideWord } from './model/format.ts';
import { runTool } from '../../app/tools.ts';

function ask(text: string): void {
  askAnalyst(text);
}

export function askAboutTrade(t: JournalTrade): void {
  const dp = t.priceDecimals;
  const exit = t.exitPrice === null ? 'still open' : `exit ${formatPrice(t.exitPrice, dp)}`;
  ask(
    `Review my ${t.symbol} ${sideWord(t.side).toLowerCase()} of ${dayLabel(t.tradeDate)} (journal trade ${t.id}): ` +
      `${String(t.qty)} at ${formatPrice(t.entryPrice, dp)}, ${exit}, net ${formatMoney(t.netPnl, { signed: true })}` +
      `${t.rMultiple === null ? '' : `, ${rLabel(t.rMultiple)}`}. Read it with journal.get_trade and the market around ` +
      `it. Keep what you measured apart from your interpretation: what was done well, and what to do differently?`,
  );
}

export function askAboutDay(date: string, n: number, net: number): void {
  ask(
    `Review my trading day ${dayLabel(date)} (${date}): ${plural(n, 'trade')}, net ${formatMoney(net, { signed: true })}. Read it with ` +
      `journal.get_day and each trade with journal.get_trade. What patterns do you see in my entries, exits and ` +
      `notes? Measured facts first, then your interpretation.`,
  );
}

export function askAboutPeriod(what: string, filter: TradeFilter, stats: JournalStats | null): void {
  const o = stats?.overview.all;
  const facts = o
    ? `: ${plural(o.n, 'trade')}, net ${formatMoney(o.net, { signed: true })}, win rate ${pct(o.winRate)}, profit factor ${o.profitFactor === null ? '—' : o.profitFactor.toFixed(2)}`
    : '';
  ask(
    `Review my journal for ${what}${facts}. Use journal.get_stats with the filter ${JSON.stringify(filter)} and ` +
      `journal.list_trades to look closer. Where is my edge and where do I lose? Say each bucket's n; small samples ` +
      `are noise.`,
  );
}

export async function openOnChart(d: TradeDetail): Promise<void> {
  const t = d.trade;
  showArea('desk');
  await setChartInstrument(t.instrument);
  const dp = t.priceDecimals;
  const marks = d.executions.map((e) =>
    runTool('chart.annotate', {
      kind: 'marker',
      points: [{ t: e.ts, price: e.price }],
      label: `${e.side === 'buy' ? 'B' : 'S'} ${String(e.qty)} @ ${formatPrice(e.price, dp)}`,
    }),
  );
  const levels = [
    t.stopPrice === null ? null : { price: t.stopPrice, label: 'Stop' },
    t.targetPrice === null ? null : { price: t.targetPrice, label: 'Target' },
  ]
    .filter((l): l is { price: number; label: string } => l !== null)
    .map((l) => runTool('chart.annotate', { kind: 'hline', points: [{ t: null, price: l.price }], label: l.label }));
  await Promise.allSettled([...marks, ...levels]);
}
