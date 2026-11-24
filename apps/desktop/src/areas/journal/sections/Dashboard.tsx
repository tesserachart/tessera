import type {
  Bucket,
  CalendarDay,
  ComplianceOutput,
  DayEntry,
  JournalTrade,
  RecentDay,
  TradeFilter,
} from '@tessera/protocol';
import { Button, IconButton, Loaded, Tooltip, cx, Reveal, formatMoney } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { useHasTool, valueOf, useToolValue } from '../../../app/tools.ts';
import { useNow } from '../../../app/runtimeContext.ts';
import { useCalendar, useCatalog, useJournalAction, useStats, useToday, useTrades } from '../data.ts';
import {
  Badge,
  DirectionChip,
  Empty,
  GridItem,
  PageHead,
  Panel,
  ProgressBar,
  Toggle,
  WidgetGrid,
  type WidgetSize,
} from '../kit/index.ts';
import { addMonths, monthBounds, monthGrid, monthSummary } from '../model/calendar.ts';
import {
  ago,
  checklistShare,
  complianceTone,
  excerpt,
  journalCompletion,
  journalStatus,
  pnlCurve,
  priorDays,
  streakKind,
  topSetups,
  vsAvgDay,
  wordCount,
  type JournalStatus,
} from '../model/dashboard.ts';
import { clock, dayLabel, longDate, monthLabel, pct, plural, tone } from '../model/format.ts';
import { rangeDates } from '../model/scope.ts';
import { Gauge, Spark } from '../parts/Charts.tsx';
import { openDay, openTrade, setJournal, useJournalUi } from '../store.ts';
import {
  SAMPLE_BUCKET,
  SAMPLE_COMPLIANCE,
  SAMPLE_DAY,
  SAMPLE_NOW_MS,
  SAMPLE_RECENT_DAYS,
  SAMPLE_SETUPS,
  SAMPLE_STATS,
  SAMPLE_TRADES,
  sampleCalendar,
} from './samples.ts';
import './dashboard.css';

const ignore = () => undefined;

const WIDGETS: readonly {
  size: WidgetSize;
  Widget: (props: { accounts: TradeFilter }) => ReactNode;
  Sample: () => ReactNode;
}[] = [
  { size: 'md', Widget: TodayWidget, Sample: TodaySample },
  { size: 'sm', Widget: JournalStatusWidget, Sample: JournalStatusSample },
  { size: 'lg', Widget: PnlCalendarWidget, Sample: PnlCalendarSample },
  { size: 'sm', Widget: SnapshotWidget, Sample: SnapshotSample },
  { size: 'sm', Widget: StreakWidget, Sample: StreakSample },
  { size: 'sm', Widget: PlaybooksWidget, Sample: PlaybooksSample },
  { size: 'sm', Widget: ComplianceWidget, Sample: ComplianceSample },
  { size: 'sm', Widget: RecentTradesWidget, Sample: RecentTradesSample },
  { size: 'wide', Widget: ExcerptsWidget, Sample: ExcerptsSample },
];

export function Dashboard() {
  const cat = useCatalog();
  return (
    <Loaded label="Loading the dashboard" pending={cat.isPending} sample={<DashboardSample />}>
      {cat.isPending ? null : cat.data?.trades === 0 ? <EmptyJournal /> : <Widgets />}
    </Loaded>
  );
}

function DashboardPage({ children }: { children: ReactNode }) {
  return (
    <div className="jd-page">
      <PageHead title="Dashboard" />
      <WidgetGrid>{children}</WidgetGrid>
    </div>
  );
}

export function DashboardSample() {
  return (
    <DashboardPage>
      {WIDGETS.map(({ size, Sample }, i) => (
        <GridItem key={i} size={size}>
          <Sample />
        </GridItem>
      ))}
    </DashboardPage>
  );
}

function Widgets() {
  const account = useJournalUi((s) => s.scope.account);
  const accounts: TradeFilter = account === 'all' ? {} : { accounts: [account] };
  return (
    <DashboardPage>
      {WIDGETS.map(({ size, Widget }, i) => (
        <GridItem key={i} size={size}>
          <Widget accounts={accounts} />
        </GridItem>
      ))}
    </DashboardPage>
  );
}

