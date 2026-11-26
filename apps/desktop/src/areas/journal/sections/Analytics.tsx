import { valueOf } from '../../../app/tools.ts';
import type { Breakdowns, Bucket, JournalStats, TradeFilter } from '@tessera/protocol';
import { Button, Loaded, Segmented, Select, Table, TBody, Td, Th, THead, cx, Reveal, formatMoney } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { useCalendar, useCatalog, useJournalAction, useScopedFilter, useStats, useToday } from '../data.ts';
import { Empty, METRIC_TIPS, MetricCard, MetricGrid, PageHead, Panel, StatRow, Toggle } from '../kit/index.ts';
import { cumulative } from '../model/chart.ts';
import { clock, dayLabel, holdLabel, nsToMs, pct, plural, rLabel, todayIn, tone } from '../model/format.ts';
import { METRICS, SMALL_N, metricValue, type BucketMetric } from '../model/metrics.ts';
import { symbolSeries } from '../model/symbols.ts';
import { YearHeat } from '../parts/Calendar.tsx';
import { AreaChart, BarRows, BucketBars, EquityChart, HourGrid, SignedBars } from '../parts/Charts.tsx';
import { Donut, LinesGraph } from '../../../graphs/index.ts';
import { QueryBar, QueryBarSample } from '../parts/QueryBar.tsx';
import { SAMPLE_STATS } from './samples.ts';
import { openDay, openTrade, setJournal, useJournalUi, type ReportTab } from '../store.ts';
import './analytics.css';
import { zoneLabel } from '../../../state/timeZone.ts';

const REPORT_TABS: { value: ReportTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'time', label: 'Time' },
  { value: 'risk', label: 'Risk' },
  { value: 'symbols', label: 'Symbols' },
  { value: 'behaviour', label: 'Behaviour' },
  { value: 'breakdowns', label: 'Breakdowns' },
];

export function Analytics() {
  return (
    <Loaded label="Loading the analytics" sample={<AnalyticsSample />}>
      <AnalyticsBody />
    </Loaded>
  );
}

export function AnalyticsSample() {
  return (
    <div className="ja-page">
      <PageHead title="Analytics" sub="Measured from 000 closed trades · breakeven within ±$0.00">
        <Button size="s" variant="quiet" tabIndex={-1}>
          Export filtered trades
        </Button>
      </PageHead>
      <div className="ja-body">
        <QueryBarSample filter={{}} trades={SAMPLE_STATS.overview.all.n} />
        <Segmented<ReportTab>
          label="Analytics"
          className="ja-tabs"
          value="overview"
          onChange={() => undefined}
          options={REPORT_TABS}
        />
        <OverviewTab s={SAMPLE_STATS} />
      </div>
    </div>
  );
}

