import { cx } from '@tessera/ui';
import { scaleLinear } from '@visx/scale';
import { Area, LinePath } from '@visx/shape';
import { useId, useState, type ReactNode } from 'react';
import { Crosshair, Empty, Tip, ValueAxis } from './parts.tsx';
import { pointerX, useWidth } from './pointer.ts';
import { AXIS_H, AXIS_W, valueScale } from './scales.ts';

export interface Marker {
  index: number;
  label: string;
  tone?: 'up' | 'down' | 'mist';
}

function edgeLabels(n: number): number[] {
  return n > 1 ? [...new Set([0, Math.floor((n - 1) / 2), n - 1])] : [];
}

export function AreaGraph({
  values,
  labels,
  height = 220,
  markers,
  label,
  tip,
  onPick,
  empty,
}: {
  values: readonly number[];
  labels: readonly string[];
  height?: number;
  markers?: readonly Marker[];
  label: string;
  tip: (i: number) => ReactNode;
  onPick?: (i: number) => void;
  empty: ReactNode;
}) {
  const id = useId();
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const plotW = Math.max(0, width - AXIS_W);
  const plotH = height - AXIS_H;
  const x = scaleLinear<number>({ domain: [0, Math.max(1, n - 1)], range: [0, plotW] });
  const y = valueScale(values, [plotH - 6, 6]);
  const zero = y(0);
  const above = `${id}-above`;
  const below = `${id}-below`;
  const ends = edgeLabels(n);
  const rows = [...values];
  return (
    <div className="gr-plot" ref={ref} style={{ height }}>
      {n === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          onPointerMove={(e) => {
            const px = pointerX(e);
            setHover(px > plotW ? null : Math.max(0, Math.min(n - 1, Math.round(x.invert(px)))));
          }}
          onPointerLeave={() => setHover(null)}
          onClick={() => {
            if (hover !== null) onPick?.(hover);
          }}
        >
          {width > 0 ? (
            <>
              <defs>
                <clipPath id={above}>
                  <rect x={0} y={0} width={plotW} height={Math.max(0, zero)} />
                </clipPath>
                <clipPath id={below}>
                  <rect x={0} y={zero} width={plotW} height={Math.max(0, height - zero)} />
                </clipPath>
              </defs>
              <ValueAxis y={y} width={plotW} />
              {(['up', 'down'] as const).map((tone) => (
                <g key={tone} clipPath={`url(#${tone === 'up' ? above : below})`}>
                  <Area data={rows} x={(_, i) => x(i)} y0={zero} y1={(v) => y(v)} className={cx('gr-area', tone)} />
                  <LinePath data={rows} x={(_, i) => x(i)} y={(v) => y(v)} className={cx('gr-line', tone)} />
                </g>
              ))}
              {ends.map((i) => (
                <text
                  key={i}
                  x={x(i)}
                  y={height - 4}
                  className={cx('gr-axis', i === 0 ? undefined : i === n - 1 ? 'end' : 'mid')}
                >
                  {labels[i]}
                </text>
              ))}
              {markers?.map((m) => (
                <g key={`${m.label}-${String(m.index)}`}>
                  <line
                    x1={x(m.index)}
                    x2={x(m.index)}
                    y1={0}
                    y2={plotH}
                    className={cx('gr-marker', m.tone ?? 'mist')}
                  />
                  <text x={x(m.index) + 4} y={12} className="gr-axis">
                    {m.label}
                  </text>
                </g>
              ))}
              {hover !== null ? (
                <>
                  <Crosshair x={x(hover)} bottom={plotH} />
                  <circle
                    cx={x(hover)}
                    cy={y(values[hover] ?? 0)}
                    r={3.5}
                    className={cx('gr-dot', (values[hover] ?? 0) >= 0 ? 'up' : 'down')}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </svg>
      )}
      {hover !== null && n > 0 ? (
        <Tip x={x(hover)} plotW={plotW}>
          {tip(hover)}
        </Tip>
      ) : null}
    </div>
  );
}
