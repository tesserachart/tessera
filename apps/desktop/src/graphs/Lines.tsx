import { cx, formatMoney } from '@tessera/ui';
import { scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';
import { useState, type ReactNode } from 'react';
import { Crosshair, Empty, Tip, ValueAxis } from './parts.tsx';
import { pointerX, useWidth } from './pointer.ts';
import { AXIS_H, AXIS_W, paletteClass, valueScale } from './scales.ts';

export interface Series {
  key: string;
  label: string;
  values: readonly number[];
}

export function LinesGraph({
  series,
  labels,
  height = 240,
  label,
  empty,
}: {
  series: readonly Series[];
  labels: readonly string[];
  height?: number;
  label: string;
  empty: ReactNode;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [only, setOnly] = useState<string | null>(null);
  if (!series.length || !labels.length) return <Empty>{empty}</Empty>;
  const n = labels.length;
  const plotW = Math.max(0, width - AXIS_W);
  const plotH = height - AXIS_H;
  const x = scaleLinear<number>({ domain: [0, Math.max(1, n - 1)], range: [0, plotW] });
  const y = valueScale(
    series.flatMap((s) => s.values),
    [plotH - 6, 6],
  );
  return (
    <div className="gr-lines">
      <div className="gr-plot" ref={ref} style={{ height }}>
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
        >
          {width > 0 ? (
            <>
              <ValueAxis y={y} width={plotW} />
              {series.map((s, i) => (
                <LinePath
                  key={s.key}
                  data={[...s.values]}
                  x={(_, j) => x(j)}
                  y={(v) => y(v)}
                  className={cx('gr-series', paletteClass(i), only !== null && only !== s.key && 'is-dim')}
                />
              ))}
              {[...new Set([0, n - 1])].map((i) => (
                <text key={i} x={x(i)} y={height - 4} className={cx('gr-axis', i ? 'end' : undefined)}>
                  {labels[i]}
                </text>
              ))}
              {hover !== null ? <Crosshair x={x(hover)} bottom={plotH} /> : null}
            </>
          ) : null}
        </svg>
        {hover !== null ? (
          <Tip x={x(hover)} plotW={plotW}>
            <b>{labels[hover]}</b>
            {series.map((s, i) => (
              <span key={s.key}>
                <i className={cx('gr-swatch', paletteClass(i))} /> {s.label}{' '}
                <span className={(s.values[hover] ?? 0) >= 0 ? 'up' : 'down'}>
                  {formatMoney(s.values[hover] ?? 0, { signed: true })}
                </span>
              </span>
            ))}
          </Tip>
        ) : null}
      </div>
      <ul className="gr-legend is-row">
        {series.map((s, i) => (
          <li key={s.key}>
            <button
              type="button"
              className={cx(only === s.key && 'is-on')}
              aria-pressed={only === s.key}
              onClick={() => setOnly(only === s.key ? null : s.key)}
            >
              <i className={cx('gr-swatch', paletteClass(i))} />
              <span className="nm">{s.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