function pf(b: Bucket): string {
  if (b.profitFactor !== null) return b.profitFactor.toFixed(2);
  return b.grossProfit > 0 ? '∞' : '—';
}

function Fig({ label, children, tone: t }: { label: string; children: React.ReactNode; tone?: string | undefined }) {
  return (
    <div className="jd-fig">
      <span className={cx('v', t)}>{children}</span>
      <span className="jk-caps">{label}</span>
    </div>
  );
}

interface TodayView {
  all: Bucket;
  vs: ReturnType<typeof vsAvgDay>;
  trades: readonly JournalTrade[];
}

const SAMPLE_TODAY: TodayView = {
  all: SAMPLE_DAY.stats,
  vs: vsAvgDay(SAMPLE_DAY.stats.net, SAMPLE_STATS.overview),
  trades: SAMPLE_DAY.trades,
};

function TodayWidget({ accounts }: { accounts: TradeFilter }) {
  const today = useToday();
  const day = valueOf(useStats({ ...accounts, from: today, to: today }, true));
  const prior = valueOf(useStats({ ...accounts, ...priorDays(today) }, true));
  const trades = valueOf(useTrades({ ...accounts, from: today, to: today }, 'opened', false, 8));
  const all = day?.overview.all;
  const view: TodayView | null =
    all && trades ? { all, vs: vsAvgDay(all.net, prior?.overview), trades: trades.trades } : null;
  return (
    <Panel chrome="today" onView={() => openDay(today)} viewLabel="Day">
      <Reveal label="Loading today" data={view} sample={SAMPLE_TODAY}>
        {(v) => <TodayBody v={v} />}
      </Reveal>
    </Panel>
  );
}

function TodaySample() {
  return (
    <Panel chrome="today" onView={ignore} viewLabel="Day">
      <TodayBody v={SAMPLE_TODAY} />
    </Panel>
  );
}

