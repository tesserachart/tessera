import type { Bucket, CalendarOutput, ChecklistState, DayEntry as DayEntryT, JournalTrade } from '@tessera/protocol';
import {
  Button,
  Check,
  IconButton,
  Loaded,
  SampleSkeleton,
  ScrollArea,
  Splitter,
  TextInput,
  Tooltip,
  cx,
  Reveal,
  formatMoney,
} from '@tessera/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useHasTool, useTool, valueOf, useToolValue } from '../../../app/tools.ts';
import { askAboutDay } from '../actions.ts';
import { useCalendar, useJournalAction, useToday } from '../data.ts';
import { Empty, PageHead, ProgressBar, Section, StatRow } from '../kit/index.ts';
import { monthBounds } from '../model/calendar.ts';
import { checklistShare, journalCompletion } from '../model/dashboard.ts';
import { clock, longDate, pct, plural, rLabel, tone } from '../model/format.ts';
import { MonthCalendar } from '../parts/Calendar.tsx';
import { ChecklistSettings } from '../parts/ChecklistSettings.tsx';
import { Filmstrip } from '../parts/Common.tsx';
import { fileBase64, useSplitWidth } from '../parts/hooks.ts';
import { EditorSample, RichEditor } from '../parts/RichEditor.tsx';
import { useArea } from '../../store.ts';
import { openDay, openTrade, useJournalUi } from '../store.ts';
import { SAMPLE_DAY, SAMPLE_NOTE_LINES, sampleCalendar } from './samples.ts';
import './days.css';

const ignore = () => undefined;
const ignoreFile = () => Promise.resolve();

export function Days() {
  return (
    <Loaded label="Loading the day" sample={<DaysSample />}>
      <DaysBody />
    </Loaded>
  );
}

function DaysBody() {
  const today = useToday();
  const day = useJournalUi((s) => s.day) ?? today;
  const [month, setMonth] = useState(day.slice(0, 7));
  const [seenDay, setSeenDay] = useState(day);
  if (day !== seenDay) {
    setSeenDay(day);
    setMonth(day.slice(0, 7));
  }
  const { from, to } = monthBounds(month);
  const cal = valueOf(useCalendar(from, to, {}));
  const has = useHasTool('journal.get_day');
  const q = useToolValue('journal.get_day', has ? { date: day } : null, { keepFor: 15_000, keepPrevious: true });
  const d = q?.date === day ? q : null;
  return (
    <DaysLayout
      head={<DayHead date={day} today={today} d={d} />}
      side={
        <>
          <Section title="Search">
            <Search />
          </Section>
          <CalendarSection month={month} today={today} selected={day} cal={cal ?? null} onMonth={setMonth} />
          <DayChecklist date={day} d={d} />
          <Section title="Trades">
            <Reveal label="Loading the day's trades" data={d} sample={SAMPLE_DAY}>
              {(d) => <DayTradesBody trades={d.trades} />}
            </Reveal>
          </Section>
        </>
      }
      entry={<DayEntry date={day} today={today} d={d} />}
    />
  );
}

export function DaysSample() {
  const today = useToday();
  const month = today.slice(0, 7);
  const d: DayEntryT = { ...SAMPLE_DAY, date: today };
  return (
    <DaysLayout
      head={<DayHead date={today} today={today} d={d} />}
      side={
        <>
          <Section title="Search">
            <div className="jr-search-box">
              <SearchInput value="" onChange={ignore} />
            </div>
          </Section>
          <CalendarSection
            month={month}
            today={today}
            selected={today}
            cal={sampleCalendar(month, today)}
            onMonth={ignore}
          />
          <ChecklistSection share={checklistShare(d.checklist)} onEdit={ignore}>
            <ChecklistBody items={d.checklist} onCheck={ignore} onEdit={ignore} />
          </ChecklistSection>
          <Section title="Trades">
            <DayTradesBody trades={d.trades} />
          </Section>
        </>
      }
      entry={
        <DayEntryFrame s={d.stats}>
          <EditorSample lines={SAMPLE_NOTE_LINES} minHeight={360} />
          <Section title="Screenshots">
            <Filmstrip items={d.attachments} onAdd={ignoreFile} onRemove={ignore} />
          </Section>
        </DayEntryFrame>
      }
    />
  );
}

function DaysLayout({ head, side, entry }: { head: ReactNode; side: ReactNode; entry: ReactNode }) {
  const split = useSplitWidth('tessera.journal.daysPanel', 320, 260, 520);
  return (
    <div className="jy-page">
      {head}
      <div className="jy-body">
        <aside className="jy-side" style={{ width: split.width }}>
          <ScrollArea className="jt-scroll">
            <div className="jy-side-pad">{side}</div>
          </ScrollArea>
        </aside>
        <Splitter label="Resize the journal's side panel" className="jt-split" {...split.splitter} />
        {entry}
      </div>
    </div>
  );
}

