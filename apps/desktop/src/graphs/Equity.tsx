import { cx } from '@tessera/ui';
import { scaleLinear } from '@visx/scale';
import { Area, LinePath } from '@visx/shape';
import { useId, useState, type ReactNode } from 'react';
import { Crosshair, Empty, Tip, ValueAxis, XAxis } from './parts.tsx';
import { pointerX, useWidth } from './pointer.ts';
import { AXIS_H, AXIS_W, X_TICKS, nearest, valueScale, wallLabel, wallScale, wallTime, money } from './scales.ts';

export interface EquitySample {
  x: number;
  equity: number;
  peak: number;
  drawdown: number;
}

export type EquityAxis = { kind: 'trades'; label: (i: number) => string } | { kind: 'time'; zone: string };

export interface Shade {
  from: number;
  before: string;
  after: string;
}

const DD_LABEL = 'Drawdown';
const TAGS_H = 24;

function xFrame(samples: readonly EquitySample[], axis: EquityAxis, plotW: number) {
  if (axis.kind === 'trades') {
    const n = samples.length - 1;
    const scale = scaleLinear<number>({ domain: [0, Math.max(1, n)], range: [0, plotW] });
    const values = scale.ticks(X_TICKS).filter((t) => Number.isInteger(t) && t >= 1 && t <= n);
    return {
      scale,
      at: (x: number) => scale(x),
      values,
      format: (v: number | Date) => axis.label(Number(v)),
    };
  }
  const wall = (ms: number) => wallTime(ms, axis.zone);
  const first = wall(samples[0]?.x ?? 0);
  const last = wall(samples[samples.length - 1]?.x ?? 0);
  const scale = wallScale([first, last === first ? first + 1 : last], [0, plotW]);
  const label = wallLabel(last - first);
  return {
    scale,
    at: (x: number) => scale(new Date(wall(x))),
    values: undefined,
    format: (v: number | Date) => label(v instanceof Date ? v : new Date(v)),
  };
}

export function EquityGraph({
  samples,
  axis,
  height = 240,
  ddShare = 0.24,
  shade,
  label,
  ddLabel = DD_LABEL,
  tip,
  onPick,
  empty,
}: {
  samples: readonly EquitySample[];
  axis: EquityAxis;
  height?: number;
  ddShare?: number;
  shade?: Shade | null;
  label: string;
  ddLabel?: string;
  tip: (i: number) => ReactNode;
  onPick?: (i: number) => void;
  empty: ReactNode;
}) {
  const id = useId();
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  if (samples.length < 2) return <Empty>{empty}</Empty>;
  const plotW = Math.max(0, width - AXIS_W);
  const eqH = Math.round((height - AXIS_H) * (1 - ddShare));
  const ddH = height - AXIS_H - eqH;
  const x = xFrame(samples, axis, plotW);
  const rows = [...samples];
  const xs = rows.map((s) => x.at(s.x));
  const y = valueScale(
    samples.flatMap((s) => [s.equity, s.peak]),
    [eqH - 6, shade ? TAGS_H : 6],
  );
  const deepest = Math.max(0, ...samples.map((s) => s.drawdown));
  const dd = scaleLinear<number>({ domain: [0, deepest || 1], range: [1, ddH - 2] });
  const up = (samples[samples.length - 1]?.equity ?? 0) >= 0;
  const shadeX = shade ? Math.min(plotW, Math.max(0, x.at(shade.from))) : null;
  const tipped = hover === null ? null : tip(hover);
  const hx = hover === null || tipped === null ? null : (xs[hover] ?? null);
  const point = hover === null ? null : samples[hover];
  const fill = `${id}-fill`;
  return (
    <div
      className="gr-equity"
      ref={ref}
      style={{ height }}
      onPointerMove={(e) => {
        const px = pointerX(e);
        setHover(px <= plotW ? nearest(xs, px) : null);
      }}
      onPointerLeave={() => setHover(null)}
      onClick={() => {
        if (hover !== null && tipped !== null) onPick?.(hover);
      }}
      data-pick={onPick ? '' : undefined}
    >
      <svg width={width} height={eqH} role="img" aria-label={label}>
        {width > 0 ? (
          <>
            <defs>
              <linearGradient id={fill} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" className={cx('gr-stop', up ? 'up' : 'down')} stopOpacity="0.16" />
                <stop offset="100%" className={cx('gr-stop', up ? 'up' : 'down')} stopOpacity="0" />
              </linearGradient>
            </defs>
            {shadeX !== null ? (
              <rect className="gr-shade" x={shadeX} y={0} width={plotW - shadeX} height={eqH} />
            ) : null}
            <ValueAxis y={y} width={plotW} />
            <Area data={rows} x={(_, i) => xs[i] ?? 0} y0={y(0)} y1={(s) => y(s.equity)} fill={`url(#${fill})`} />
            <LinePath data={rows} x={(_, i) => xs[i] ?? 0} y={(s) => y(s.peak)} className="gr-peak" />
            <LinePath
              data={rows}
              x={(_, i) => xs[i] ?? 0}
              y={(s) => y(s.equity)}
              className={cx('gr-line', up ? 'up' : 'down')}
            />
            {shade && shadeX !== null ? (
              <>
                <text x={8} y={14} className="gr-tag">
                  {shade.before}
                </text>
                <text x={shadeX + 8} y={14} className="gr-tag">
                  {shade.after}
                </text>
              </>
            ) : null}
            {hx !== null && point ? (
              <>
                <Crosshair x={hx} bottom={eqH} />
                <circle cx={hx} cy={y(point.equity)} r={3.5} className={cx('gr-dot', up ? 'up' : 'down')} />
              </>
            ) : null}
          </>
        ) : null}
      </svg>
      <svg width={width} height={ddH + AXIS_H} role="img" aria-label={ddLabel}>
        {width > 0 ? (
          <>
            {shadeX !== null ? (
              <rect className="gr-shade" x={shadeX} y={0} width={plotW - shadeX} height={ddH} />
            ) : null}
            <line x1={0} x2={plotW} y1={0.5} y2={0.5} className="gr-grid" />
            <Area data={rows} x={(_, i) => xs[i] ?? 0} y0={1} y1={(s) => dd(s.drawdown)} className="gr-under" />
            <text x={plotW + 8} y={13} className="gr-axis">
              {DD_LABEL}
            </text>
            {deepest > 0 ? (
              <text x={plotW + 8} y={ddH - 2} className="gr-axis">
                {money(-deepest)}
              </text>
            ) : null}
            {hx !== null ? <Crosshair x={hx} bottom={ddH} /> : null}
            <XAxis scale={x.scale} top={ddH} values={x.values} format={x.format} />
          </>
        ) : null}
      </svg>
      {hx !== null && tipped !== null ? (
        <Tip x={hx} plotW={plotW}>
          {tipped}
        </Tip>
      ) : null}
    </div>
  );
}
