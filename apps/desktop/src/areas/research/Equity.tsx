import type { BacktestEquityPoint } from '@tessera/protocol';
import { PRICE_TEXT, cx, formatMoney } from '@tessera/ui';
import { useMemo, useState } from 'react';
import { dateValue } from './model.ts';
import { curveFrame, linePath, nearestPoint, xOfTime, type CurvePoint } from './tester.ts';

const W = 1000;
const EQUITY_H = 260;
const DRAWDOWN_H = 72;

export function Equity({ points, laterFrom }: { points: readonly BacktestEquityPoint[]; laterFrom: number | null }) {
  const frame = useMemo(() => curveFrame(points, W), [points]);
  const [hover, setHover] = useState<CurvePoint | null>(null);
  if (!frame) return <p className="rs-wait">Too few bars to draw.</p>;
  const splitX = laterFrom === null ? null : Math.min(W, Math.max(0, xOfTime(frame, laterFrom, W)));
  const zeroY = EQUITY_H - ((0 - frame.low) / (frame.high - frame.low || 1)) * EQUITY_H;
  const line = linePath(frame, W, EQUITY_H, (p) => p.pnl, frame.low, frame.high);
  const under = linePath(frame, W, DRAWDOWN_H, (p) => p.drawdown, frame.deepest, 0);
  const pct = (x: number) => `${((x / W) * 100).toFixed(2)}%`;
  const hoverX = hover ? xOfTime(frame, hover.time, W) : null;
  return (
    <figure
      className="rs-equity"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setHover(nearestPoint(frame, (e.clientX - r.left) / (r.width || 1)));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="rs-equity-plot">
        <svg
          viewBox={`0 0 ${String(W)} ${String(EQUITY_H)}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Equity curve, ${formatMoney(frame.points[frame.points.length - 1]!.pnl, { signed: true })} at the end`}
        >
          {splitX !== null ? (
            <rect className="rs-curve-later" x={splitX} y={0} width={W - splitX} height={EQUITY_H} />
          ) : null}
          <line className="rs-curve-zero" x1={0} x2={W} y1={zeroY} y2={zeroY} vectorEffect="non-scaling-stroke" />
          <path className="rs-curve-line" d={line} vectorEffect="non-scaling-stroke" />
          {hoverX !== null ? (
            <line
              className="rs-curve-cross"
              x1={hoverX}
              x2={hoverX}
              y1={0}
              y2={EQUITY_H}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        <span className="rs-equity-tag">Development</span>
        {splitX !== null ? (
          <span className="rs-equity-tag is-later" style={{ left: pct(splitX) }}>
            Later
          </span>
        ) : null}
        {hover ? (
          <span className="rs-equity-read" data-selectable>
            {dateValue(hover.time)} · <span className={PRICE_TEXT}>{formatMoney(hover.pnl, { signed: true })}</span>
            {hover.drawdown < 0 ? (
              <>
                {' '}
                · <span className={PRICE_TEXT}>{formatMoney(hover.drawdown)}</span> from the high
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="rs-equity-dd">
        <svg
          viewBox={`0 0 ${String(W)} ${String(DRAWDOWN_H)}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Drawdown, deepest ${formatMoney(frame.deepest)}`}
        >
          {splitX !== null ? (
            <rect className="rs-curve-later" x={splitX} y={0} width={W - splitX} height={DRAWDOWN_H} />
          ) : null}
          <path className="rs-curve-under" d={`M0,0${under.replace(/^M/, 'L')}L${String(W)},0Z`} />
          {hoverX !== null ? (
            <line
              className="rs-curve-cross"
              x1={hoverX}
              x2={hoverX}
              y1={0}
              y2={DRAWDOWN_H}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        <span className="rs-equity-tag">Drawdown</span>
      </div>
      <figcaption className="rs-curve-cap">
        <span className={cx(PRICE_TEXT, frame.high > 0 && 'up')}>{formatMoney(frame.high)} high</span>
        <span>
          {dateValue(frame.t0)} to {dateValue(frame.t1)}
          {splitX !== null ? ' · later sessions shaded' : ''}
        </span>
        <span className={PRICE_TEXT}>{formatMoney(frame.deepest)} deepest drawdown</span>
      </figcaption>
    </figure>
  );
}
