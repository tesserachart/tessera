import type { TradeDetail } from '@tessera/protocol';
import { TradeLayer, createChart, type ChartApi } from '@tessera/chart';
import { IconButton, Tooltip, cx, formatMoney } from '@tessera/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartSkeleton } from '../../../chart/ChartSkeleton.tsx';
import { chartThemeStore, orderColorsOf } from '../../../chart/chartTheme.ts';
import { clock, nsToMs, tone } from '../model/format.ts';
import { SPEEDS, advance, replayStart, shownBars, stepBar, type Speed } from '../model/replay.ts';
import { runningPnl } from '../model/runningPnl.ts';
import { tradeFrame, tradeOverlayOf } from '../model/tradeOverlay.ts';
import { TfSelect } from './TradeChart.tsx';
import { TF_MS, useTradeBars, useTradeTf } from './tradeBars.ts';
import { read } from '../../../app/store.ts';

const SPEED_KEY = 'tessera.journal.replaySpeed';
const TICK = 100;

export function Replay({ d }: { d: TradeDetail }) {
  const t = d.trade;
  const [tf, choice, setChoice] = useTradeTf(t.holdSecs);
  const { bars, state } = useTradeBars(d, tf);
  const starts = useMemo(() => bars.map((b) => b.t), [bars]);
  const step = TF_MS[tf] ?? 60_000;
  const start = replayStart(starts, nsToMs(t.openedAt));
  const end = starts[starts.length - 1] ?? start;
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(() => {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return (SPEEDS as readonly number[]).includes(v) ? (v as Speed) : 1;
  });
  const [seen, setSeen] = useState(`${t.id}:${tf}`);
  if (`${t.id}:${tf}` !== seen) {
    setSeen(`${t.id}:${tf}`);
    setCursor(null);
    setPlaying(false);
  }
  const cur = Math.min(end, cursor ?? start);
  const n = shownBars(starts, cur);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setCursor((c) => {
        const next = advance(c ?? start, TICK, speed);
        if (next >= end) {
          setPlaying(false);
          return end;
        }
        return next;
      });
    }, TICK);
    return () => window.clearInterval(id);
  }, [playing, speed, start, end]);
  const fills = useMemo(
    () => d.executions.map((e) => ({ t: nsToMs(e.ts), side: e.side, qty: e.qty, price: e.price })),
    [d.executions],
  );
  const series = useMemo(() => runningPnl(bars, fills, d.pointValue, step), [bars, fills, d.pointValue, step]);
  const now = series.filter((p) => p.t <= cur).pop() ?? null;
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<{ chart: ChartApi; trade: TradeLayer; shown: number } | null>(null);
  const at = useRef({ n, cur });
  useEffect(() => {
    at.current = { n, cur };
  });
  useEffect(() => {
    const el = host.current;
    if (!el || !bars.length) return;
    const { theme, resolved } = read(chartThemeStore);
    const frame = tradeFrame(nsToMs(t.openedAt), t.closedAt === null ? null : nsToMs(t.closedAt), end, step);
    const framed = bars.filter((b) => b.t >= frame.from && b.t <= frame.to).length;
    const chart = createChart(el, {
      theme,
      legend: { title: `${t.symbol} · ${tf} · replay`, hover: true },
      timeframeMs: step,
      initialBars: Math.max(30, framed),
      rightPadBars: 6,
      volumePane: 0,
      priceFormat: { precision: t.priceDecimals, minMove: d.tickSize || 0.01 },
    });
    const shown = Math.max(1, at.current.n);
    chart.setData('main', bars.slice(0, shown));
    chart.setViewport({ barSpacing: Math.max(3, (el.clientWidth - 80) / Math.max(30, framed)) });
    const oc = orderColorsOf(resolved);
    const trade = new TradeLayer({ id: 'replay-trade', z: 24 });
    chart.addLayer(trade);
    trade.setTrade(
      tradeOverlayOf(d, {
        entry: oc.mist,
        up: oc.up,
        down: oc.down,
        stopZone: oc.downZone,
        targetZone: oc.upZone,
        label: theme.mutedText,
      }),
    );
    trade.setUntil(at.current.cur);
    live.current = { chart, trade, shown };
    return () => {
      live.current = null;
      chart.destroy();
    };
  }, [bars, d, t, tf, step, end]);
  useEffect(() => {
    const l = live.current;
    if (!l) return;
    const want = Math.max(1, n);
    if (want === l.shown + 1) l.chart.update('main', bars[want - 1]!);
    else if (want !== l.shown) l.chart.setData('main', bars.slice(0, want), { keepView: true });
    l.shown = want;
  }, [bars, n]);
  useEffect(() => {
    live.current?.trade.setUntil(cur);
  }, [cur]);
  const pickSpeed = (s: Speed) => {
    localStorage.setItem(SPEED_KEY, String(s));
    setSpeed(s);
  };
  return (
    <div className="jt-replay">
      <div className="jr-tchart-head">
        <TfSelect choice={choice} tf={tf} onChange={setChoice} />
        <span className="jt-replay-clock">{clock(cur * 1e6)}</span>
        {now ? (
          <span className="jt-replay-pnl">
            Running <b className={cx(tone(now.pnl))}>{formatMoney(now.pnl, { signed: true })}</b>
            <span className="text-t3">
              {' '}
              · {now.pos === 0 ? 'flat' : `${now.pos > 0 ? 'long' : 'short'} ${String(Math.abs(now.pos))}`}
            </span>
          </span>
        ) : (
          <span className="text-t3">Before the entry</span>
        )}
      </div>
      <div className="jr-tchart-plot" ref={host} style={{ height: 380 }}>
        {state === 'none' ? (
          <div className="jr-empty">No bars for {t.instrument} at its time from the connections open now.</div>
        ) : state === 'loading' ? (
          <ChartSkeleton chart={null} instrument={t.instrument} />
        ) : null}
      </div>
      <div className="jt-replay-ctl">
        <input
          type="range"
          className="jt-scrub"
          aria-label="Replay time"
          min={start}
          max={end}
          step={step}
          value={cur}
          onChange={(e) => {
            setPlaying(false);
            setCursor(Number(e.target.value));
          }}
        />
        <div className="jt-replay-btns">
          <Tooltip content="Back to the start">
            <IconButton label="Back to the start" icon="replay" onClick={() => (setPlaying(false), setCursor(start))} />
          </Tooltip>
          <Tooltip content="A bar back">
            <IconButton
              label="A bar back"
              icon="chevron-left"
              onClick={() => (setPlaying(false), setCursor(stepBar(starts, cur, -1)))}
            />
          </Tooltip>
          <Tooltip content={playing ? 'Pause' : 'Play'}>
            <IconButton
              label={playing ? 'Pause' : 'Play'}
              icon={playing ? 'pause' : 'play'}
              active={playing}
              disabled={!bars.length}
              onClick={() => {
                if (!playing && cur >= end) setCursor(start);
                setPlaying(!playing);
              }}
            />
          </Tooltip>
          <Tooltip content="A bar on">
            <IconButton
              label="A bar on"
              icon="chevron-right"
              onClick={() => (setPlaying(false), setCursor(stepBar(starts, cur, 1)))}
            />
          </Tooltip>
          <span className="jt-speeds" role="radiogroup" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button
                type="button"
                role="radio"
                key={s}
                aria-checked={s === speed}
                className={cx(s === speed && 'is-on')}
                onClick={() => pickSpeed(s)}
              >
                {s}x
              </button>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