function TodayBody({ v: { all: a, vs, trades } }: { v: TodayView }) {
  if (a.n === 0 && !trades.length) return <Empty compact icon="trades" title="No trades today yet" />;
  return (
    <div className="jd-today">
      <div className="jd-today-main">
        <div className="jd-today-top">
          <div>
            <div className={cx('jd-big', tone(a.net))}>{formatMoney(a.net, { signed: true })}</div>
            {vs ? <div className={cx('jd-vs', vs.tone)}>{vs.text}</div> : null}
          </div>
          <Gauge share={a.winRate === null ? null : a.winRate / 100} />
        </div>
        <div className="jd-figs">
          <Fig label="Trades">{a.n}</Fig>
          <Fig label="W/L">
            <span className="up">{a.wins}</span>
            <span className="text-t3">/</span>
            <span className="down">{a.losses}</span>
          </Fig>
          <Fig label="PF" tone={a.profitFactor !== null && a.profitFactor < 1 ? 'down' : 'up'}>
            {pf(a)}
          </Fig>
        </div>
      </div>
      <ol className="jd-rows">
        {trades.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => openTrade(t.id)}>
              <span className="text-t3">{clock(t.openedAt)}</span>
              <b>{t.symbol}</b>
              <DirectionChip side={t.side} size="s" />
              <span className={cx('r', t.status === 'open' ? 'text-t3' : tone(t.netPnl))}>
                {t.status === 'open' ? 'Open' : formatMoney(t.netPnl, { signed: true })}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

const STATUS: Record<JournalStatus, { label: string; tone: string }> = {
  'not-started': { label: 'Not started', tone: 't3' },
  'in-progress': { label: 'In progress', tone: 'brass' },
  completed: { label: 'Completed', tone: 'up' },
};

function JournalStatusWidget() {
  const today = useToday();
  const has = useHasTool('journal.get_day');
  const act = useJournalAction();
  const d = useToolValue('journal.get_day', has ? { date: today } : null, { keepFor: 15_000 });
  const start = (status: JournalStatus) => {
    if (status === 'not-started') void act('journal.save_day', { date: today, start: true });
    openDay(today);
  };
  return (
    <Panel chrome="journal-status" onView={() => openDay(today)}>
      <Reveal label="Loading today's journal" data={d} sample={SAMPLE_DAY}>
        {(d) => <JournalStatusBody d={d} onStart={start} />}
      </Reveal>
    </Panel>
  );
}

function JournalStatusSample() {
  return (
    <Panel chrome="journal-status" onView={ignore}>
      <JournalStatusBody d={SAMPLE_DAY} onStart={ignore} />
    </Panel>
  );
}

function JournalStatusBody({ d, onStart }: { d: DayEntry; onStart: (status: JournalStatus) => void }) {
  const status = journalStatus(d);
  const share = checklistShare(d.checklist);
  const s = STATUS[status];
  return (
    <div className="jd-status">
      <div className="jd-status-top">
        <span className={cx('jd-status-tile', s.tone)}>
          <span className="jk-caps">Today</span>
          <b>{s.label}</b>
        </span>
        <span className="text-t3 jd-status-date">{longDate(d.date)}</span>
      </div>
      {status !== 'not-started' ? (
        <div className="jd-figs">
          <Fig label="Words">{wordCount(d.content)}</Fig>
          <Fig label="Checklist">{share === null ? '—' : pct(share * 100, 0)}</Fig>
          {d.startedAt ? <Fig label="Started">{clock(d.startedAt)}</Fig> : null}
        </div>
      ) : (
        <p className="text-t3 jd-status-hint">Start the day before the open: a plan, the checklist, then the trades.</p>
      )}
      <Button
        className="jd-status-btn"
        variant={status === 'not-started' ? 'primary' : 'secondary'}
        onClick={() => onStart(status)}
      >
        {status === 'not-started' ? 'Start my journal' : status === 'completed' ? 'View journal' : 'Continue journal'}
      </Button>
    </div>
  );
}

interface MonthProps {
  month: string;
  today: string;
  days: readonly CalendarDay[];
  onMonth: (month: string) => void;
}

function PnlCalendarWidget({ accounts }: { accounts: TradeFilter }) {
  const today = useToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const { from, to } = monthBounds(month);
  const cal = valueOf(useCalendar(from, to, accounts));
  return (
    <Panel chrome="pnl-calendar" onView={() => setJournal({ section: 'days', day: null })}>
      <PnlCalendarBody month={month} today={today} days={cal?.days ?? []} onMonth={setMonth} />
    </Panel>
  );
}

function PnlCalendarSample() {
  const today = useToday();
  const month = today.slice(0, 7);
  return (
    <Panel chrome="pnl-calendar" onView={ignore}>
      <PnlCalendarBody month={month} today={today} days={sampleCalendar(month, today).days} onMonth={ignore} />
    </Panel>
  );
}

function PnlCalendarBody({ month, today, days, onMonth }: MonthProps) {
  const weeks = monthGrid(month, days);
  const sum = monthSummary(days, month);
  return (
    <div className="jd-cal">
      <div className="jd-cal-nav">
        <IconButton label="Previous month" icon="chevron-left" onClick={() => onMonth(addMonths(month, -1))} />
        <span>{monthLabel(month)}</span>
        <IconButton
          label="Next month"
          icon="chevron-right"
          disabled={addMonths(month, 1) > today.slice(0, 7)}
          onClick={() => onMonth(addMonths(month, 1))}
        />
      </div>
      <div className="jd-cal-dow">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="jd-cal-grid" style={{ gridTemplateRows: `repeat(${String(weeks.length)}, 1fr)` }}>
        {weeks.flatMap((w) =>
          w.days.map((d) => {
            const s = d.cell?.stats;
            const future = d.date > today;
            return (
              <button
                type="button"
                key={d.date}
                className={cx('jd-cal-day', !d.inMonth && 'is-out', future && 'is-future')}
                disabled={future}
                onClick={() => openDay(d.date)}
                title={dayLabel(d.date)}
              >
                <span className="jd-cal-date">
                  <span className="jk-caps">{monthLabel(d.date.slice(0, 7)).slice(0, 3)}</span>
                  <b>{Number(d.date.slice(8))}</b>
                  {d.date === today ? <span className="jd-today-badge">Today</span> : null}
                  {d.cell?.journaled ? <span className="jd-cal-note" aria-label="Journaled" /> : null}
                </span>
                {s?.n && !future ? (
                  <span className="jd-cal-data">
                    <span className="text-t3 font-fig text-meta normal-nums">{plural(s.n, 'Trade')}</span>
                    <span className={cx('v', tone(s.net))}>{formatMoney(s.net, { signed: true })}</span>
                  </span>
                ) : null}
              </button>
            );
          }),
        )}
      </div>
      <div className="jd-cal-sum">
        <Fig label="P&L" tone={tone(sum.net)}>
          {formatMoney(sum.net, { signed: true })}
        </Fig>
        <Fig label="Days">{sum.traded}</Fig>
        <Fig label="Trades">{sum.n}</Fig>
      </div>
    </div>
  );
}

type Period = 'today' | 'week' | 'month';

function PeriodToggle({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <Toggle<Period>
      label="Period"
      value={value}
      onChange={onChange}
      options={[
        { value: 'today', label: 'Today' },
        { value: 'week', label: 'Week' },
        { value: 'month', label: 'Month' },
      ]}
    />
  );
}

interface SnapshotView {
  all: Bucket;
  curve: readonly number[];
}

const SAMPLE_SNAPSHOT: SnapshotView = { all: SAMPLE_BUCKET, curve: pnlCurve(SAMPLE_TRADES) };

function SnapshotWidget({ accounts }: { accounts: TradeFilter }) {
  const today = useToday();
  const [period, setPeriod] = useState<Period>('week');
  const dates = period === 'today' ? { from: today, to: today } : rangeDates(period, today);
  const filter: TradeFilter = {
    ...accounts,
    ...(dates.from ? { from: dates.from } : {}),
    ...(dates.to ? { to: dates.to } : {}),
  };
  const stats = valueOf(useStats(filter, true));
  const last = valueOf(useTrades({ ...filter, status: 'closed' }, 'closed', false, 20));
  const all = stats?.overview.all;
  const view: SnapshotView | null = all && last ? { all, curve: pnlCurve(last.trades) } : null;
  return (
    <Panel
      chrome="analytics-snapshot"
      onView={() => setJournal({ section: 'reports' })}
      actions={<PeriodToggle value={period} onChange={setPeriod} />}
    >
      <Reveal label="Loading the period's stats" data={view} sample={SAMPLE_SNAPSHOT}>
        {(v) => <SnapshotBody v={v} />}
      </Reveal>
    </Panel>
  );
}

function SnapshotSample() {
  return (
    <Panel chrome="analytics-snapshot" onView={ignore} actions={<PeriodToggle value="week" onChange={ignore} />}>
      <SnapshotBody v={SAMPLE_SNAPSHOT} />
    </Panel>
  );
}

function SnapshotBody({ v: { all: a, curve } }: { v: SnapshotView }) {
  if (a.n === 0) return <Empty compact icon="trades" title="No closed trades in this period" />;
  return (
    <div className="jd-snap">
      <div className="jd-snap-top">
        <Gauge share={a.winRate === null ? null : a.winRate / 100} size={64} />
        <div className="jd-snap-grid">
          <Fig label="PF" tone={a.profitFactor !== null && a.profitFactor < 1 ? 'down' : undefined}>
            {pf(a)}
          </Fig>
          <Fig label="Exp." tone={tone(a.expectancy)}>
            {formatMoney(a.expectancy, { signed: true })}
          </Fig>
          <Fig label="Trades">{a.n}</Fig>
          <Fig label="W/L">
            <span className="up">{a.wins}</span>
            <span className="text-t3">/</span>
            <span className="down">{a.losses}</span>
          </Fig>
        </div>
      </div>
      <div className="jd-snap-foot">
        <div>
          <span className="jk-caps">Total P&L</span>
          <div className={cx('jd-mid', tone(a.net))}>{formatMoney(a.net, { signed: true })}</div>
        </div>
        <Spark values={curve} width={112} height={32} />
      </div>
    </div>
  );
}

function StreakWidget({ accounts }: { accounts: TradeFilter }) {
  const today = useToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const { from, to } = monthBounds(month);
  const cal = valueOf(useCalendar(from, to, accounts));
  return (
    <Panel chrome="journal-streak" onView={() => setJournal({ section: 'days', day: null })}>
      <StreakBody
        month={month}
        today={today}
        days={cal?.days ?? []}
        streak={cal?.journalStreak ?? 0}
        onMonth={setMonth}
      />
    </Panel>
  );
}

function StreakSample() {
  const today = useToday();
  const month = today.slice(0, 7);
  const cal = sampleCalendar(month, today);
  return (
    <Panel chrome="journal-streak" onView={ignore}>
      <StreakBody month={month} today={today} days={cal.days} streak={cal.journalStreak} onMonth={ignore} />
    </Panel>
  );
}

function StreakBody({ month, today, days, streak, onMonth }: MonthProps & { streak: number }) {
  const weeks = monthGrid(month, days);
  const done = journalCompletion(days, today);
  return (
    <div className="jd-streak">
      <div className="jd-figs">
        <Fig label="Day streak" tone="up">
          {streak}
        </Fig>
        <Fig label="Journaled">
          {done.done}
          <span className="text-t3">/{done.total}</span>
        </Fig>
      </div>
      <div className="jd-streak-nav">
        <IconButton
          className="jd-tool-s"
          label="Previous month"
          icon="chevron-left"
          onClick={() => onMonth(addMonths(month, -1))}
        />
        <span className="text-t3">{monthLabel(month)}</span>
        <IconButton
          className="jd-tool-s"
          label="Next month"
          icon="chevron-right"
          disabled={addMonths(month, 1) > today.slice(0, 7)}
          onClick={() => onMonth(addMonths(month, 1))}
        />
      </div>
      <div className="jd-streak-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="dow">
            {d}
          </span>
        ))}
        {weeks.flatMap((w) =>
          w.days.map((d) => (
            <StreakDay key={d.date} date={d.date} cell={d.cell} out={!d.inMonth} future={d.date > today} />
          )),
        )}
      </div>
      <div className="jd-legend">
        <span>
          <i className="journaled" /> Journaled
        </span>
        <span>
          <i className="missed" /> Not journaled
        </span>
        <span>
          <i className="none" /> No trades
        </span>
      </div>
    </div>
  );
}

