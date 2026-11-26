import type { BacktestEquityPoint } from '@tessera/protocol';
import { PRICE_TEXT, cx, formatMoney } from '@tessera/ui';
import { useMemo } from 'react';
import { EquityGraph } from '../../graphs/index.ts';
import { useDisplayZone } from '../../state/timeZone.ts';
import { dateValue } from './model.ts';
import { SPLIT_WORD, curveFrame, nsToMs, tradeTime, type CurvePoint } from './tester.ts';

const CURVE_POINTS = 1000;

function CurveTip({ p }: { p: CurvePoint }) {
  return (
    <>
      <b>{tradeTime(p.time)}</b>
      <span>
        Net <span className={p.pnl >= 0 ? 'up' : 'down'}>{formatMoney(p.pnl, { signed: true })}</span>
      </span>
      {p.drawdown < 0 ? <span className="text-t3">{formatMoney(p.drawdown)} from the high</span> : null}
    </>
  );
}

export function Equity({ points, laterFrom }: { points: readonly BacktestEquityPoint[]; laterFrom: number | null }) {
  const zone = useDisplayZone();
  const frame = useMemo(() => curveFrame(points, CURVE_POINTS), [points]);
  if (!frame) return <p className="rs-wait">Too few bars to draw.</p>;
  const end = frame.points[frame.points.length - 1]!;
  return (
    <figure className="rs-equity">
      <EquityGraph
        samples={frame.points.map((p) => ({
          x: nsToMs(p.time),
          equity: p.pnl,
          peak: p.peak,
          drawdown: -p.drawdown,
        }))}
        axis={{ kind: 'time', zone }}
        height={300}
        shade={
          laterFrom === null
            ? null
            : { from: nsToMs(laterFrom), before: SPLIT_WORD.development, after: SPLIT_WORD.later }
        }
        label={`Equity curve, ${formatMoney(end.pnl, { signed: true })} at the end`}
        ddLabel={`Drawdown, deepest ${formatMoney(frame.deepest)}`}
        empty="Too few bars to draw."
        tip={(i) => {
          const p = frame.points[i];
          return p ? <CurveTip p={p} /> : null;
        }}
      />
      <figcaption className="rs-curve-cap">
        <span className={cx(PRICE_TEXT, frame.high > 0 && 'up')}>{formatMoney(frame.high)} high</span>
        <span>
          {dateValue(frame.t0)} to {dateValue(frame.t1)}
          {laterFrom !== null ? ' · later sessions shaded' : ''}
        </span>
        <span className={PRICE_TEXT}>{formatMoney(frame.deepest)} deepest drawdown</span>
      </figcaption>
    </figure>
  );
}
