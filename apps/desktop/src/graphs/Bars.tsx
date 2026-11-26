import { cx } from '@tessera/ui';
import { scaleBand } from '@visx/scale';
import { Bar } from '@visx/shape';
import { useState, type ReactNode } from 'react';
import { Empty, Tip, ValueAxis } from './parts.tsx';
import { useWidth } from './pointer.ts';
import { AXIS_W, valueScale } from './scales.ts';

export type Tone = 'up' | 'down' | 'mist';

export interface BarDatum {
  key: string;
  value: number;
  label?: string;
  note?: string;
  tone?: Tone;
  faint?: boolean;
}

const LABELS_H = 34;
const GAP_LABELLED = 0.36;
const GAP_BARE = 0.3;

export function BarGraph({
  bars,
  height = 200,
  signed = true,
  axis,
  label,
  tip,
  onPick,
  empty,
}: {
  bars: readonly BarDatum[];
  height?: number;
  signed?: boolean;
  axis?: (v: number) => string;
  label: string;
  tip: (i: number) => ReactNode;
  onPick?: (i: number) => void;
  empty: ReactNode;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const labelled = bars.some((b) => b.label !== undefined || b.note !== undefined);
  const plotW = Math.max(0, width - (axis ? AXIS_W : 0));
  const plotH = height - (labelled ? LABELS_H : 0);
  const gap = labelled ? GAP_LABELLED : GAP_BARE;
  const x = scaleBand<string>({
    domain: bars.map((b) => b.key),
    range: [0, plotW],
    paddingInner: gap,
    paddingOuter: gap / 2,
  });
  const step = x.step();
  const values = bars.map((b) => b.value);
  const y = valueScale(signed ? values : [1, ...values], [plotH - (labelled ? 0 : 6), 6]);
  const zero = y(0);
  const hovered = hover === null ? null : bars[hover];
  return (
    <div className="gr-bars" ref={ref} style={{ height }}>
      {!bars.length ? (
        <Empty>{empty}</Empty>
      ) : (
        <svg width={width} height={height} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
          {width > 0 ? (
            <>
              {axis ? <ValueAxis y={y} width={plotW} format={axis} /> : null}
              {!axis ? <line x1={0} x2={plotW} y1={zero} y2={zero} className="gr-zero" /> : null}
              {bars.map((b, i) => {
                const left = x(b.key) ?? 0;
                const top = Math.min(y(b.value), zero);
                const h = Math.max(b.value === 0 ? 0 : 1.5, Math.abs(y(b.value) - zero));
                return (
                  <g
                    key={b.key}
                    className={cx('gr-bar', b.faint && 'is-faint', hover === i && 'is-hover', onPick && 'is-pick')}
                    onPointerEnter={() => setHover(i)}
                    onClick={() => onPick?.(i)}
                  >
                    <rect x={left - (step * gap) / 2} y={0} width={step} height={height} className="gr-hit" />
                    <Bar
                      x={left}
                      y={top}
                      width={Math.max(1, x.bandwidth())}
                      height={h}
                      className={b.tone ?? (signed ? (b.value >= 0 ? 'up' : 'down') : 'mist')}
                    />
                    {labelled ? (
                      <>
                        <text x={left + x.bandwidth() / 2} y={plotH + 15} className="gr-axis mid">
                          {b.label}
                        </text>
                        <text x={left + x.bandwidth() / 2} y={plotH + 28} className="gr-note mid">
                          {b.note}
                        </text>
                      </>
                    ) : null}
                  </g>
                );
              })}
            </>
          ) : null}
        </svg>
      )}
      {hovered && hover !== null ? (
        <Tip x={(x(hovered.key) ?? 0) - 12} plotW={plotW}>
          {tip(hover)}
        </Tip>
      ) : null}
    </div>
  );
}