function StreakDay({
  date,
  cell,
  out,
  future,
}: {
  date: string;
  cell: CalendarDay | null;
  out: boolean;
  future: boolean;
}) {
  const kind = streakKind(cell ?? undefined);
  return (
    <Tooltip
      content={
        cell?.stats.n ? (
          <span>
            {dayLabel(date)} · {plural(cell.stats.n, 'trade')} · {formatMoney(cell.stats.net, { signed: true })} ·{' '}
            {cell.journaled ? 'Journaled' : 'Not journaled'}
          </span>
        ) : (
          `${dayLabel(date)} · No trades`
        )
      }
    >
      <button
        type="button"
        className={cx('jd-sday', kind, out && 'is-out', future && 'is-future')}
        disabled={future}
        onClick={() => openDay(date)}
      >
        {Number(date.slice(8))}
      </button>
    </Tooltip>
  );
}

type TopSetups = ReturnType<typeof topSetups>;

const SAMPLE_TOP_SETUPS = topSetups(SAMPLE_SETUPS);

function PlaybooksWidget() {
  const cat = valueOf(useCatalog());
  return (
    <Panel chrome="playbooks" onView={() => setJournal({ section: 'playbooks' })}>
      <Reveal label="Loading the top setups" data={cat ? topSetups(cat.setups) : null} sample={SAMPLE_TOP_SETUPS}>
        {(v) => <TopSetupsBody v={v} />}
      </Reveal>
    </Panel>
  );
}