function CalendarSection({
  month,
  today,
  selected,
  cal,
  onMonth,
}: {
  month: string;
  today: string;
  selected: string;
  cal: CalendarOutput | null;
  onMonth: (month: string) => void;
}) {
  const days = cal?.days ?? [];
  const done = journalCompletion(days, today);
  return (
    <Section title="Calendar">
      <MonthCalendar
        month={month}
        days={days}
        onMonth={onMonth}
        onDay={(x) => openDay(x)}
        selected={selected}
        today={today}
        compact
      />
      <div className="jy-legend">
        <span>
          <i className="up" /> Profit
        </span>
        <span>
          <i className="down" /> Loss
        </span>
        <span>
          <i className="note" /> Journaled
        </span>
      </div>
      <StatRow label="Journaling streak" value={plural(cal?.journalStreak ?? 0, 'day')} />
      <StatRow
        label="Journaled this month"
        value={
          done.total ? `${String(done.done)}/${String(done.total)} · ${pct((done.done / done.total) * 100, 0)}` : '—'
        }
      />
    </Section>
  );
}

function DayHead({ date, today, d }: { date: string; today: string; d: DayEntryT | null }) {
  const act = useJournalAction();
  const s = d?.stats;
  const shown = useArea((a) => a.area === 'journal');
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft' && d?.prev) openDay(d.prev);
      else if (e.key === 'ArrowRight' && d?.next) openDay(d.next);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, d?.prev, d?.next]);
  return (
    <PageHead title={longDate(date)}>
      {date === today && d && !d.startedAt ? (
        <Button variant="primary" size="s" onClick={() => void act('journal.save_day', { date, start: true })}>
          Start my journal
        </Button>
      ) : d?.startedAt ? (
        <span className="jy-started">Journal started {clock(d.startedAt)}</span>
      ) : null}
      <span className="jy-nav">
        <Tooltip content="Day before" shortcut="←">
          <IconButton
            label="Day before"
            icon="chevron-left"
            disabled={!d?.prev}
            onClick={() => d?.prev && openDay(d.prev)}
          />
        </Tooltip>
        <Button size="s" variant="quiet" disabled={date === today} onClick={() => openDay(today)}>
          Today
        </Button>
        <Tooltip content="Day after" shortcut="→">
          <IconButton
            label="Day after"
            icon="chevron-right"
            disabled={!d?.next}
            onClick={() => d?.next && openDay(d.next)}
          />
        </Tooltip>
      </span>
      <Button size="s" className="text-aqua" onClick={() => askAboutDay(date, s?.n ?? 0, s?.net ?? 0)}>
        Ask the analyst
      </Button>
    </PageHead>
  );
}

function DayChecklist({ date, d }: { date: string; d: DayEntryT | null }) {
  const act = useJournalAction();
  const [editing, setEditing] = useState(false);
  const edit = () => setEditing(true);
  const check = (ruleId: string, checked: boolean) =>
    void act('journal.save_day', { date, checks: [{ ruleId, checked }] });
  return (
    <ChecklistSection share={d ? checklistShare(d.checklist) : null} onEdit={edit}>
      <Reveal label="Loading the day's checklist" data={d} sample={SAMPLE_DAY}>
        {(d) => <ChecklistBody items={d.checklist} onCheck={check} onEdit={edit} />}
      </Reveal>
      <ChecklistSettings open={editing} onOpenChange={setEditing} />
    </ChecklistSection>
  );
}

function ChecklistSection({
  share,
  onEdit,
  children,
}: {
  share: number | null;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <Section
      title="Checklist"
      actions={
        <>
          {share !== null ? <span className="text-t3 jy-pct">{pct(share * 100, 0)}</span> : null}
          <Tooltip content="Checklist settings">
            <IconButton label="Checklist settings" icon="settings" className="jd-tool-s" onClick={onEdit} />
          </Tooltip>
        </>
      }
    >
      {children}
    </Section>
  );
}

function ChecklistBody({
  items,
  onCheck,
  onEdit,
}: {
  items: readonly ChecklistState[];
  onCheck: (ruleId: string, checked: boolean) => void;
  onEdit: () => void;
}) {
  const share = checklistShare(items);
  if (!items.length)
    return (
      <Empty
        compact
        icon="done"
        title="No checklist yet"
        actions={
          <Button size="s" onClick={onEdit}>
            Add items
          </Button>
        }
      >
        A few things to tick before the open.
      </Empty>
    );
  return (
    <>
      <ProgressBar value={share} tone={share === 1 ? 'up' : 'mist'} label="Checklist done" />
      <div className="jy-checks">
        {items.map((c) => (
          <Check key={c.id} checked={c.checked} onChange={(on) => onCheck(c.id, on)}>
            <span className={cx(c.checked && 'jy-done')}>{c.text}</span>
          </Check>
        ))}
      </div>
    </>
  );
}

