import type { BacktestTrade, CaseResult } from '@tessera/protocol';
import { PRICE_TEXT, cx, formatMoney } from '@tessera/ui';
import { useMemo } from 'react';
import { EquityGraph, wallDates } from '../../graphs/index.ts';
import { useDisplayZone } from '../../state/timeZone.ts';
import { dateValue } from './model.ts';
import { SPLIT_WORD, nsToMs, tradeCurve, tradeTime, type TradePoint } from './tester.ts';

const NO_TRADES = 'No closed trades in this run.';

function CurveTip({ p, t, zone }: { p: TradePoint; t: BacktestTrade; zone: string }) {
  return (
    <>
      <b>Trade {p.n}</b>
      <span className="text-t3">{tradeTime(t.exitTime, zone)}</span>
      <span>
        Trade <span className={t.pnl >= 0 ? 'up' : 'down'}>{formatMoney(t.pnl, { signed: true })}</span>
      </span>
      <span>Net {formatMoney(p.pnl, { signed: true })}</span>
      {p.drawdown < 0 ? <span className="text-t3">{formatMoney(p.drawdown)} from the high</span> : null}
    </>
  );
}

export function Equity({ run }: { run: CaseResult }) {
  const zone = useDisplayZone();
  const curve = useMemo(() => tradeCurve(run), [run]);
  if (!curve) return <p className="rs-wait">{NO_TRADES}</p>;
  const { points } = curve;
  const first = run.trades[0]!;
  const last = run.trades[run.trades.length - 1]!;
  const date = wallDates(nsToMs(first.exitTime), nsToMs(last.exitTime), zone);
  const tipOf = (i: number) => (points[i]?.kind === 'later' ? points[i - 1] : points[i]);
  return (
    <figure className="rs-equity">
      <EquityGraph
        samples={points.map((p) => ({ x: p.n, equity: p.pnl, peak: p.peak, drawdown: -p.drawdown }))}
        axis={{
          kind: 'trades',
          label: (n) => {
            const t = run.trades[n - 1];
            return t ? date(nsToMs(t.exitTime)) : '';
          },
        }}
        height={300}
        shade={{ from: curve.laterAt, before: SPLIT_WORD.development, after: SPLIT_WORD.later }}
        label={`Equity curve over ${String(run.trades.length)} trades, ${formatMoney(curve.end, { signed: true })} at the end`}
        ddLabel={`Drawdown, deepest ${formatMoney(curve.deepest)}`}
        empty={NO_TRADES}
        tip={(i) => {
          const p = tipOf(i);
          return p?.trade ? <CurveTip p={p} t={p.trade.trade} zone={zone} /> : null;
        }}
      />
      <figcaption className="rs-curve-cap">
        <span className={cx(PRICE_TEXT, curve.high > 0 && 'up')}>{formatMoney(curve.high)} high</span>
        <span>
          {dateValue(run.development.from, zone)} to {dateValue(run.later.to, zone)}
          {curve.laterAt < run.trades.length ? ' · later sessions shaded' : ''}
        </span>
        <span className={PRICE_TEXT}>{formatMoney(curve.deepest)} deepest drawdown</span>
      </figcaption>
    </figure>
  );
}