function AnalyticsBody() {
  const filter = useJournalUi((s) => s.filter);
  const tab = useJournalUi((s) => s.reportTab);
  const scoped = useScopedFilter(true);
  const stats = valueOf(useStats(scoped));
  const cat = valueOf(useCatalog());
  const act = useJournalAction();
  const s = stats ?? null;
  return (
    <div className="ja-page">
      <PageHead
        title="Analytics"
        sub={
          s
            ? `Measured from ${plural(s.overview.all.n, 'closed trade')} · breakeven within ±${formatMoney(s.breakevenThreshold)}`
            : undefined
        }
      >
        <Button
          size="s"
          variant="quiet"
          onClick={() =>
            void act('journal.export_trades', { filter: scoped }).then((out) => {
              const url = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = out.filename;
              a.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
          }
        >
          Export filtered trades
        </Button>
      </PageHead>
      <div className="ja-body">
        <QueryBar filter={filter} onChange={(f) => setJournal({ filter: f })} catalog={cat ?? null} />
        <Segmented<ReportTab>
          label="Analytics"
          className="ja-tabs"
          value={tab}
          onChange={(v) => setJournal({ reportTab: v })}
          options={REPORT_TABS}
        />
        <Reveal label="Loading the stats" data={s} sample={SAMPLE_STATS}>
          {(s) =>
            s.overview.all.n === 0 ? (
              <Empty icon="trades" title="No closed trades in this query">
                Widen the dates or clear a filter in the query bar.
              </Empty>
            ) : tab === 'overview' ? (
              <OverviewTab s={s} />
            ) : tab === 'time' ? (
              <TimeTab s={s} filter={scoped} />
            ) : tab === 'risk' ? (
              <RiskTab s={s} />
            ) : tab === 'symbols' ? (
              <SymbolsTab s={s} />
            ) : tab === 'behaviour' ? (
              <BehaviourTab s={s} />
            ) : (
              <BreakdownTab s={s} />
            )
          }
        </Reveal>
      </div>
    </div>
  );
}

function drill(by: keyof Breakdowns, b: Bucket): void {
  const f = (patch: TradeFilter) => setJournal({ section: 'trades', trade: null, filter: patch });
  switch (by) {
    case 'symbol':
      return f({ symbols: [b.key] });
    case 'setup':
      return f({ setups: [b.key] });
    case 'tag':
      return f({ tags: [b.key] });
    case 'account':
      return f({ accounts: [b.key] });
    case 'side':
      return f({ side: b.key === 'long' ? 'buy' : 'sell' });
    case 'weekday':
      return f({ weekdays: [Number(b.key)] });
    case 'hour':
      return f({ hours: [Number(b.key)] });
    case 'session':
      return f({ sessions: [b.key] });
    case 'day':
      return openDay(b.key);
    default:
      return undefined;
  }
}

function pf(b: Bucket): string {
  if (b.profitFactor !== null) return b.profitFactor.toFixed(2);
  return b.grossProfit > 0 ? '∞' : '—';
}

function Row({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <div className={cx('ja-row', cols === 3 && 'is-3')}>{children}</div>;
}

function BucketTable({
  buckets,
  by,
  first = 'Bucket',
}: {
  buckets: readonly Bucket[];
  by?: keyof Breakdowns;
  first?: string;
}) {
  return (
    <Table className="jr-table jr-btable">
      <THead>
        <tr>
          <Th>{first}</Th>
          <Th align="right">Trades</Th>
          <Th align="right">P&amp;L</Th>
          <Th align="right">Per trade</Th>
          <Th align="right">Win %</Th>
          <Th align="right">PF</Th>
          <Th align="right">Avg R</Th>
        </tr>
      </THead>
      <TBody>
        {buckets.map((b) => (
          <tr
            key={b.key}
            className={cx(b.n < SMALL_N && 'is-small', by && 'is-link')}
            onClick={by ? () => drill(by, b) : undefined}
          >
            <Td>{b.label}</Td>
            <Td align="right" className="t3">
              {b.n}
            </Td>
            <Td align="right" className={tone(b.net)}>
              {formatMoney(b.net, { signed: true })}
            </Td>
            <Td align="right">{formatMoney(b.avg, { signed: true })}</Td>
            <Td align="right">{pct(b.winRate, 0)}</Td>
            <Td align="right">{pf(b)}</Td>
            <Td align="right">{rLabel(b.avgR)}</Td>
          </tr>
        ))}
      </TBody>
    </Table>
  );
}

function OverviewTab({ s }: { s: JournalStats }) {
  const o = s.overview;
  const a = o.all;
  const streak = o.currentStreak;
  const eq = s.equity;
  const last50 = eq.slice(-50);
  return (
    <div className="ja-stack">
      <MetricGrid>
        <MetricCard
          title="Total P&L"
          value={formatMoney(a.net, { signed: true })}
          tone={tone(a.net)}
          tip={METRIC_TIPS.totalPnl}
          description={`After ${formatMoney(-a.fees, { signed: true })} fees`}
        />
        <MetricCard
          title="Win rate"
          value={pct(a.winRate)}
          tip={METRIC_TIPS.winRate}
          description={`${String(a.wins)}W / ${String(a.losses)}L${o.winRateLow !== null && o.winRateHigh !== null ? ` · 95% ${o.winRateLow.toFixed(0)}–${o.winRateHigh.toFixed(0)}%` : ''}`}
        />
        <MetricCard
          title="Profit factor"
          value={pf(a)}
          tone={a.profitFactor !== null && a.profitFactor < 1 ? 'down' : undefined}
          tip={METRIC_TIPS.profitFactor}
          description={`${formatMoney(a.grossProfit, { signed: true })} won / ${formatMoney(-a.grossLoss, { signed: true })} lost`}
        />
        <MetricCard
          title="Avg trade"
          value={formatMoney(a.avg, { signed: true })}
          tone={tone(a.avg)}
          tip={METRIC_TIPS.avgTrade}
          description={plural(a.n, 'closed trade')}
        />
        <MetricCard
          title="Expectancy"
          value={formatMoney(a.expectancy, { signed: true })}
          tone={tone(a.expectancy)}
          tip={METRIC_TIPS.expectancy}
          description="Per trade, measured"
        />
        <MetricCard
          title="Payoff ratio"
          value={o.payoffRatio === null ? '—' : o.payoffRatio.toFixed(2)}
          tip={METRIC_TIPS.payoffRatio}
          description={`${formatMoney(a.avgWin, { signed: true })} avg win / ${formatMoney(-a.avgLoss, { signed: true })} avg loss`}
        />
        <MetricCard
          title="Sharpe ratio"
          value={o.sharpe === null ? '—' : o.sharpe.toFixed(2)}
          tip={METRIC_TIPS.sharpeRatio}
          description="Per trade"
        />
        <MetricCard
          title="Current streak"
          value={streak === 0 ? '—' : `${String(Math.abs(streak))}${streak > 0 ? 'W' : 'L'}`}
          tone={streak > 0 ? 'up' : streak < 0 ? 'down' : undefined}
          tip={METRIC_TIPS.currentStreak}
          description={`Longest ${String(o.maxWinStreak)}W · ${String(o.maxLossStreak)}L`}
        />
      </MetricGrid>
      <Row>
        <Panel chrome="win-loss-distribution" title="Win/Loss distribution">
          <Donut
            empty="Nothing to measure yet."
            segments={[
              { key: 'w', label: 'Winners', value: a.wins, tone: 'up' },
              { key: 'l', label: 'Losers', value: a.losses, tone: 'down' },
              { key: 'b', label: 'Breakeven', value: a.breakevens, tone: 'mist' },
            ]}
            center={
              <>
                <b>{pct(a.winRate, 0)}</b>
                <span>win rate</span>
              </>
            }
          />
        </Panel>
        <Panel chrome="cumulative-pnl" title="Cumulative P&L">
          <AreaChart
            height={220}
            onPick={(p) => p.tradeId && openTrade(p.tradeId)}
            points={eq.map((p) => ({
              label: dayLabel(todayIn(s.timezone, nsToMs(p.t))),
              value: p.equity,
              tradeId: p.tradeId,
              detail: [`Trade ${String(p.i)} · ${formatMoney(p.pnl, { signed: true })}`],
            }))}
          />
        </Panel>
      </Row>
      <Panel chrome="pnl-by-trade" title="P&L by trade" description={`The last ${String(last50.length)} closed trades`}>
        <SignedBars
          height={200}
          onPick={(p) => p.tradeId && openTrade(p.tradeId)}
          points={last50.map((p) => ({
            label: `Trade ${String(p.i)}`,
            value: p.pnl,
            tradeId: p.tradeId,
            detail: [`${dayLabel(todayIn(s.timezone, nsToMs(p.t)))} · ${clock(p.t)}`],
          }))}
        />
      </Panel>
    </div>
  );
}

function TimeTab({ s, filter }: { s: JournalStats; filter: TradeFilter }) {
  const today = useToday();
  const cat = valueOf(useCatalog());
  const yearAgo = `${String(Number(today.slice(0, 4)) - 1)}${today.slice(4)}`;
  const { from: _f, to: _t, ...rest } = filter;
  const cal = valueOf(useCalendar(yearAgo, today, rest));
  const o = s.overview;
  const dow = s.by.weekday.filter((b) => b.n > 0);
  const best = dow.reduce<Bucket | null>((m, b) => (!m || b.net > m.net ? b : m), null);
  const worst = dow.reduce<Bucket | null>((m, b) => (!m || b.net < m.net ? b : m), null);
  const months = s.by.month;
  const monthCum = cumulative(months.map((m) => m.net));
  const sessions = cat?.settings.sessions ?? [];
  return (
    <div className="ja-stack">
      <Panel
        chrome="trading-calendar"
        title="Trading calendar"
        description="The last year"
        actions={<span className="text-t3">{cal ? formatMoney(cal.total.net, { signed: true }) : ''}</span>}
      >
        <div className="jr-yearrow">
          <YearHeat days={cal?.days ?? null} end={today} onDay={openDay} />
          <div className="ja-facts">
            <StatRow
              label="Best day"
              value={o.bestDay ? `${formatMoney(o.bestDay.net, { signed: true })} · ${o.bestDay.label}` : '—'}
              tone={o.bestDay ? 'up' : undefined}
            />
            <StatRow
              label="Worst day"
              value={o.worstDay ? `${formatMoney(o.worstDay.net, { signed: true })} · ${o.worstDay.label}` : '—'}
              tone={o.worstDay ? 'down' : undefined}
            />
            <StatRow label="Green · red days" value={`${String(o.greenDays)} · ${String(o.redDays)}`} />
            <StatRow label="Net per day" value={formatMoney(o.avgDay, { signed: true })} tone={tone(o.avgDay)} />
          </div>
        </div>
      </Panel>
      <Row>
        <Panel chrome="day-of-week" title="Day of week" description="By the weekday of entry">
          <BarRows buckets={s.by.weekday} onPick={(b) => drill('weekday', b)} />
          <div className="ja-bestworst">
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
          <BucketTable buckets={s.by.weekday.filter((b) => b.n > 0)} by="weekday" first="Day" />
        </Panel>
        <Panel chrome="hourly-performance" title="Hourly performance" description="By the hour of entry">
          <HourGrid buckets={s.by.hour} tz={zoneLabel(s.timezone)} />
        </Panel>
      </Row>
      <Panel
        chrome="trading-sessions"
        title="Trading sessions"
        description="Each in its own market’s hours"
        actions={
          <Button size="s" variant="quiet" onClick={() => setJournal({ section: 'settings' })}>
            Configure sessions
          </Button>
        }
      >
        <div className="ja-sessions">
          {s.by.session.map((b) => {
            const def = sessions.find((x) => x.name === b.key || x.name === b.label);
            return (
              <button
                type="button"
                key={b.key}
                className={cx('ja-session', b.n < SMALL_N && 'is-small')}
                onClick={() => drill('session', b)}
              >
                <span className="ja-session-head">
                  <b>{b.label}</b>
                  {def ? (
                    <span className="text-t3 text-(length:--text-meta)">
                      {def.start}–{def.end}
                    </span>
                  ) : null}
                </span>
                <span className={cx('ja-session-v', tone(b.net))}>{formatMoney(b.net, { signed: true })}</span>
                <span className="ja-session-figs">
                  <span>
                    <span className="jk-caps">Trades</span> {b.n}
                  </span>
                  <span>
                    <span className="jk-caps">Win</span> {pct(b.winRate, 0)}
                  </span>
                  <span>
                    <span className="jk-caps">Avg</span> {formatMoney(b.avg, { signed: true })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Panel>
      <Panel chrome="monthly-pnl" title="Monthly P&L" description="Cumulative">
        <AreaChart
          height={220}
          points={months.map((m, i) => ({
            label: m.label,
            value: monthCum[i] ?? 0,
            detail: [`${m.label}: ${formatMoney(m.net, { signed: true })} · ${plural(m.n, 'trade')}`],
          }))}
        />
        <div className="ja-foot">
          <StatRow
            label="Profitable months"
            value={`${String(months.filter((m) => m.net > 0).length)}/${String(months.length)}`}
          />
          <StatRow
            label="Avg month"
            value={formatMoney(months.length ? months.reduce((t, m) => t + m.net, 0) / months.length : 0, {
              signed: true,
            })}
          />
          <StatRow label="Trades a month" value={(months.length ? s.overview.all.n / months.length : 0).toFixed(1)} />
        </div>
      </Panel>
    </div>
  );
}

function RiskTab({ s }: { s: JournalStats }) {
  const o = s.overview;
  const last = s.equity[s.equity.length - 1];
  const peak = s.equity.reduce((m, p) => Math.max(m, p.peak), 0);
  const winRate = o.all.winRate === null ? null : o.all.winRate / 100;
  const edge = winRate === null || o.payoffRatio === null ? null : winRate * o.payoffRatio - (1 - winRate);
  return (
    <div className="ja-stack">
      <MetricGrid>
        <MetricCard
          title="Max drawdown"
          value={formatMoney(-o.maxDrawdown, { signed: true })}
          tone={o.maxDrawdown > 0 ? 'down' : undefined}
          tip={METRIC_TIPS.maxDrawdown}
          description={o.maxDrawdownPct === null ? 'From a peak' : `${pct(o.maxDrawdownPct)} of its peak`}
        />
        <MetricCard
          title="Current DD"
          value={formatMoney(-o.currentDrawdown, { signed: true })}
          tone={o.currentDrawdown > 0 ? 'down' : 'up'}
          tip={METRIC_TIPS.currentDrawdown}
          description={o.currentDrawdown > 0 ? 'Below the peak' : 'At a new high'}
        />
        <MetricCard
          title="Sortino"
          value={o.sortino === null ? '—' : o.sortino.toFixed(2)}
          tip={METRIC_TIPS.sortinoRatio}
          description="Per trade"
        />
        <MetricCard
          title="Calmar"
          value={o.calmar === null ? '—' : o.calmar.toFixed(2)}
          tip={METRIC_TIPS.calmarRatio}
          description="Annualised net / max drawdown"
        />
        <MetricCard
          title="Recovery factor"
          value={o.recoveryFactor === null ? '—' : o.recoveryFactor.toFixed(2)}
          tip={METRIC_TIPS.recoveryFactor}
          description="Net / max drawdown"
        />
        <MetricCard
          title="Ulcer index"
          value={o.ulcerIndex.toFixed(2)}
          tip={METRIC_TIPS.ulcerIndex}
          description="Depth and length of drawdowns"
        />
        <MetricCard title="Drawdowns" value={String(o.drawdowns)} tip={METRIC_TIPS.drawdowns} />
        <MetricCard
          title="Time in DD"
          value={pct(o.timeInDrawdownPct, 0)}
          tip={METRIC_TIPS.timeInDrawdown}
          description="Of trades below a peak"
        />
      </MetricGrid>
      <Panel chrome="equity-curve" title="Equity curve">
        <EquityChart points={s.equity} height={280} onPick={openTrade} />
        <div className="ja-tiles">
          <StatRow
            label="Cumulative P&L"
            value={formatMoney(last?.equity ?? 0, { signed: true })}
            tone={tone(last?.equity)}
          />
          <StatRow label="Peak" value={formatMoney(peak, { signed: true })} />
          <StatRow
            label="Max drawdown"
            value={formatMoney(-o.maxDrawdown, { signed: true })}
            tone={o.maxDrawdown ? 'down' : undefined}
          />
          <StatRow
            label="Status"
            value={o.currentDrawdown > 0 ? 'In drawdown' : 'At peak'}
            tone={o.currentDrawdown > 0 ? 'down' : 'up'}
          />
        </div>
      </Panel>
      <Row>
        <Panel
          chrome="r-multiple-distribution"
          title="R-multiple distribution"
          description={`${plural(o.all.nR, 'trade')} with a planned stop`}
        >
          <BucketBars buckets={s.by.r} metric="n" height={180} tones={s.by.r.map((_, i) => (i < 3 ? 'down' : 'up'))} />
          <div className="ja-foot">
            <StatRow label="Average" value={rLabel(o.all.avgR)} tone={tone(o.all.avgR)} />
            <StatRow label="Winners" value={rLabel(o.avgWinR)} tone="up" />
            <StatRow label="Losers" value={rLabel(o.avgLossR)} tone="down" />
          </div>
        </Panel>
        <Panel chrome="risk-reward" title="Risk / reward" description="As planned at entry">
          <BucketTable buckets={s.by.plannedRr} first="R:R range" />
        </Panel>
      </Row>
      <Row>
        <Panel
          chrome="kelly-criterion"
          title="Kelly criterion"
          description="From the win rate and payoff measured here"
        >
          <div className="ja-kelly">
            <div>
              <span className="jk-caps">Kelly</span>
              <b className={tone(o.kellyPct)}>{o.kellyPct === null ? '—' : `${o.kellyPct.toFixed(1)}%`}</b>
            </div>
            <div>
              <span className="jk-caps">Half Kelly</span>
              <b>{o.kellyPct === null ? '—' : `${(o.kellyPct / 2).toFixed(1)}%`}</b>
            </div>
          </div>
          <StatRow label="Win rate" value={pct(o.all.winRate)} />
          <StatRow label="Payoff ratio" value={o.payoffRatio === null ? '—' : o.payoffRatio.toFixed(2)} />
          <StatRow
            label="Edge per dollar risked"
            value={edge === null ? '—' : `${edge >= 0 ? '+' : ''}${edge.toFixed(2)}`}
            tone={tone(edge)}
          />
          <p className="text-t3 ja-note">
            The share of capital that would grow it fastest if these figures held. They are measured on{' '}
            {plural(o.all.n, 'trade')}; most traders size at half Kelly or less.
          </p>
        </Panel>
        <Panel chrome="position-size" title="Position size">
          <BucketBars buckets={s.by.size} height={200} />
        </Panel>
      </Row>
      <Panel chrome="drawdown-history" title="Drawdown history" description="The ten deepest" flush>
        {s.drawdowns.length ? (
          <Table className="jr-table">
            <THead>
              <tr>
                <Th>#</Th>
                <Th align="right">Amount</Th>
                <Th>Start</Th>
                <Th>Trough</Th>
                <Th align="right">Duration</Th>
                <Th align="right">Recovery</Th>
                <Th align="right">Trades</Th>
                <Th>Status</Th>
              </tr>
            </THead>
            <TBody>
              {s.drawdowns.map((d, i) => (
                <tr key={d.start}>
                  <Td className="t3">{i + 1}</Td>
                  <Td align="right" className="down">
                    {formatMoney(-d.depth, { signed: true })}
                    {d.depthPct !== null ? <span className="text-t3"> · {pct(d.depthPct, 0)}</span> : null}
                  </Td>
                  <Td>{dayLabel(todayIn(s.timezone, nsToMs(d.start)))}</Td>
                  <Td>{dayLabel(todayIn(s.timezone, nsToMs(d.trough)))}</Td>
                  <Td align="right" className="t3">
                    {holdLabel((d.trough - d.start) / 1e9)}
                  </Td>
                  <Td align="right" className="t3">
                    {d.recovered === null ? '—' : holdLabel((d.recovered - d.trough) / 1e9)}
                  </Td>
                  <Td align="right" className="t3">
                    {d.trades}
                  </Td>
                  <Td className={d.recovered === null ? 'down' : 'up'}>
                    {d.recovered === null ? 'Active' : 'Recovered'}
                  </Td>
                </tr>
              ))}
            </TBody>
          </Table>
        ) : (
          <Empty compact icon="trades" title="No drawdown of a dollar or more" />
        )}
      </Panel>
    </div>
  );
}

type SymSort = 'symbol' | 'net' | 'n' | 'winRate' | 'profitFactor' | 'avg';

function SymbolsTab({ s }: { s: JournalStats }) {
  const [sort, setSort] = useState<SymSort>('net');
  const [asc, setAsc] = useState(false);
  const [share, setShare] = useState<'count' | 'pnl'>('count');
  const [trend, setTrend] = useState<'cumulative' | 'monthly'>('cumulative');
  const rows = [...s.by.symbol].sort((a, b) => {
    const k = (x: Bucket) => (sort === 'symbol' ? x.label : (x[sort] ?? -Infinity));
    const va = k(a);
    const vb = k(b);
    const c = typeof va === 'string' ? va.localeCompare(String(vb)) : va - (vb as number);
    return asc ? c : -c;
  });
  const head = (key: SymSort, label: string, align: 'left' | 'right' = 'right') => (
    <Th
      align={align}
      className={cx('is-sortable', sort === key && 'is-sorted')}
      aria-sort={sort === key ? (asc ? 'ascending' : 'descending') : undefined}
      onClick={() => (sort === key ? setAsc(!asc) : (setSort(key), setAsc(key === 'symbol')))}
    >
      {label}
      <span className={cx('jr-sortmark', sort !== key && 'is-idle')}>{sort === key ? (asc ? '↑' : '↓') : '↕'}</span>
    </Th>
  );
  const top = [...s.by.symbol].sort((a, b) => b.n - a.n).slice(0, 8);
  const series = symbolSeries(s.bySymbolMonth, trend, 8);
  return (
    <div className="ja-stack">
      <Panel chrome="symbol-performance" title="Symbol performance" description="Click a row for its trades" flush>
        <Table className="jr-table">
          <THead>
            <tr>
              {head('symbol', 'Symbol', 'left')}
              {head('net', 'P&L')}
              {head('n', 'Trades')}
              {head('winRate', 'Win rate')}
              {head('profitFactor', 'PF')}
              {head('avg', 'Avg trade')}
            </tr>
          </THead>
          <TBody>
            {rows.map((b) => (
              <tr key={b.key} className={cx('is-link', b.n < SMALL_N && 'is-small')} onClick={() => drill('symbol', b)}>
                <Td>
                  <b>{b.label}</b>
                </Td>
                <Td align="right" className={tone(b.net)}>
                  {formatMoney(b.net, { signed: true })}
                </Td>
                <Td align="right">{b.n}</Td>
                <Td align="right">{pct(b.winRate, 0)}</Td>
                <Td align="right">{pf(b)}</Td>
                <Td align="right" className={tone(b.avg)}>
                  {formatMoney(b.avg, { signed: true })}
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      </Panel>
      <Row>
        <Panel
          chrome="symbol-distribution"
          title="Symbol distribution"
          description={share === 'count' ? 'Share of trades' : 'Share of P&L (by size, either sign)'}
          actions={
            <Toggle
              label="Measure"
              value={share}
              onChange={setShare}
              options={[
                { value: 'count', label: 'Count' },
                { value: 'pnl', label: 'P&L' },
              ]}
            />
          }
        >
          <Donut
            empty="Nothing to measure yet."
            segments={top.map((b, i) => ({
              key: b.key,
              label: b.label,
              value: share === 'count' ? b.n : Math.abs(b.net),
              text: share === 'count' ? String(b.n) : formatMoney(b.net, { signed: true }),
              tone: 'palette',
              index: i,
            }))}
          />
        </Panel>
        <Panel
          chrome="symbol-trend"
          title="Symbol trend"
          description={trend === 'cumulative' ? 'Cumulative net by month' : 'Net each month'}
          actions={
            <Toggle
              label="Trend"
              value={trend}
              onChange={setTrend}
              options={[
                { value: 'cumulative', label: 'Cumulative' },
                { value: 'monthly', label: 'Monthly' },
              ]}
            />
          }
        >
          <LinesGraph
            series={series.lines}
            labels={series.months}
            height={220}
            label="Lines by series"
            empty="Nothing to measure yet."
          />
        </Panel>
      </Row>
    </div>
  );
}

function BehaviourTab({ s }: { s: JournalStats }) {
  const o = s.overview;
  const seq = s.sequences;
  const corr = seq.tradesPerDayCorrelation;
  const streak = o.currentStreak;
  const after = [
    { b: seq.afterWin, label: 'After a win' },
    { b: seq.afterLoss, label: 'After a loss' },
    { b: seq.after1Loss, label: 'After 1 loss' },
    { b: seq.after2Losses, label: 'After 2 losses' },
    { b: seq.after3Losses, label: 'After 3+ losses' },
  ];
  return (
    <div className="ja-stack">
      <Row>
        <Panel chrome="streaks" title="Streaks">
          <div className="ja-kelly">
            <div>
              <span className="jk-caps">Current</span>
              <b className={streak > 0 ? 'up' : streak < 0 ? 'down' : undefined}>
                {streak === 0 ? '—' : `${String(Math.abs(streak))}${streak > 0 ? 'W' : 'L'}`}
              </b>
            </div>
            <div>
              <span className="jk-caps">Longest win</span>
              <b className="up">{o.maxWinStreak}</b>
            </div>
            <div>
              <span className="jk-caps">Longest loss</span>
              <b className="down">{o.maxLossStreak}</b>
            </div>
          </div>
          <div className="jr-runs">
            <div>
              <span className="jr-label">Winning runs by length</span>
              <RunBars runs={s.streaks.winRuns} cls="up" />
            </div>
            <div>
              <span className="jr-label">Losing runs by length</span>
              <RunBars runs={s.streaks.lossRuns} cls="down" />
            </div>
          </div>
          <div className="ja-foot">
            <StatRow
              label="Per trade in winning runs"
              value={formatMoney(s.streaks.inWinRuns.avg, { signed: true })}
              tone={tone(s.streaks.inWinRuns.avg)}
            />
            <StatRow
              label="Per trade in losing runs"
              value={formatMoney(s.streaks.inLossRuns.avg, { signed: true })}
              tone={tone(s.streaks.inLossRuns.avg)}
            />
          </div>
        </Panel>
        <Panel
          chrome="after-a-win-after-a-loss"
          title="After a win, after a loss"
          description="The trade that came next, measured"
        >
          <div className="ja-after">
            {after.map(({ b, label }) => (
              <div key={label} className={cx('ja-after-card', b.n < SMALL_N && 'is-small')}>
                <span className="jk-caps">{label}</span>
                <b className={tone(b.avg)}>{b.n ? formatMoney(b.avg, { signed: true }) : '—'}</b>
                <span className="text-t3 text-(length:--text-meta) tabular-nums">
                  {b.n ? `win ${pct(b.winRate, 0)} · n ${String(b.n)}` : 'none yet'}
                </span>
              </div>
            ))}
          </div>
          <p className="text-t3 ja-note">
            Trading worse after losses than after wins is what TheTraderLog called revenge trading; here it is the
            measured difference, read with its n.
          </p>
        </Panel>
      </Row>
      <Row>
        <Panel
          chrome="trades-per-day"
          title="Trades per day"
          description={
            corr === null ? 'Days by how many trades they had' : `Correlation with the day’s net ${corr.toFixed(2)}`
          }
        >
          <BarRows buckets={s.by.tradesPerDay} />
          <BucketTable buckets={s.by.tradesPerDay} first="A day with" />
        </Panel>
        <Panel chrome="holding-time" title="Holding time">
          <BarRows buckets={s.by.hold} />
          <div className="ja-foot">
            <StatRow label="Held, on average" value={holdLabel(o.avgHoldSecs)} />
            <StatRow label="Winners held" value={holdLabel(o.avgHoldWinSecs)} tone="up" />
            <StatRow label="Losers held" value={holdLabel(o.avgHoldLossSecs)} tone="down" />
          </div>
        </Panel>
      </Row>
      <Panel chrome="mood" title="Mood" flush>
        {s.by.emotion.length ? (
          <BucketTable buckets={s.by.emotion} by="emotion" first="Mood" />
        ) : (
          <Empty compact icon="journal" title="No moods marked yet">
            Mark a mood on a trade’s Stats tab to see how each one trades.
          </Empty>
        )}
      </Panel>
    </div>
  );
}

function RunBars({ runs, cls }: { runs: readonly number[]; cls: string }) {
  const max = Math.max(1, ...runs);
  if (!runs.length) return <p className="text-t3 jr-quiet">None yet.</p>;
  return (
    <div className="jr-runbars">
      {runs.map((n, i) => (
        <div key={i} className="jr-runbar" title={`${String(n)} runs of ${String(i + 1)}`}>
          <span className={cx('fill', cls)} style={{ height: `${String((n / max) * 100)}%` }} />
          <span className="l">{i + 1}</span>
        </div>
      ))}
    </div>
  );
}

const GROUPS: readonly { value: keyof Breakdowns; label: string }[] = [
  { value: 'symbol', label: 'Symbol' },
  { value: 'setup', label: 'Setup' },
  { value: 'tag', label: 'Tag' },
  { value: 'account', label: 'Account' },
  { value: 'side', label: 'Side' },
  { value: 'result', label: 'How it ended' },
  { value: 'emotion', label: 'Mood' },
  { value: 'hold', label: 'Time held' },
  { value: 'size', label: 'Size' },
  { value: 'session', label: 'Session' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

function BreakdownTab({ s }: { s: JournalStats }) {
  const groupBy = useJournalUi((x) => x.groupBy) as keyof Breakdowns;
  const [metric, setMetric] = useState<BucketMetric>('net');
  const by = GROUPS.some((g) => g.value === groupBy) ? groupBy : 'symbol';
  const sorted = [...s.by[by]].sort(
    (a, b) => (metricValue(b, metric) ?? -Infinity) - (metricValue(a, metric) ?? -Infinity),
  );
  return (
    <div className="ja-stack">
      <Panel
        chrome="breakdown"
        title="Breakdown"
        description={`Faint rows have fewer than ${String(SMALL_N)} trades: too few to tell an edge from luck.`}
        actions={
          <>
            <Select
              size="s"
              label="Group by"
              value={by}
              onValueChange={(v) => setJournal({ groupBy: v })}
              options={GROUPS}
            />
            <Select size="s" label="Measure" value={metric} onValueChange={(v) => setMetric(v)} options={METRICS} />
          </>
        }
      >
        <BarRows buckets={sorted} metric={metric} onPick={(b) => drill(by, b)} />
      </Panel>
      <Panel chrome="in-numbers" title="In numbers" flush>
        <BucketTable buckets={sorted} by={by} first={GROUPS.find((g) => g.value === by)?.label ?? 'Bucket'} />
      </Panel>
    </div>
  );
}