function DayTradesBody({ trades }: { trades: readonly JournalTrade[] }) {
  if (!trades.length) return <p className="text-t3 jr-quiet">No trades on this day.</p>;
  const net = trades.reduce((a, t) => a + (t.status === 'closed' ? t.netPnl : 0), 0);
  return (
    <>
      <ol className="jd-list jy-trades">
        {trades.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => openTrade(t.id)}>
              <span className={cx('jd-arrow', t.side === 'buy' ? 'up' : 'down')}>{t.side === 'buy' ? '↑' : '↓'}</span>
              <span className="nm">{t.symbol}</span>
              <span className="text-t3">{clock(t.openedAt)}</span>
              <span className={cx('r', t.status === 'open' ? 'text-t3' : tone(t.netPnl))}>
                {t.status === 'open' ? 'Open' : formatMoney(t.netPnl, { signed: true })}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <StatRow label="Total P&L" value={formatMoney(net, { signed: true })} tone={tone(net)} />
    </>
  );
}

function DayEntry({ date, today, d }: { date: string; today: string; d: DayEntryT | null }) {
  const act = useJournalAction();
  const attach = async (f: File) => {
    const dataBase64 = await fileBase64(f);
    return act('journal.add_attachment', { date, filename: f.name, mediaType: f.type || 'image/png', dataBase64 });
  };
  return (
    <DayEntryFrame s={d?.stats}>
      {d ? (
        <RichEditor
          key={date}
          value={d.content}
          placeholder={
            date === today
              ? 'Plan the session: levels, conditions, what you will and will not trade.'
              : 'How did the day go?'
          }
          onSave={(content) => act('journal.save_day', { date, content })}
          onAttach={attach}
          minHeight={360}
        />
      ) : (
        <SampleSkeleton label="Loading the journal entry">
          <EditorSample lines={SAMPLE_NOTE_LINES} minHeight={360} />
        </SampleSkeleton>
      )}
      <Section title="Screenshots">
        {d ? (
          <Filmstrip
            items={d.attachments}
            onAdd={attach}
            onRemove={(id) => void act('journal.delete_attachment', { id })}
          />
        ) : (
          <SampleSkeleton label="Loading the screenshots">
            <Filmstrip items={[]} onAdd={ignoreFile} onRemove={ignore} />
          </SampleSkeleton>
        )}
      </Section>
    </DayEntryFrame>
  );
}

function DayEntryFrame({ s, children }: { s: Bucket | undefined; children: ReactNode }) {
  return (
    <div className="jy-main">
      <ScrollArea className="jt-scroll">
        <div className="jy-main-pad">
          <div className="jy-entry-head">
            <span className="jk-caps">Journal entry</span>
            {s?.n ? (
              <span className="jy-figs">
                <span>
                  Net <b className={cx(tone(s.net))}>{formatMoney(s.net, { signed: true })}</b>
                </span>
                <span>
                  {plural(s.n, 'trade')}{' '}
                  <b>
                    {String(s.wins)}W {String(s.losses)}L
                  </b>
                </span>
                <span>
                  Win rate <b>{pct(s.winRate, 0)}</b>
                </span>
                <span>
                  PF <b>{s.profitFactor === null ? (s.grossProfit > 0 ? '∞' : '—') : s.profitFactor.toFixed(2)}</b>
                </span>
                {s.totalR !== null ? (
                  <span>
                    R <b className={cx(tone(s.totalR))}>{rLabel(s.totalR)}</b>
                  </span>
                ) : null}
                <span>
                  Fees <b>{formatMoney(-s.fees, { signed: true })}</b>
                </span>
              </span>
            ) : null}
          </div>
          {children}
        </div>
      </ScrollArea>
    </div>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <TextInput
      size="s"
      value={value}
      placeholder="Search your journal…"
      aria-label="Search the journal"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Search() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(id);
  }, [q]);
  const has = useHasTool('journal.search');
  const res = useTool('journal.search', has && query.length >= 2 ? { query, limit: 12 } : null);
  const hits = valueOf(res)?.hits;
  return (
    <div className="jr-search-box">
      <SearchInput value={q} onChange={setQ} />
      {query.length >= 2 ? (
        <ol className="jr-hits">
          {(hits ?? []).map((h) => (
            <li key={`${h.kind}-${h.id}`}>
              <button type="button" onClick={() => (h.kind === 'day' ? openDay(h.id) : openTrade(h.id))}>
                <span className="jr-hit-t">{h.title}</span>
                <span className="text-t3">{h.snippet}</span>
              </button>
            </li>
          ))}
          {hits?.length === 0 ? <li className="text-t3">Nothing found.</li> : null}
        </ol>
      ) : null}
    </div>
  );
}
