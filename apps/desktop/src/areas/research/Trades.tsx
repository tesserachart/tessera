import { TradeLayer, TradesLayer, createChart, type ChartApi, type TradeOverlay } from '@tessera/chart';
import { normalizeEpochMs, timeframeMs, type CaseResult, type Study, type StudyRun } from '@tessera/protocol';
import { Loaded, NumberCell, PRICE_TEXT, TBody, TGroup, THead, Table, Td, Th, Tr, cx } from '@tessera/ui';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTool, valueOf } from '../../app/tools.ts';
import { read } from '../../app/store.ts';
import { chartThemeStore, orderColorsOf } from '../../chart/chartTheme.ts';
import { useInstrumentSpec } from '../../market/instruments.ts';
import {
  EXIT_WORD,
  SPLIT_WORD,
  candlesInput,
  inCandles,
  numberedTrades,
  sideWord,
  sortTrades,
  tradeFrame,
  tradeOverlay,
  tradeTime,
  type IndexedTrade,
  type TradeKey,
} from './tester.ts';

export function TradesView({
  study,
  run,
  base,
  symbol,
}: {
  study: Study;
  run: StudyRun;
  base: CaseResult;
  symbol: string;
}) {
  const rows = useMemo(() => numberedTrades(base), [base]);
  const [picked, setPicked] = useState(rows.length ? rows.length - 1 : null);
  return (
    <div className="rs-trades">
      <Loaded label="Loading the price chart" sample={<PriceSample symbol={symbol} tf={study.data.tf} />}>
        <PriceChart study={study} run={run} base={base} symbol={symbol} picked={picked} />
      </Loaded>
      <TradeList rows={rows} picked={picked} onPick={setPicked} />
    </div>
  );
}

function PriceSection({ symbol, tf, children }: { symbol: string; tf: string; children: ReactNode }) {
  return (
    <section className="rs-sec">
      <h3 className="rs-sec-title">
        Price · {symbol} {tf}
      </h3>
      {children}
    </section>
  );
}

function PriceSample({ symbol, tf }: { symbol: string; tf: string }) {
  return (
    <PriceSection symbol={symbol} tf={tf}>
      <div className="rs-price">
        <canvas className="block size-full" />
      </div>
    </PriceSection>
  );
}

function PriceChart({
  study,
  run,
  base,
  symbol,
  picked,
}: {
  study: Study;
  run: StudyRun;
  base: CaseResult;
  symbol: string;
  picked: number | null;
}) {
  const pickedTrade = picked === null ? null : (base.trades[picked] ?? null);
  const [input, setInput] = useState(() => candlesInput(study, run, pickedTrade));
  if (pickedTrade && !inCandles(input, pickedTrade)) setInput(candlesInput(study, run, pickedTrade));
  const q = useTool('market.get_candles', input, { keepFor: 5 * 60_000 });
  const spec = useInstrumentSpec(study.data.instrument);
  const data = valueOf(q);
  const bars = useMemo(
    () => (data?.bars ?? []).map((b) => ({ t: normalizeEpochMs(b[0]), o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] })),
    [data],
  );
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<{ api: ChartApi; picked: TradeLayer; colors: TradeOverlay['colors'] } | null>(null);
  const step = timeframeMs(study.data.tf);
  const decimals = spec?.priceDecimals ?? data?.priceDecimals ?? 2;

  useEffect(() => {
    const el = host.current;
    if (!el || !bars.length) return;
    const { theme, resolved } = read(chartThemeStore);
    const oc = orderColorsOf(resolved);
    const colors = {
      entry: oc.mist,
      up: oc.up,
      down: oc.down,
      stopZone: oc.downZone,
      targetZone: oc.upZone,
      label: theme.mutedText,
    };
    const api = createChart(el, {
      theme,
      legend: { title: `${symbol} · ${study.data.tf}`, hover: true },
      timeframeMs: step,
      rightPadBars: 4,
      volumePane: 0,
      priceFormat: { precision: decimals, minMove: spec?.tickSize ?? 10 ** -decimals },
    });
    api.setLayerVisible('last-price', false);
    api.setData('main', bars);
    const all = new TradesLayer({ id: 'study-trades', z: 23 });
    api.addLayer(all);
    all.setTrades(base.trades.map((t) => tradeOverlay(t, colors)));
    const one = new TradeLayer({ id: 'study-trade', z: 24 });
    api.addLayer(one);
    chart.current = { api, picked: one, colors };
    return () => {
      chart.current = null;
      api.destroy();
    };
  }, [bars, base, symbol, study.data.tf, step, decimals, spec?.tickSize]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !bars.length) return;
    const last = bars[bars.length - 1]!.t + step;
    c.picked.setTrade(pickedTrade ? tradeOverlay(pickedTrade, c.colors) : null);
    c.api.setViewport({
      range: pickedTrade ? tradeFrame(pickedTrade, step, last) : { from: last - 160 * step, to: last },
    });
  }, [pickedTrade, bars, step]);

  return (
    <PriceSection symbol={symbol} tf={study.data.tf}>
      {q.isSuccess && !bars.length ? (
        <p className="rs-wait">No bars saved for this range.</p>
      ) : (
        <div
          className="rs-price"
          ref={host}
          role="img"
          aria-label={`Price chart with ${String(base.trades.length)} trades marked`}
        />
      )}
    </PriceSection>
  );
}

