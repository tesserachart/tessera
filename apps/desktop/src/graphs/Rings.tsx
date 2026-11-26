import { cx } from '@tessera/ui';
import { Group } from '@visx/group';
import { Arc, Pie } from '@visx/shape';
import { useState, type ReactNode } from 'react';
import { Empty } from './parts.tsx';
import { paletteClass } from './scales.ts';

export type RingTone = 'up' | 'down' | 'brass' | 'mist';

const FULL = 2 * Math.PI;
const HOVER_GROW = 1.5;

function ringShare(share: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(share) ? share : 0));
}

export function Gauge({
  share,
  size = 56,
  stroke = 4,
  pass = 0.5,
  label,
  tone,
}: {
  share: number | null;
  size?: number;
  stroke?: number;
  pass?: number;
  label?: ReactNode;
  tone?: RingTone;
}) {
  const r = (size - stroke) / 2;
  const v = share ?? 0;
  const t = tone ?? (share === null ? 'mist' : v >= pass ? 'up' : 'down');
  const ring = { innerRadius: r - stroke / 2, outerRadius: r + stroke / 2, startAngle: 0 };
  return (
    <span className="gr-gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <Group top={size / 2} left={size / 2}>
          <Arc {...ring} endAngle={FULL} className="gr-gauge-track" />
          <Arc {...ring} endAngle={FULL * ringShare(v)} className={cx('gr-gauge-fill', t)} />
        </Group>
      </svg>
      <span className={cx('gr-gauge-v', t, size >= 56 && 'is-big')}>
        {label ?? (share === null ? '—' : `${String(Math.round(v * 100))}%`)}
      </span>
    </span>
  );
}

function shareText(share: number): string {
  return `${(share * 100).toFixed(0)}%`;
}

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  tone: RingTone | 'palette';
  index?: number;
  text?: string;
}

function segmentClass(s: DonutSegment, i: number): string {
  return s.tone === 'palette' ? paletteClass(s.index ?? i) : s.tone;
}

export function Donut({
  segments,
  size = 148,
  thickness = 18,
  center,
  empty,
}: {
  segments: readonly DonutSegment[];
  size?: number;
  thickness?: number;
  center?: ReactNode;
  empty: ReactNode;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) return <Empty>{empty}</Empty>;
  const outer = size / 2 - HOVER_GROW;
  const h = segments.find((s) => s.key === hover);
  return (
    <div className="gr-donut">
      <span className="gr-donut-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label="Distribution" onPointerLeave={() => setHover(null)}>
          <Group top={size / 2} left={size / 2}>
            <Pie
              data={segments.map((s, i) => ({ s, i }))}
              pieValue={({ s }) => Math.max(0, s.value)}
              pieSort={null}
              pieSortValues={null}
              outerRadius={outer}
              innerRadius={outer - thickness}
            >
              {(pie) =>
                pie.arcs.map((a) => {
                  const on = hover === a.data.s.key;
                  return (
                    <Arc
                      key={a.data.s.key}
                      startAngle={a.startAngle}
                      endAngle={a.endAngle}
                      innerRadius={outer - thickness - (on ? HOVER_GROW : 0)}
                      outerRadius={outer + (on ? HOVER_GROW : 0)}
                      className={cx('gr-seg', segmentClass(a.data.s, a.data.i))}
                      onPointerEnter={() => setHover(a.data.s.key)}
                    />
                  );
                })
              }
            </Pie>
          </Group>
        </svg>
        <span className="gr-donut-c">
          {h ? (
            <>
              <b>{h.text ?? String(h.value)}</b>
              <span>{h.label}</span>
            </>
          ) : (
            center
          )}
        </span>
      </span>
      <ul className="gr-legend">
        {segments.map((s, i) => (
          <li
            key={s.key}
            className={cx(hover === s.key && 'is-hover')}
            onPointerEnter={() => setHover(s.key)}
            onPointerLeave={() => setHover(null)}
          >
            <i className={cx('gr-swatch', segmentClass(s, i))} />
            <span className="nm">{s.label}</span>
            <span className="v">{s.text ?? String(s.value)}</span>
            <span className="text-t3 text-right">{shareText(Math.max(0, s.value) / total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