function PlaybooksSample() {
  return (
    <Panel chrome="playbooks" onView={ignore}>
      <TopSetupsBody v={SAMPLE_TOP_SETUPS} />
    </Panel>
  );
}

function TopSetupsBody({ v: { top, more } }: { v: TopSetups }) {
  if (!top.length)
    return (
      <Empty compact icon="journal" title="No setups with trades yet">
        Give trades a setup to see which one pays.
      </Empty>
    );
  return (
    <ol className="jd-list">
      {top.map((s, i) => (
        <li key={s.id}>
          <button type="button" onClick={() => setJournal({ section: 'playbooks', setup: s.id })}>
            <span className={cx('jd-rank', i === 0 && 'is-first')}>{i + 1}</span>
            <i className="jd-dot" style={{ background: s.color }} />
            <span className="nm">{s.name}</span>
            <span className="text-t3">{plural(s.stats.n, 'trade')}</span>
            <span className={cx('r', tone(s.stats.net))}>{formatMoney(s.stats.net, { signed: true })}</span>
          </button>
        </li>
      ))}
      {more ? <li className="text-t3 jd-more">+{more} more</li> : null}
    </ol>
  );
}

interface RecentView {
  trades: readonly JournalTrade[];
  day: Bucket | null;
  now: number;
}

