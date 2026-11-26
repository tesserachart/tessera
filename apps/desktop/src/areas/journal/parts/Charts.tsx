import type { Bucket, EquityPoint } from '@tessera/protocol';
import { Tooltip, cx, formatMoney } from '@tessera/ui';
import type { ReactNode } from 'react';
import { AreaGraph, BarGraph, EquityGraph, type EquitySample, type Marker, type Tone } from '../../../graphs/index.ts';
import { intensity } from '../model/calendar.ts';
import { SMALL_N, metricText, metricValue, type BucketMetric } from '../model/metrics.ts';
import { clock, dayLabel, nsToMs, pct, rLabel, todayIn } from '../model/format.ts';

const NOTHING = 'Nothing to measure yet.';
const ORIGIN: EquitySample = { x: 0, equity: 0, peak: 0, drawdown: 0 };

function tradeDay(t: number): string {
  return dayLabel(todayIn(undefined, nsToMs(t)));
}

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
  const last = points[points.length - 1];
  const at = (i: number) => (i >= 1 ? points[i - 1] : undefined);
  return (
    <EquityGraph
      samples={
        points.length
          ? [ORIGIN, ...points.map((p) => ({ x: p.i, equity: p.equity, peak: p.peak, drawdown: p.drawdown }))]
          : []
      }
      axis={{
        kind: 'trades',
        label: (i) => {
          const p = at(i);
          return p ? tradeDay(p.t) : '';
        },
      }}
      height={height}
      label={`Equity curve over ${String(points.length)} trades, ending at ${formatMoney(last?.equity, { signed: true })}`}
      onPick={
        onPick
          ? (i) => {
              const p = at(i);
              if (p) onPick(p.tradeId);
            }
          : undefined
      }
      empty={empty}
      tip={(i) => {
        const p = at(i);
        return p ? <EquityTip p={p} /> : null;
      }}
    />
  );
}

function EquityTip({ p }: { p: EquityPoint }) {
  return (
    <>
      <b>Trade {p.i}</b>
      <span className="text-t3">
        {tradeDay(p.t)} · {clock(p.t)}
      </span>
      <span>
        Trade <span className={p.pnl >= 0 ? 'up' : 'down'}>{formatMoney(p.pnl, { signed: true })}</span>
      </span>
      <span>Equity {formatMoney(p.equity, { signed: true })}</span>
      {p.drawdown > 0 ? (
        <span className="text-t3">{formatMoney(-p.drawdown, { signed: true })} from the peak</span>
      ) : null}
    </>
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
  tones?: readonly Tone[];
}) {
  return (
    <BarGraph
      bars={buckets.map((b, i) => ({
        key: b.key,
        value: metricValue(b, metric) ?? 0,
        label: b.label,
        note: b.n ? `n ${String(b.n)}` : '',
        faint: b.n < SMALL_N,
        tone: tones?.[i],
      }))}
      signed={metric !== 'n' && metric !== 'winRate'}
      height={height}
      label="Bars by bucket"
      empty={NOTHING}
      onPick={
        onPick
          ? (i) => {
              const b = buckets[i];
              if (b) onPick(b);
            }
          : undefined
      }
      tip={(i) => {
        const b = buckets[i];
        return b ? <BucketTip b={b} /> : null;
      }}
    />
  );
}

function BucketTip({ b }: { b: Bucket }) {
  return (
    <>
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
    </>
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
  if (!buckets.length) return <div className="jr-empty">{NOTHING}</div>;
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

export interface SeriesPoint {
  label: string;
  value: number;
  detail?: readonly string[];
  tradeId?: string;
}

function SeriesTip({ p, format }: { p: SeriesPoint; format: (v: number) => string }) {
  return (
    <>
      <b>{p.label}</b>
      <span className={p.value >= 0 ? 'up' : 'down'}>{format(p.value)}</span>
      {p.detail?.map((d) => (
        <span key={d} className="text-t3">
          {d}
        </span>
      ))}
    </>
  );
}

function signedMoney(v: number): string {
  return formatMoney(v, { signed: true });
}

export function AreaChart({
  points,
  height = 220,
  onPick,
  markers,
  empty = NOTHING,
}: {
  points: readonly SeriesPoint[];
  height?: number;
  onPick?: (p: SeriesPoint) => void;
  markers?: readonly Marker[];
  empty?: ReactNode;
}) {
  return (
    <AreaGraph
      values={points.map((p) => p.value)}
      labels={points.map((p) => p.label)}
      height={height}
      markers={markers}
      label="Area chart"
      empty={empty}
      onPick={
        onPick
          ? (i) => {
              const p = points[i];
              if (p) onPick(p);
            }
          : undefined
      }
      tip={(i) => {
        const p = points[i];
        return p ? <SeriesTip p={p} format={signedMoney} /> : null;
      }}
    />
  );
}

export function SignedBars({
  points,
  height = 200,
  onPick,
  format = signedMoney,
}: {
  points: readonly SeriesPoint[];
  height?: number;
  onPick?: (p: SeriesPoint) => void;
  format?: (v: number) => string;
}) {
  return (
    <BarGraph
      bars={points.map((p, i) => ({ key: `${p.label}-${String(i)}`, value: p.value }))}
      height={height}
      axis={(v) => formatMoney(v, { signed: true, compact: true })}
      label="Bars"
      empty={NOTHING}
      onPick={
        onPick
          ? (i) => {
              const p = points[i];
              if (p) onPick(p);
            }
          : undefined
      }
      tip={(i) => {
        const p = points[i];
        return p ? <SeriesTip p={p} format={format} /> : null;
      }}
    />
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
