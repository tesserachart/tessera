import type { Bucket, EquityPoint } from '@tessera/protocol';
import { Tooltip, cx, formatMoney } from '@tessera/ui';
import { useId, useState, type ReactNode } from 'react';
import {
  donutArcs,
  equityGeometry,
  gaugeArc,
  linear,
  multiGeometry,
  nearestIndex,
  seriesGeometry,
} from '../model/chart.ts';
import { intensity } from '../model/calendar.ts';
import { SMALL_N, metricText, metricValue, type BucketMetric } from '../model/metrics.ts';
import { useWidth } from './hooks.ts';
import { clock, dayLabel, nsToMs, pct, rLabel, todayIn } from '../model/format.ts';

const AXIS = 64;

export function EquityChart({
  points,
  height = 240,
  onPick,
  empty = 'No closed trades in this view.',
}: {
  points: readonly EquityPoint[];
  height?: number;
  onPick?: (tradeId: string) => void;
  empty?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - AXIS);
  const g = equityGeometry(points, plotW, height);
  const last = points[points.length - 1];
  const up = (last?.equity ?? 0) >= 0;
  const p = hover !== null ? points[hover - 1] : null;
  return (
    <div className="jr-equity" ref={ref} style={{ height }}>
      {points.length === 0 ? (
        <div className="jr-empty">{empty}</div>
      ) : width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Equity curve over ${String(points.length)} trades, ending at ${formatMoney(last?.equity, { signed: true })}`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - r.left;
            setHover(x <= plotW ? nearestIndex(x, g.x, points.length) : null);
          }}
          onPointerLeave={() => setHover(null)}
          onClick={() => {
            if (p && onPick) onPick(p.tradeId);
          }}
        >
          <defs>
            <linearGradient id="jr-eq-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={up ? 'var(--color-up)' : 'var(--color-down)'} stopOpacity="0.16" />
              <stop offset="100%" stopColor={up ? 'var(--color-up)' : 'var(--color-down)'} stopOpacity="0" />
            </linearGradient>
          </defs>
          {g.ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={g.y(t)} y2={g.y(t)} className={t === 0 ? 'jr-zero' : 'jr-grid'} />
              <text x={plotW + 8} y={g.y(t) + 4} className="jr-axis">
                {formatMoney(t, { signed: true, compact: true })}
              </text>
            </g>
          ))}
          <path d={g.area} fill="url(#jr-eq-fill)" />
          <path d={g.peak} className="jr-peak" />
          <path d={g.line} className={cx('jr-line', up ? 'up' : 'down')} />
          <line x1={0} x2={plotW} y1={g.split + 8} y2={g.split + 8} className="jr-grid" />
          <path d={g.under} className="jr-under" />
          <text x={plotW + 8} y={g.split + 20} className="jr-axis">
            Drawdown
          </text>
          {p ? (
            <g>
              <line x1={g.x(p.i)} x2={g.x(p.i)} y1={0} y2={height} className="jr-cross" />
              <circle cx={g.x(p.i)} cy={g.y(p.equity)} r={3.5} className={cx('jr-dot', p.pnl >= 0 ? 'up' : 'down')} />
            </g>
          ) : null}
        </svg>
      ) : null}
      {p ? (
        <div className="jr-tip" style={{ left: Math.min(Math.max(0, g.x(p.i) + 12), Math.max(0, plotW - 200)) }}>
          <b>Trade {p.i}</b>
          <span className="text-t3">
            {dayLabel(todayIn(undefined, nsToMs(p.t)))} · {clock(p.t)}
          </span>
          <span>
            Trade <span className={p.pnl >= 0 ? 'up' : 'down'}>{formatMoney(p.pnl, { signed: true })}</span>
          </span>
          <span>Equity {formatMoney(p.equity, { signed: true })}</span>
          {p.drawdown > 0 ? (
            <span className="text-t3">{formatMoney(-p.drawdown, { signed: true })} from the peak</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function BucketBars({
  buckets,
  metric = 'net',
  height = 160,
  onPick,
  tones,
}: {
  buckets: readonly Bucket[];
  metric?: BucketMetric;
  height?: number;
  onPick?: (b: Bucket) => void;
  tones?: readonly ('up' | 'down' | 'mist')[];
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const values = buckets.map((b) => metricValue(b, metric) ?? 0);
  const signed = metric !== 'n' && metric !== 'winRate';
  const lo = signed ? Math.min(0, ...values) : 0;
  const hi = Math.max(signed ? 0 : 1, ...values);
  const plotH = height - 34;
  const y = linear([lo, hi === lo ? lo + 1 : hi], [plotH, 6]);
  const bw = buckets.length ? width / buckets.length : 0;
  const hb = hover !== null ? buckets[hover] : null;
  return (
    <div className="jr-bars" ref={ref} style={{ height }}>
      {width > 0 && buckets.length ? (
        <svg width={width} height={height} role="img" aria-label="Bars by bucket" onPointerLeave={() => setHover(null)}>
          <line x1={0} x2={width} y1={y(0)} y2={y(0)} className="jr-zero" />
          {buckets.map((b, i) => {
            const v = values[i] ?? 0;
            const top = Math.min(y(v), y(0));
            const h = Math.max(v === 0 ? 0 : 1.5, Math.abs(y(v) - y(0)));
            return (
              <g
                key={b.key}
                className={cx('jr-bar', b.n < SMALL_N && 'is-small', hover === i && 'is-hover')}
                onPointerEnter={() => setHover(i)}
                onClick={() => onPick?.(b)}
              >
                <rect x={i * bw} y={0} width={bw} height={height} className="jr-hit" />
                <rect
                  x={i * bw + Math.max(1, bw * 0.18)}
                  y={top}
                  width={Math.max(1, bw * 0.64)}
                  height={h}
                  className={tones?.[i] ?? (signed ? (v >= 0 ? 'up' : 'down') : 'mist')}
                />
                <text x={i * bw + bw / 2} y={plotH + 15} className="jr-axis mid">
                  {b.label}
                </text>
                <text x={i * bw + bw / 2} y={plotH + 28} className="jr-n mid">
                  {b.n ? `n ${String(b.n)}` : ''}
                </text>
              </g>
            );
          })}
        </svg>
      ) : (
        <div className="jr-empty">Nothing to measure yet.</div>
      )}
      {hb ? <BucketTip b={hb} left={Math.min((hover ?? 0) * bw, Math.max(0, width - 200))} /> : null}
    </div>
  );
}

function BucketTip({ b, left }: { b: Bucket; left: number }) {
  return (
    <div className="jr-tip" style={{ left }}>
      <b>{b.label}</b>
      <span>
        <span className={b.net >= 0 ? 'up' : 'down'}>{formatMoney(b.net, { signed: true })}</span> · {String(b.n)}{' '}
        trades
      </span>
      <span className="text-t3">
        Win rate {pct(b.winRate)} · PF{' '}
        {b.profitFactor === null ? (b.grossProfit > 0 ? '∞' : '—') : b.profitFactor.toFixed(2)}
      </span>
      {b.avgR !== null ? <span className="text-t3">Average {rLabel(b.avgR)}</span> : null}
      {b.n < SMALL_N ? <span className="text-t3">Few trades: read as noise</span> : null}
    </div>
  );
}

export function BarRows({
  buckets,
  metric = 'net',
  onPick,
}: {
  buckets: readonly Bucket[];
  metric?: BucketMetric;
  onPick?: (b: Bucket) => void;
}) {
  const values = buckets.map((b) => metricValue(b, metric));
  const signed = metric !== 'n' && metric !== 'winRate';
  const max = Math.max(1e-9, ...values.map((v) => Math.abs(v ?? 0)));
  if (!buckets.length) return <div className="jr-empty">Nothing to measure yet.</div>;
  return (
    <div className="jr-rows" role="list">
      {buckets.map((b, i) => {
        const v = values[i] ?? null;
        const w = v === null ? 0 : (Math.abs(v) / max) * 100;
        return (
          <button
            type="button"
            role="listitem"
            key={b.key}
            className={cx('jr-row', b.n < SMALL_N && 'is-small')}
            onClick={() => onPick?.(b)}
            disabled={!onPick}
            title={`${b.label}: ${String(b.n)} trades, ${formatMoney(b.net, { signed: true })}, win rate ${pct(b.winRate)}`}
          >
            <span className="nm">{b.label}</span>
            <span className="track" data-signed={signed ? '1' : undefined}>
              <span
                className={cx('fill', signed ? ((v ?? 0) >= 0 ? 'up' : 'down') : 'mist')}
                style={
                  signed
                    ? { width: `${String(w / 2)}%`, [(v ?? 0) >= 0 ? 'left' : 'right']: '50%' }
                    : { width: `${String(w)}%` }
                }
              />
            </span>
            <span className={cx('fig', signed && ((v ?? 0) > 0 ? 'up' : (v ?? 0) < 0 ? 'down' : undefined))}>
              {metricText(v, metric)}
            </span>
            <span className="n">n {b.n}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Spark({
  values,
  width = 96,
  height = 24,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const cum = [0];
  for (const v of values) cum.push((cum[cum.length - 1] ?? 0) + v);
  const acc = cum[cum.length - 1] ?? 0;
  const lo = Math.min(...cum);
  const hi = Math.max(...cum);
  const x = linear([0, cum.length - 1], [1, width - 1]);
  const y = linear([lo, hi === lo ? lo + 1 : hi], [height - 2, 2]);
  const d = cum.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} aria-hidden="true" className="jr-spark">
      <line x1={0} x2={width} y1={y(0)} y2={y(0)} className="jr-zero" />
      <path d={d} className={cx('jr-line', acc >= 0 ? 'up' : 'down')} />
    </svg>
  );
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
  tone?: 'up' | 'down' | 'brass' | 'mist';
}) {
  const r = (size - stroke) / 2;
  const v = share ?? 0;
  const arc = gaugeArc(v, r);
  const t = tone ?? (share === null ? 'mist' : v >= pass ? 'up' : 'down');
  return (
    <span className="jk-gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <g transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}>
          <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="jk-gauge-track" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            strokeDasharray={arc.dash}
            className={cx('jk-gauge-fill', t)}
          />
        </g>
      </svg>
      <span className={cx('jk-gauge-v', t, size >= 56 && 'is-big')}>
        {label ?? (share === null ? '—' : `${String(Math.round(v * 100))}%`)}
      </span>
    </span>
  );
}

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  tone: 'up' | 'down' | 'brass' | 'mist' | 'palette';
  index?: number;
  text?: string;
}

export function Donut({
  segments,
  size = 148,
  thickness = 18,
  center,
}: {
  segments: readonly DonutSegment[];
  size?: number;
  thickness?: number;
  center?: ReactNode;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const r = (size - thickness) / 2;
  const arcs = donutArcs(
    segments.map((s) => s.value),
    r,
  );
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) return <div className="jr-empty">Nothing to measure yet.</div>;
  const h = segments.find((s) => s.key === hover);
  return (
    <div className="jk-donut">
      <span className="jk-donut-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label="Distribution" onPointerLeave={() => setHover(null)}>
          <g transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}>
            {segments.map((s, i) => (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                strokeWidth={hover === s.key ? thickness + 3 : thickness}
                strokeDasharray={arcs[i]?.dash}
                strokeDashoffset={arcs[i]?.offset}
                className={cx('jk-donut-seg', s.tone === 'palette' ? `p${String((s.index ?? i) % 8)}` : s.tone)}
                onPointerEnter={() => setHover(s.key)}
              />
            ))}
          </g>
        </svg>
        <span className="jk-donut-c">
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
      <ul className="jk-legend">
        {segments.map((s, i) => (
          <li
            key={s.key}
            className={cx(hover === s.key && 'is-hover')}
            onPointerEnter={() => setHover(s.key)}
            onPointerLeave={() => setHover(null)}
          >
            <i className={cx('jk-swatch', s.tone === 'palette' ? `p${String((s.index ?? i) % 8)}` : s.tone)} />
            <span className="nm">{s.label}</span>
            <span className="v">{s.text ?? String(s.value)}</span>
            <span className="text-t3 text-right">{pct((Math.max(0, s.value) / total) * 100, 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface SeriesPoint {
  label: string;
  value: number;
  detail?: readonly string[];
  tradeId?: string;
}

export function AreaChart({
  points,
  height = 220,
  onPick,
  markers,
  empty = 'Nothing to measure yet.',
}: {
  points: readonly SeriesPoint[];
  height?: number;
  onPick?: (p: SeriesPoint) => void;
  markers?: readonly { index: number; label: string; tone?: 'up' | 'down' | 'mist' }[];
  empty?: ReactNode;
}) {
  const id = useId();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - AXIS);
  const g = seriesGeometry(
    points.map((p) => p.value),
    plotW,
    height - 18,
  );
  const zero = g.y(0);
  const p = hover !== null ? points[hover] : null;
  return (
    <div className="jr-equity" ref={ref} style={{ height }}>
      {points.length === 0 ? (
        <div className="jr-empty">{empty}</div>
      ) : width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Area chart"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - r.left;
            if (x > plotW) return setHover(null);
            const step = points.length > 1 ? plotW / (points.length - 1) : plotW;
            setHover(Math.max(0, Math.min(points.length - 1, Math.round(x / (step || 1)))));
          }}
          onPointerLeave={() => setHover(null)}
          onClick={() => {
            if (p && onPick) onPick(p);
          }}
        >
          <defs>
            <clipPath id={`${id}-a`}>
              <rect x={0} y={0} width={plotW} height={Math.max(0, zero)} />
            </clipPath>
            <clipPath id={`${id}-b`}>
              <rect x={0} y={zero} width={plotW} height={Math.max(0, height - zero)} />
            </clipPath>
          </defs>
          {g.ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={g.y(t)} y2={g.y(t)} className={t === 0 ? 'jr-zero' : 'jr-grid'} />
              <text x={plotW + 8} y={g.y(t) + 4} className="jr-axis">
                {formatMoney(t, { signed: true, compact: true })}
              </text>
            </g>
          ))}
          <path d={g.area} className="jk-area up" clipPath={`url(#${id}-a)`} />
          <path d={g.area} className="jk-area down" clipPath={`url(#${id}-b)`} />
          <path d={g.line} className="jr-line up" clipPath={`url(#${id}-a)`} />
          <path d={g.line} className="jr-line down" clipPath={`url(#${id}-b)`} />
          {points.length > 1
            ? [0, Math.floor((points.length - 1) / 2), points.length - 1].map((i) => (
                <text
                  key={i}
                  x={g.x(i)}
                  y={height - 4}
                  className={cx('jr-axis', i === 0 ? '' : i === points.length - 1 ? 'end' : 'mid')}
                >
                  {points[i]?.label}
                </text>
              ))
            : null}
          {markers?.map((m) => (
            <g key={`${m.label}-${String(m.index)}`}>
              <line
                x1={g.x(m.index)}
                x2={g.x(m.index)}
                y1={0}
                y2={height - 18}
                className={cx('jk-marker', m.tone ?? 'mist')}
              />
              <text x={g.x(m.index) + 4} y={12} className="jr-axis">
                {m.label}
              </text>
            </g>
          ))}
          {p && hover !== null ? (
            <g>
              <line x1={g.x(hover)} x2={g.x(hover)} y1={0} y2={height - 18} className="jr-cross" />
              <circle
                cx={g.x(hover)}
                cy={g.y(p.value)}
                r={3.5}
                className={cx('jr-dot', p.value >= 0 ? 'up' : 'down')}
              />
            </g>
          ) : null}
        </svg>
      ) : null}
      {p && hover !== null ? (
        <div className="jr-tip" style={{ left: Math.min(Math.max(0, g.x(hover) + 12), Math.max(0, plotW - 200)) }}>
          <b>{p.label}</b>
          <span className={p.value >= 0 ? 'up' : 'down'}>{formatMoney(p.value, { signed: true })}</span>
          {p.detail?.map((d) => (
            <span key={d} className="text-t3">
              {d}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SignedBars({
  points,
  height = 200,
  onPick,
  format = (v: number) => formatMoney(v, { signed: true }),
}: {
  points: readonly SeriesPoint[];
  height?: number;
  onPick?: (p: SeriesPoint) => void;
  format?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - AXIS);
  const values = points.map((p) => p.value);
  const g = seriesGeometry(values, plotW, height);
  const bw = points.length ? plotW / points.length : 0;
  const p = hover !== null ? points[hover] : null;
  if (!points.length) return <div className="jr-empty">Nothing to measure yet.</div>;
  return (
    <div className="jr-bars" ref={ref} style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label="Bars" onPointerLeave={() => setHover(null)}>
          {g.ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={g.y(t)} y2={g.y(t)} className={t === 0 ? 'jr-zero' : 'jr-grid'} />
              <text x={plotW + 8} y={g.y(t) + 4} className="jr-axis">
                {formatMoney(t, { signed: true, compact: true })}
              </text>
            </g>
          ))}
          {points.map((pt, i) => {
            const top = Math.min(g.y(pt.value), g.y(0));
            const h = Math.max(pt.value === 0 ? 0 : 1.5, Math.abs(g.y(pt.value) - g.y(0)));
            return (
              <g
                key={`${pt.label}-${String(i)}`}
                className={cx('jr-bar', hover === i && 'is-hover')}
                onPointerEnter={() => setHover(i)}
                onClick={() => onPick?.(pt)}
              >
                <rect x={i * bw} y={0} width={bw} height={height} className="jr-hit" />
                <rect
                  x={i * bw + Math.max(0.5, bw * 0.15)}
                  y={top}
                  width={Math.max(1, bw * 0.7)}
                  height={h}
                  className={pt.value >= 0 ? 'up' : 'down'}
                />
              </g>
            );
          })}
        </svg>
      ) : null}
      {p && hover !== null ? (
        <div className="jr-tip" style={{ left: Math.min(hover * bw + 12, Math.max(0, plotW - 200)) }}>
          <b>{p.label}</b>
          <span className={p.value >= 0 ? 'up' : 'down'}>{format(p.value)}</span>
          {p.detail?.map((d) => (
            <span key={d} className="text-t3">
              {d}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MultiLine({
  series,
  labels,
  height = 240,
}: {
  series: readonly { key: string; label: string; values: readonly number[] }[];
  labels: readonly string[];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [only, setOnly] = useState<string | null>(null);
  const plotW = Math.max(0, width - AXIS);
  const g = multiGeometry(
    series.map((s) => s.values),
    plotW,
    height - 18,
  );
  if (!series.length || !labels.length) return <div className="jr-empty">Nothing to measure yet.</div>;
  return (
    <div className="jk-multi">
      <div className="jr-equity" ref={ref} style={{ height }}>
        {width > 0 ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Lines by series"
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - r.left;
              const step = labels.length > 1 ? plotW / (labels.length - 1) : plotW;
              setHover(x > plotW ? null : Math.max(0, Math.min(labels.length - 1, Math.round(x / (step || 1)))));
            }}
            onPointerLeave={() => setHover(null)}
          >
            {g.ticks.map((t) => (
              <g key={t}>
                <line x1={0} x2={plotW} y1={g.y(t)} y2={g.y(t)} className={t === 0 ? 'jr-zero' : 'jr-grid'} />
                <text x={plotW + 8} y={g.y(t) + 4} className="jr-axis">
                  {formatMoney(t, { signed: true, compact: true })}
                </text>
              </g>
            ))}
            {series.map((s, i) => (
              <path
                key={s.key}
                d={g.lines[i]}
                className={cx('jk-mline', `p${String(i % 8)}`, only && only !== s.key && 'is-dim')}
              />
            ))}
            {[0, labels.length - 1].map((i) => (
              <text key={i} x={g.x(i)} y={height - 4} className={cx('jr-axis', i ? 'end' : '')}>
                {labels[i]}
              </text>
            ))}
            {hover !== null ? (
              <line x1={g.x(hover)} x2={g.x(hover)} y1={0} y2={height - 18} className="jr-cross" />
            ) : null}
          </svg>
        ) : null}
        {hover !== null ? (
          <div className="jr-tip" style={{ left: Math.min(g.x(hover) + 12, Math.max(0, plotW - 200)) }}>
            <b>{labels[hover]}</b>
            {series.map((s, i) => (
              <span key={s.key}>
                <i className={cx('jk-swatch', `p${String(i % 8)}`)} /> {s.label}{' '}
                <span className={(s.values[hover] ?? 0) >= 0 ? 'up' : 'down'}>
                  {formatMoney(s.values[hover] ?? 0, { signed: true })}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <ul className="jk-legend is-row">
        {series.map((s, i) => (
          <li key={s.key}>
            <button
              type="button"
              className={cx(only === s.key && 'is-on')}
              onClick={() => setOnly(only === s.key ? null : s.key)}
            >
              <i className={cx('jk-swatch', `p${String(i % 8)}`)} />
              <span className="nm">{s.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HourGrid({ buckets, tz }: { buckets: readonly Bucket[]; tz: string }) {
  const by = new Map(buckets.map((b) => [Number(b.key), b]));
  const max = Math.max(0, ...buckets.map((b) => Math.abs(b.net)));
  const decided = buckets.filter((b) => b.n > 0);
  const best = decided.reduce<Bucket | null>((a, b) => (!a || b.net > a.net ? b : a), null);
  const worst = decided.reduce<Bucket | null>((a, b) => (!a || b.net < a.net ? b : a), null);
  return (
    <div className="jk-hours">
      <div className="jk-hours-grid" role="list">
        {Array.from({ length: 24 }, (_, h) => {
          const b = by.get(h);
          const lvl = b ? intensity(b.net, max) : 0;
          return (
            <Tooltip
              key={h}
              content={
                b ? (
                  <span>
                    {String(h).padStart(2, '0')}:00 · {formatMoney(b.net, { signed: true })} · {String(b.n)} trades ·
                    win {pct(b.winRate, 0)}
                  </span>
                ) : (
                  `${String(h).padStart(2, '0')}:00 · no trades`
                )
              }
            >
              <span
                role="listitem"
                className={cx('jk-hour', b?.n ? (b.net >= 0 ? 'up' : 'down') : 'none', `l${String(lvl)}`)}
                tabIndex={0}
              >
                <span className="h">{String(h).padStart(2, '0')}</span>
                {b?.n ? <span className="v">{formatMoney(b.net, { signed: true, compact: true })}</span> : null}
              </span>
            </Tooltip>
          );
        })}
      </div>
      <div className="jk-hours-foot">
        <span className="text-t3">Hours in {tz}</span>
        {best && best.net > 0 ? (
          <span>
            Best <b>{best.label}</b> <span className="up">{formatMoney(best.net, { signed: true })}</span>
          </span>
        ) : null}
        {worst && worst.net < 0 ? (
          <span>
            Worst <b>{worst.label}</b> <span className="down">{formatMoney(worst.net, { signed: true })}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