const SAMPLE_RECENT: RecentView = { trades: SAMPLE_TRADES.slice(0, 5), day: SAMPLE_DAY.stats, now: SAMPLE_NOW_MS };

function RecentTradesWidget({ accounts }: { accounts: TradeFilter }) {
  const today = useToday();
  const now = useNow();
  const recent = valueOf(useTrades(accounts, 'opened', false, 5));
  const day = valueOf(useStats({ ...accounts, from: today, to: today }, true));
  const view: RecentView | null = recent ? { trades: recent.trades, day: day?.overview.all ?? null, now } : null;
  return (
    <Panel chrome="recent-trades" onView={() => setJournal({ section: 'trades', trade: null })}>
      <Reveal label="Loading the recent trades" data={view} sample={SAMPLE_RECENT}>
        {(v) => <RecentTradesBody v={v} />}
      </Reveal>
    </Panel>
  );
}

function RecentTradesSample() {
  return (
    <Panel chrome="recent-trades" onView={ignore}>
      <RecentTradesBody v={SAMPLE_RECENT} />
    </Panel>
  );
}

function RecentTradesBody({ v: { trades, day, now } }: { v: RecentView }) {
  if (!trades.length) return <Empty compact icon="trades" title="No trades yet" />;
  return (
    <div className="jd-recent">
      <ol className="jd-list">
        {trades.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => openTrade(t.id)}>
              <span className={cx('jd-arrow', t.side === 'buy' ? 'up' : 'down')}>{t.side === 'buy' ? '↑' : '↓'}</span>
              <span className="nm">{t.symbol}</span>
              <span className="text-t3">{ago(t.openedAt, now)}</span>
              <span className={cx('r', t.status === 'open' ? 'text-t3' : tone(t.netPnl))}>
                {t.status === 'open' ? 'Open' : formatMoney(t.netPnl, { signed: true })}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="jd-recent-foot">
        <span className="jk-caps">Today</span>
        <span className="text-t3">{plural(day?.n ?? 0, 'trade')}</span>
        <span className={cx('r', tone(day?.net))}>{formatMoney(day?.net ?? 0, { signed: true })}</span>
      </div>
    </div>
  );
}

const CATEGORIES = [
  { key: 'entry', label: 'Entry' },
  { key: 'exit', label: 'Exit' },
  { key: 'risk', label: 'Risk' },
  { key: 'management', label: 'Manage' },
] as const;

function ComplianceWidget({ accounts }: { accounts: TradeFilter }) {
  const today = useToday();
  const has = useHasTool('journal.get_compliance');
  const c = useToolValue(
    'journal.get_compliance',
    has ? { filter: { ...accounts, from: rangeDates('30d', today).from ?? today } } : null,
    { keepPrevious: true },
  );
  return (
    <Panel chrome="rule-compliance" onView={() => setJournal({ section: 'playbooks' })}>
      <Reveal label="Loading rule compliance" data={c} sample={SAMPLE_COMPLIANCE}>
        {(c) => <ComplianceBody c={c} />}
      </Reveal>
    </Panel>
  );
}