const COLUMNS: readonly { key: TradeKey | null; label: string; align: 'left' | 'right' }[] = [
  { key: null, label: '#', align: 'right' },
  { key: 'entryTime', label: 'Entry', align: 'left' },
  { key: 'side', label: 'Side', align: 'left' },
  { key: null, label: 'Entry price', align: 'right' },
  { key: null, label: 'Exit price', align: 'right' },
  { key: 'exit', label: 'Exit', align: 'left' },
  { key: 'bars', label: 'Bars', align: 'right' },
  { key: 'mae', label: 'MAE', align: 'right' },
  { key: 'mfe', label: 'MFE', align: 'right' },
  { key: 'pnl', label: 'P&L', align: 'right' },
];

function TradeList({
  rows,
  picked,
  onPick,
}: {
  rows: readonly IndexedTrade[];
  picked: number | null;
  onPick: (i: number) => void;
}) {
  const [sort, setSort] = useState<TradeKey>('entryTime');
  const [ascending, setAscending] = useState(true);
  const sorted = useMemo(() => sortTrades(rows, sort, ascending), [rows, sort, ascending]);
  const sortBy = (key: TradeKey) => {
    if (key === sort) setAscending(!ascending);
    else {
      setSort(key);
      setAscending(key === 'entryTime');
    }
  };
  if (!rows.length) return <p className="rs-wait">No trades in this run.</p>;
  return (
    <section className="rs-sec">
      <h3 className="rs-sec-title">Trades · {rows.length}</h3>
      <div className="rs-table-wrap">
        <Table className="rs-tlist" aria-label="Trades">
          <THead>
            <tr>
              {COLUMNS.map((c) => (
                <Th
                  key={c.label}
                  align={c.align}
                  aria-sort={c.key && c.key === sort ? (ascending ? 'ascending' : 'descending') : undefined}
                >
                  {c.key ? (
                    <button
                      type="button"
                      className={cx('rs-sort', c.key === sort && 'is-sorted')}
                      onClick={() => sortBy(c.key!)}
                    >
                      {c.label}
                      <span className="rs-sortmark" aria-hidden>
                        {c.key === sort ? (ascending ? '↑' : '↓') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </Th>
              ))}
            </tr>
          </THead>
          <TBody>
            {sorted.map((r, i) => {
              const t = r.trade;
              const opens = sort === 'entryTime' && r.split !== sorted[i - 1]?.split;
              return (
                <Fragment key={r.n}>
                  {opens ? (
                    <TGroup colSpan={COLUMNS.length}>
                      {SPLIT_WORD[r.split]} · {rows.filter((x) => x.split === r.split).length}
                    </TGroup>
                  ) : null}
                  <Tr selected={picked === r.n - 1} className="rs-trow" onClick={() => onPick(r.n - 1)}>
                    <Td align="right" className="t3">
                      {r.n}
                    </Td>
                    <Td>
                      <span className={PRICE_TEXT}>{tradeTime(t.entryTime)}</span>
                    </Td>
                    <Td className={t.qty > 0 ? 'up' : 'down'}>{sideWord(t)}</Td>
                    <NumberCell value={t.entryPrice} kind="price" />
                    <NumberCell value={t.exitPrice} kind="price" />
                    <Td>
                      {EXIT_WORD[t.exit]}
                      {t.approximate ? <span className="rs-approx-mark"> ≈</span> : null}
                    </Td>
                    <NumberCell value={t.bars} kind="int" />
                    <NumberCell value={t.mae} kind="pnl" precision={0} />
                    <NumberCell value={t.mfe} kind="pnl" precision={0} />
                    <NumberCell value={t.pnl} kind="pnl" precision={0} />
                  </Tr>
                </Fragment>
              );
            })}
          </TBody>
        </Table>
      </div>
    </section>
  );
}
