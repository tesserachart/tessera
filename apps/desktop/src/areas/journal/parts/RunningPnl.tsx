import type { Timeframe, TradeDetail } from '@tessera/protocol';
import { Reveal, formatMoney } from '@tessera/ui';
import { useMemo } from 'react';
import { MetricCard, MetricGrid } from '../kit/index.ts';
import { clock, nsToMs, tone } from '../model/format.ts';
import { fillMarkers, pnlRange, runningPnl, type PnlMarker, type PnlPoint } from '../model/runningPnl.ts';
import { SAMPLE_DETAIL, SAMPLE_RUNNING_SERIES } from '../sections/samples.ts';
import { AreaChart, type SeriesPoint } from './Charts.tsx';
import { TfSelect } from './TradeChart.tsx';
import { TF_MS, useTradeBars, useTradeTf } from './tradeBars.ts';

interface RunningView {
  bars: boolean;
  instrument: string;
  tf: Timeframe;
  net: number;
  points: SeriesPoint[];
  markers: PnlMarker[];
  best: number;
  worst: number;
  last: number | null;
}

function runningView(d: TradeDetail, series: readonly PnlPoint[], tf: Timeframe, bars: boolean): RunningView {
  const step = TF_MS[tf] ?? 60_000;
  return {
    bars,
    instrument: d.trade.instrument,
    tf,
    net: d.trade.netPnl,
    points: series.map((p) => ({
      label: clock(p.t * 1e6),
      value: p.pnl,
      detail: [p.pos === 0 ? 'Flat' : `${p.pos > 0 ? 'Long' : 'Short'} ${String(Math.abs(p.pos))}`],
    })),
    markers: fillMarkers(
      d.executions.map((e) => ({ tMs: nsToMs(e.ts), kind: e.kind })),
      series,
      step,
    ),
    ...pnlRange(series),
  };
}

const SAMPLE_RUNNING = runningView(SAMPLE_DETAIL, SAMPLE_RUNNING_SERIES, '1m', true);

export function RunningPnl({ d }: { d: TradeDetail }) {
  const [tf, choice, setChoice] = useTradeTf(d.trade.holdSecs);
  const { bars, state } = useTradeBars(d, tf);
  const view = useMemo(() => {
    if (state === 'loading') return null;
    const fills = d.executions.map((e) => ({ t: nsToMs(e.ts), side: e.side, qty: e.qty, price: e.price }));
    return runningView(d, runningPnl(bars, fills, d.pointValue, TF_MS[tf] ?? 60_000), tf, state === 'ready');
  }, [d, bars, tf, state]);
  return (
    <div className="jt-running">
      <div className="jr-tchart-head">
        <TfSelect choice={choice} tf={tf} onChange={setChoice} />
        <span className="text-t3">Realized plus open at each close, before fees</span>
      </div>
      <Reveal label="Loading the running P&L" data={view} sample={SAMPLE_RUNNING}>
        {(v) => <RunningBody v={v} />}
      </Reveal>
    </div>
  );
}

function RunningBody({ v }: { v: RunningView }) {
  return (
    <>
      {v.bars ? (
        <AreaChart points={v.points} height={300} markers={v.markers} />
      ) : (
        <div className="jr-empty">No bars for {v.instrument} at its time from the connections open now.</div>
      )}
      <MetricGrid>
        <MetricCard title="Best it stood" value={formatMoney(v.best, { signed: true })} tone={tone(v.best)} />
        <MetricCard title="Worst it stood" value={formatMoney(v.worst, { signed: true })} tone={tone(v.worst)} />
        <MetricCard
          title="Ended at"
          value={v.last === null ? '—' : formatMoney(v.last, { signed: true })}
          tone={tone(v.last)}
          description={`Net after fees ${formatMoney(v.net, { signed: true })}`}
        />
        <MetricCard title="Bars held" value={String(v.points.length)} description={`At ${v.tf}`} />
      </MetricGrid>
    </>
  );
}