function ComplianceSample() {
  return (
    <Panel chrome="rule-compliance" onView={ignore}>
      <ComplianceBody c={SAMPLE_COMPLIANCE} />
    </Panel>
  );
}

function ComplianceBody({ c }: { c: ComplianceOutput }) {
  if (c.tradesWithSetups === 0)
    return (
      <Empty compact icon="done" title="No rules followed yet">
        Give a setup rules and tick them on its trades to see how closely you follow them.
      </Empty>
    );
  return (
    <div className="jd-comp">
      <div className="jd-comp-top">
        <Gauge share={c.overall} size={64} tone={complianceTone(c.overall)} />
        <div>
          <span className="jk-caps">Last 30 days</span>
          <div className="text-t3 jd-comp-n">{plural(c.tradesWithSetups, 'trade')} tracked</div>
        </div>
      </div>
      <div className="jd-comp-cats">
        {CATEGORIES.map((k) => {
          const v = c.byCategory[k.key];
          return (
            <div key={k.key} className="jd-comp-cat">
              <span className="jk-caps">{k.label}</span>
              <ProgressBar value={v} tone={complianceTone(v)} label={`${k.label} rules followed`} />
              <span className="text-t3 text-right">{v === null ? '—' : pct(v * 100, 0)}</span>
            </div>
          );
        })}
      </div>
      {c.missed.length ? (
        <div className="jd-comp-missed">
          <span className="jk-caps">Most missed</span>
          {c.missed.slice(0, 3).map((m) => (
            <div key={`${m.setupId}-${m.ruleId}`} className="jd-comp-rule" title={m.setupName}>
              <span className="down">{m.ruleName}</span>
              <span className="text-t3">×{m.count}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ExcerptsWidget({ accounts }: { accounts: TradeFilter }) {
  const has = useHasTool('journal.recent_days');
  const q = useToolValue(
    'journal.recent_days',
    has ? { limit: 3, ...(accounts.accounts ? { accounts: accounts.accounts } : {}) } : null,
    { keepPrevious: true },
  );
  return (
    <Panel chrome="journal-excerpts" onView={() => setJournal({ section: 'days', day: null })}>
      <Reveal label="Loading journal excerpts" data={q} sample={SAMPLE_RECENT_DAYS}>
        {(q) => <ExcerptsBody days={q.days} />}
      </Reveal>
    </Panel>
  );
}

function ExcerptsSample() {
  return (
    <Panel chrome="journal-excerpts" onView={ignore}>
      <ExcerptsBody days={SAMPLE_RECENT_DAYS.days} />
    </Panel>
  );
}

function ExcerptsBody({ days }: { days: readonly RecentDay[] }) {
  if (!days.length)
    return (
      <Empty compact icon="journal" title="No journal entries yet">
        Write a few lines after each session: what you planned, what you did, what you saw.
      </Empty>
    );
  return (
    <div className="jd-excerpts">
      {days.map((d) => (
        <button type="button" key={d.date} className="jd-excerpt" onClick={() => openDay(d.date)}>
          <span className="jd-excerpt-head">
            <b>{dayLabel(d.date)}</b>
            {d.netPnl !== null ? (
              <Badge tone={d.netPnl > 0 ? 'profit' : d.netPnl < 0 ? 'loss' : 'outline'}>
                {formatMoney(d.netPnl, { signed: true })}
              </Badge>
            ) : null}
          </span>
          <span className="jd-excerpt-text">{excerpt(d.content, 220)}</span>
          <span className="jd-excerpt-more">Read more →</span>
        </button>
      ))}
    </div>
  );
}

function EmptyJournal() {
  return (
    <div className="jd-page">
      <PageHead title="Dashboard" />
      <p className="jd-empty">No trades yet. Import trades or connect an account to begin.</p>
    </div>
  );
}
