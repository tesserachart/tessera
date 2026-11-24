import type { CalendarDay } from '@tessera/protocol';
import { IconButton, SampleSkeleton, cx, formatMoney } from '@tessera/ui';
import {
  addMonths,
  intensity,
  maxAbsNet,
  monthGrid,
  monthSummary,
  yearColumns,
  type GridDay,
} from '../model/calendar.ts';
import { dayLabel, monthLabel, pct, plural } from '../model/format.ts';
import { sampleDays } from '../sections/samples.ts';

export function MonthCalendar({
  month,
  days,
  onMonth,
  onDay,
  selected,
  today,
  compact = false,
}: {
  month: string;
  days: readonly CalendarDay[];
  onMonth: (month: string) => void;
  onDay: (date: string) => void;
  selected?: string | null;
  today: string;
  compact?: boolean;
}) {
  const weeks = monthGrid(month, days);
  const max = maxAbsNet(days);
  const total = monthSummary(days, month);
  return (
    <div className={cx('jr-cal', compact && 'is-compact')}>
      <div className="jr-cal-head">
        <IconButton label="Previous month" icon="chevron-left" onClick={() => onMonth(addMonths(month, -1))} />
        <span className="jr-cal-month">{monthLabel(month)}</span>
        <IconButton
          label="Next month"
          icon="chevron-right"
          disabled={addMonths(month, 1) > today.slice(0, 7)}
          onClick={() => onMonth(addMonths(month, 1))}
        />
        {!compact ? (
          <span className="jr-cal-total">
            <span className={total.net > 0 ? 'up' : total.net < 0 ? 'down' : undefined}>
              {formatMoney(total.net, { signed: true })}
            </span>
            <span className="text-t3">
              {plural(total.n, 'trade')} · {plural(total.traded, 'day')}
            </span>
          </span>
        ) : null}
      </div>
      <div className="jr-cal-grid" role="grid" aria-label={monthLabel(month)}>
        <div className="jr-cal-row jr-cal-dow" role="row">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <span key={d} role="columnheader">
              {compact ? d.charAt(0) : d}
            </span>
          ))}
          {!compact ? <span role="columnheader">Week</span> : null}
        </div>
        {weeks.map((w) => (
          <div className="jr-cal-row" role="row" key={w.start}>
            {w.days.map((d) => {
              const s = d.cell?.stats;
              const net = s?.n ? s.net : 0;
              const level = intensity(net, max);
              return (
                <button
                  type="button"
                  role="gridcell"
                  key={d.date}
                  className={cx(
                    'jr-day',
                    !d.inMonth && 'is-out',
                    d.date === selected && 'is-on',
                    d.date === today && 'is-today',
                    s?.n ? (net > 0 ? 'is-up' : net < 0 ? 'is-down' : 'is-flat') : null,
                  )}
                  data-level={level || undefined}
                  disabled={d.date > today}
                  onClick={() => onDay(d.date)}
                  title={
                    s?.n
                      ? `${dayLabel(d.date)}: ${formatMoney(net, { signed: true })} · ${plural(s.n, 'trade')} · win rate ${pct(s.winRate, 0)}`
                      : dayLabel(d.date)
                  }
                >
                  <span className="d">{Number(d.date.slice(8))}</span>
                  {d.cell?.journaled ? <span className="jr-note-mark" aria-label="Journaled" /> : null}
                  {!compact && s?.n ? (
                    <>
                      <span className="v">{formatMoney(net, { signed: true, compact: true })}</span>
                      <span className="m">
                        {s.n} · {s.winRate === null ? '—' : `${s.winRate.toFixed(0)}%`}
                      </span>
                    </>
                  ) : null}
                </button>
              );
            })}
            {!compact ? (
              <span className="jr-week" role="gridcell">
                {w.traded ? (
                  <>
                    <span className={w.net > 0 ? 'up' : w.net < 0 ? 'down' : undefined}>
                      {formatMoney(w.net, { signed: true, compact: true })}
                    </span>
                    <span className="m">{plural(w.traded, 'day')}</span>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function YearHeat({
  days,
  end,
  onDay,
}: {
  days: readonly CalendarDay[] | null;
  end: string;
  onDay: (date: string) => void;
}) {
  const cols = yearColumns(end);
  if (!days)
    return (
      <SampleSkeleton label="Loading the year">
        <YearGrid cols={cols} days={sampleDays(cols[0]?.[0]?.date ?? end, end)} onDay={onDay} />
      </SampleSkeleton>
    );
  return <YearGrid cols={cols} days={days} onDay={onDay} />;
}

function YearGrid({
  cols,
  days,
  onDay,
}: {
  cols: readonly GridDay[][];
  days: readonly CalendarDay[];
  onDay: (date: string) => void;
}) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const max = maxAbsNet(days);
  return (
    <div className="jr-year" role="img" aria-label="P&L by day over the last year">
      {cols.map((col) => (
        <div className="jr-year-col" key={col[0]?.date}>
          {col.map((d) => {
            const c = byDate.get(d.date);
            const net = c?.stats.n ? c.stats.net : 0;
            return (
              <button
                type="button"
                key={d.date}
                className={cx(
                  'jr-year-day',
                  c?.stats.n ? (net >= 0 ? 'is-up' : 'is-down') : null,
                  !d.inMonth && 'is-out',
                )}
                data-level={intensity(net, max) || undefined}
                disabled={!c?.stats.n}
                title={
                  c?.stats.n
                    ? `${dayLabel(d.date)}: ${formatMoney(net, { signed: true })} · ${plural(c.stats.n, 'trade')}`
                    : dayLabel(d.date)
                }
                onClick={() => onDay(d.date)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
