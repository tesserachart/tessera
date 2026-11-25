import type { JournalCatalog, TradeDetail as Detail, UpdateTradeInput } from '@tessera/protocol';
import {
  Button,
  Check,
  Icon,
  IconButton,
  Loaded,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  ScrollArea,
  SampleSkeleton,
  Segmented,
  Select,
  Splitter,
  Switch,
  TextInput,
  Tooltip,
  cx,
  formatPrice,
  formatMoney,
} from '@tessera/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useHasTool, useTool, useToolValue, valueOf } from '../../../app/tools.ts';
import { askAboutTrade, openOnChart } from '../actions.ts';
import { useCatalog, useJournalAction, useScopedFilter } from '../data.ts';
import { updateTrade, useTradesShown } from '../tradeEdits.ts';
import { Badge, DirectionChip, Empty, Section, StatRow, Toggle } from '../kit/index.ts';
import { clockSec, recordedPriceNote, recordedPrices, type PlanLeg, type RecordedPrice } from '../model/activity.ts';
import {
  EMOTIONS,
  EXIT_REASONS,
  clock,
  dayLabel,
  emotionWord,
  exitReasonWord,
  holdLabel,
  pct,
  resultWord,
  rLabel,
  shortDate,
  tone,
  tradeOpen,
} from '../model/format.ts';
import { roiPct, ticksPerContract } from '../model/trade.ts';
import { Filmstrip, Rating, TagPicker } from '../parts/Common.tsx';
import { fileBase64, useSplitWidth } from '../parts/hooks.ts';
import { Replay } from '../parts/Replay.tsx';
import { EditorSample, RichEditor } from '../parts/RichEditor.tsx';
import { RunningPnl } from '../parts/RunningPnl.tsx';
import { TradeChart, TradeChartSample } from '../parts/TradeChart.tsx';
import { useArea } from '../../store.ts';
import { setJournal } from '../store.ts';
import { SAMPLE_DETAIL, SAMPLE_NOTE_LINES } from './samples.ts';
import './trade.css';

export function TradeDetail({ id }: { id: string }) {
  return (
    <Loaded
      key={id}
      label="Loading the trade"
      sample={<TradePage d={SAMPLE_DETAIL} catalog={null} Chart={TradeChartSample} />}
    >
      <TradeDetailBody id={id} />
    </Loaded>
  );
}

function TradeDetailBody({ id }: { id: string }) {
  const filter = useScopedFilter(true);
  const has = useHasTool('journal.get_trade');
  const q = useTool('journal.get_trade', has ? { id, filter } : null, { keepFor: 15_000, keepPrevious: true });
  const cat = valueOf(useCatalog());
  const d = valueOf(q);
  const shown = useArea((a) => a.area === 'journal');
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (e.defaultPrevented || tgt?.closest('[role="menu"], [role="listbox"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[' && d?.prevId) setJournal({ trade: d.prevId });
      else if (e.key === ']' && d?.nextId) setJournal({ trade: d.nextId });
      else if (e.key === 'Escape') setJournal({ trade: null });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, d?.prevId, d?.nextId]);
  if (q.isError) {
    return (
      <div className="t-blank">
        <p>This trade is no longer in the journal.</p>
        <div className="t-blank-acts">
          <Button onClick={() => setJournal({ trade: null })}>Back to the trades</Button>
        </div>
      </div>
    );
  }
  if (!d) return null;
  return <TradePage d={d} catalog={cat ?? null} Chart={TradeChart} />;
}

type ChartPart = (props: {
  d: Detail;
  lit?: { leg: PlanLeg; price: number } | null;
  height?: number | string;
}) => ReactNode;

function TradePage({ d: read, catalog, Chart }: { d: Detail; catalog: JournalCatalog | null; Chart: ChartPart }) {
  const one = useMemo(() => [read.trade], [read.trade]);
  const [t] = useTradesShown(one, catalog) as [Detail['trade']];
  const d = useMemo(() => ({ ...read, trade: t }), [read, t]);
  const act = useJournalAction();
  const update = (patch: Omit<UpdateTradeInput, 'id'>) => updateTrade(t.id, patch);
  const [lit, setLit] = useState<{ leg: PlanLeg; price: number } | null>(null);
  const split = useSplitWidth('tessera.journal.tradeRail', 380, 300, 640);
  return (
    <div className="jr-detail jt-page">
      <header className="jt-head">
        <Tooltip content="Back to the trades" shortcut="Esc">
          <IconButton label="Back to the trades" icon="chevron-left" onClick={() => setJournal({ trade: null })} />
        </Tooltip>
        <Tooltip content="Previous trade" shortcut="[">
          <IconButton
            label="Previous trade"
            icon="chevron-up"
            disabled={!d.prevId}
            onClick={() => d.prevId && setJournal({ trade: d.prevId })}
          />
        </Tooltip>
        <Tooltip content="Next trade" shortcut="]">
          <IconButton
            label="Next trade"
            icon="chevron-down"
            disabled={!d.nextId}
            onClick={() => d.nextId && setJournal({ trade: d.nextId })}
          />
        </Tooltip>
        <div className="jt-title">
          <div className="jt-title-row">
            <h2>{t.symbol}</h2>
            <Badge tone={t.side === 'buy' ? 'profit' : 'loss'}>{t.side === 'buy' ? 'Long' : 'Short'}</Badge>
            <Badge tone="outline">{tradeOpen(t) ? 'Open' : 'Closed'}</Badge>
            {t.origin === 'import' ? <Badge tone="mist">Imported</Badge> : null}
            {t.origin === 'manual' ? <Badge tone="mist">Logged</Badge> : null}
          </div>
          <span className="text-t3 text-(length:--text-meta)">
            {dayLabel(t.tradeDate)} · {clock(t.openedAt)}
            {t.closedAt !== null ? ` → ${clock(t.closedAt)} · ${holdLabel(t.holdSecs)}` : ' · open'} · {t.accountName}
          </span>
        </div>
        <div className="jt-acts">
          <button
            type="button"
            className={cx('jt-reviewed', t.reviewed && 'is-on')}
            aria-pressed={t.reviewed}
            onClick={() => void update({ reviewed: !t.reviewed })}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" />
              {t.reviewed ? <path d="M5 8.2l2 2 4-4.4" /> : null}
            </svg>
            {t.reviewed ? 'Reviewed' : 'Mark as reviewed'}
          </button>
          <Button size="s" onClick={() => void openOnChart(d)}>
            Open on chart
          </Button>
          <Button size="s" className="text-aqua" onClick={() => askAboutTrade(t)}>
            Ask the analyst
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="More" icon="more" />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                disabled={t.origin === 'broker'}
                why={t.origin === 'broker' ? 'From the connection' : undefined}
                hint={t.origin === 'broker' ? undefined : 'To the trash'}
                onSelect={() => void act('journal.delete_trade', { id: t.id }).then(() => setJournal({ trade: null }))}
              >
                Delete trade
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>
      <div className="jt-body">
        <aside className="jt-stats" style={{ width: split.width }} aria-label="The trade">
          <StatsPanel d={d} catalog={catalog} update={update} onLight={setLit} />
        </aside>
        <Splitter label="Resize the trade's panel" className="jt-split" {...split.splitter} />
        <div className="jt-content">
          <ContentPanel d={d} lit={lit} update={update} Chart={Chart} />
        </div>
      </div>
    </div>
  );
}

type Update = (patch: Omit<UpdateTradeInput, 'id'>) => Promise<unknown>;
type StatsTab = 'stats' | 'playbook' | 'executions';

function StatsPanel({
  d,
  catalog,
  update,
  onLight,
}: {
  d: Detail;
  catalog: JournalCatalog | null;
  update: Update;
  onLight: (lit: { leg: PlanLeg; price: number } | null) => void;
}) {
  const [tab, setTab] = useState<StatsTab>('stats');
  return (
    <div className="jt-panel">
      <Segmented<StatsTab>
        label="Trade panel"
        className="jt-tabs"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'stats', label: 'Stats' },
          { value: 'playbook', label: 'Playbook' },
          { value: 'executions', label: `Executions · ${String(d.executions.length)}` },
        ]}
      />
      <ScrollArea className="jt-scroll">
        <div className="jt-pad">
          {tab === 'stats' ? (
            <StatsTabBody d={d} catalog={catalog} update={update} onLight={onLight} />
          ) : tab === 'playbook' ? (
            <PlaybookTab d={d} catalog={catalog} update={update} />
          ) : (
            <ExecutionTimeline d={d} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function Hint({ children }: { children: string }) {
  return (
    <Tooltip content={children}>
      <button type="button" className="jk-info" aria-label="About">
        i
      </button>
    </Tooltip>
  );
}

function StatsTabBody({
  d,
  catalog,
  update,
  onLight,
}: {
  d: Detail;
  catalog: JournalCatalog | null;
  update: Update;
  onLight: (lit: { leg: PlanLeg; price: number } | null) => void;
}) {
  const t = d.trade;
  const dp = t.priceDecimals;
  const roi = roiPct(t, d.pointValue);
  const tpc = ticksPerContract(t);
  const trailed = t.exitReason === 'trailing_stop' || (t.exitReason === null && t.result === 'trailed');
  return (
    <>
      <div className="jt-hero">
        <div>
          <span className="jk-caps">Net P&amp;L</span>
          <div className={cx('jt-hero-v', tone(t.netPnl))}>{formatMoney(t.netPnl, { signed: true })}</div>
          <span className="text-t3 text-(length:--text-meta)">
            {tradeOpen(t) ? 'Realized so far · open' : `${resultWord(t.result)} · ${rLabel(t.rMultiple)}`}
          </span>
          {t.reportedPnl !== null ? (
            <span className="text-t3 jt-hero-rep text-(length:--text-meta)">
              Platform’s P&amp;L {formatMoney(t.reportedPnl, { signed: true })} (before fees)
            </span>
          ) : null}
        </div>
        <DirectionChip side={t.side} />
      </div>
      <Section title="Risk levels">
        <PriceField
          label="Take profit"
          value={t.targetPrice}
          dp={dp}
          note={planNote(t.planFrom, 'target')}
          recorded={recordedPrices(d, 'target')}
          onLight={(price) => onLight(price === null ? null : { leg: 'target', price })}
          onSave={(v) => update({ targetPrice: v })}
        />
        <PriceField
          label="Stop loss"
          value={t.stopPrice}
          dp={dp}
          note={planNote(t.planFrom, 'stop')}
          recorded={recordedPrices(d, 'stop')}
          onLight={(price) => onLight(price === null ? null : { leg: 'stop', price })}
          onSave={(v) => update({ stopPrice: v })}
        />
        <div className="jk-statrow">
          <span className="jk-statrow-l">Trailing stop</span>
          <Switch
            label="Trailing stop"
            checked={trailed}
            onCheckedChange={(on) => void update({ exitReason: on ? 'trailing_stop' : null })}
          />
        </div>
      </Section>
      <Section title="Performance">
        <StatRow label="Risk" value={t.risk === null ? '—' : formatMoney(-t.risk, { signed: true })} />
        <StatRow label="Planned R:R" value={t.plannedRr === null ? '—' : `${t.plannedRr.toFixed(2)} : 1`} />
        <StatRow
          label="Realized R"
          hint={
            <Hint>
              {t.planFrom === 'activity'
                ? 'Net P&L over the initial risk: the money at the first stop that covered the trade.'
                : 'Net P&L over the money at risk at the stop.'}
            </Hint>
          }
          value={rLabel(t.rMultiple)}
          tone={tone(t.rMultiple)}
        />
        <StatRow label="Gross P&L" value={formatMoney(t.grossPnl, { signed: true })} tone={tone(t.grossPnl)} />
        <StatRow
          label="ROI"
          hint={<Hint>Net P&amp;L over the contracts’ notional value at the entry.</Hint>}
          value={roi === null ? '—' : `${roi >= 0 ? '+' : ''}${roi.toFixed(3)}%`}
          tone={tone(roi)}
        />
      </Section>
      <div className="jt-excursion">
        <div className="jk-metric">
          <div className="jk-metric-head">
            <span className="jk-caps">MAE</span>
            <Hint>
              {d.excursionNote ??
                'Maximum adverse excursion: the largest move against the trade while it was held, from 1-minute bars.'}
            </Hint>
          </div>
          <div className="jk-metric-v down">{t.mae === null ? '—' : formatMoney(t.mae, { signed: true })}</div>
          <p className="jk-metric-d">{t.maePrice === null ? 'No bars read' : `at ${formatPrice(t.maePrice, dp)}`}</p>
        </div>
        <div className="jk-metric">
          <div className="jk-metric-head">
            <span className="jk-caps">MFE</span>
            <Hint>
              Maximum favourable excursion: the largest move in the trade’s favour while it was held. Hindsight: no exit
              could have known it.
            </Hint>
          </div>
          <div className="jk-metric-v up">{t.mfe === null ? '—' : formatMoney(t.mfe, { signed: true })}</div>
          <p className="jk-metric-d">{t.mfePrice === null ? 'No bars read' : `at ${formatPrice(t.mfePrice, dp)}`}</p>
        </div>
      </div>
      <Section title="Trade details">
        <StatRow label="Contracts" value={t.maxQty > t.qty ? `${String(t.qty)} (max ${String(t.maxQty)})` : t.qty} />
        <StatRow label="Points" value={t.points === null ? '—' : t.points.toFixed(dp)} tone={tone(t.points)} />
        <StatRow label="Ticks" value={t.ticks === null ? '—' : String(t.ticks)} tone={tone(t.ticks)} />
        <StatRow label="Ticks / contract" value={tpc === null ? '—' : String(tpc)} />
        <StatRow label="Fees" value={formatMoney(-t.fees, { signed: true })} />
      </Section>
      <Section title="Entry & exit">
        <StatRow label="Entry price" value={formatPrice(t.entryPrice, dp)} />
        <StatRow label="Entry time" value={`${shortDate(t.tradeDate)} ${clock(t.openedAt)}`} />
        <StatRow label="Exit price" value={t.exitPrice === null ? '—' : formatPrice(t.exitPrice, dp)} />
        <StatRow label="Exit time" value={t.closedAt === null ? 'Open' : clock(t.closedAt)} />
        <StatRow label="Duration" value={holdLabel(t.holdSecs)} />
      </Section>
      <Section title="Context">
        <div className="jk-statrow">
          <span className="jk-statrow-l">Rating</span>
          <Rating value={t.rating} onChange={(r) => void update({ rating: r })} />
        </div>
        <div className="jk-statrow">
          <span className="jk-statrow-l">Mood</span>
          <Select
            size="s"
            variant="quiet"
            label="Mood"
            value={t.emotion ?? 'none'}
            onValueChange={(v) => void update({ emotion: v === 'none' ? null : v })}
            options={[
              { value: 'none', label: '—' },
              ...EMOTIONS.map((e) => ({ value: e, label: emotionWord(e), textValue: e })),
            ]}
          />
        </div>
        <div className="jk-statrow">
          <span className="jk-statrow-l">Exit reason</span>
          <Select
            size="s"
            variant="quiet"
            label="Exit reason"
            value={t.exitReason ?? 'auto'}
            onValueChange={(v) => void update({ exitReason: v === 'auto' ? null : v })}
            options={[
              { value: 'auto', label: `${resultWord(t.result)} (as filled)` },
              ...EXIT_REASONS.map((r) => ({ value: r, label: exitReasonWord(r) })),
            ]}
          />
        </div>
        <div className="jt-tags">
          <span className="jk-statrow-l">Tags</span>
          <span className="jr-badges is-wrap">
            {t.tags.map((g) => (
              <Badge key={g.id} color={g.color}>
                {g.name}
              </Badge>
            ))}
            <TagPicker
              tags={catalog?.tags ?? []}
              value={t.tags.map((x) => x.id)}
              onChange={(ids) => void update({ tagIds: ids })}
              trigger={
                <Button size="s" variant="quiet">
                  {t.tags.length ? 'Change' : '+ Add tag'}
                </Button>
              }
            />
          </span>
        </div>
      </Section>
    </>
  );
}

const CATEGORY_ORDER = ['entry', 'exit', 'risk', 'management'];

function PlaybookTab({ d, catalog, update }: { d: Detail; catalog: JournalCatalog | null; update: Update }) {
  const t = d.trade;
  const setups = (catalog?.setups ?? []).filter((s) => s.active || s.id === t.setupId);
  const setup = catalog?.setups.find((s) => s.id === t.setupId) ?? null;
  const done = d.rules.filter((r) => r.checked).length;
  const share = d.rules.length ? done / d.rules.length : null;
  const groups = [...new Set(d.rules.map((r) => r.category))].sort(
    (a, b) => ((CATEGORY_ORDER.indexOf(a) + 9) % 9) - ((CATEGORY_ORDER.indexOf(b) + 9) % 9),
  );
  return (
    <>
      <Section title="Setup">
        <Select
          size="s"
          label="Setup"
          value={t.setupId ?? 'none'}
          onValueChange={(v) => void update({ setupId: v === 'none' ? null : v })}
          options={[
            { value: 'none', label: 'No setup' },
            ...setups.map((s) => ({
              value: s.id,
              textValue: s.name,
              label: (
                <span className="jr-setup-opt">
                  <i style={{ background: s.color }} />
                  {s.name}
                </span>
              ),
            })),
          ]}
        />
        {setup ? (
          <div className="jt-setup-foot">
            {share !== null ? (
              <Badge tone={share >= 0.8 ? 'profit' : share >= 0.5 ? 'brass' : 'loss'}>
                {String(done)}/{String(d.rules.length)} rules · {pct(share * 100, 0)}
              </Badge>
            ) : (
              <span className="text-t3">This setup has no rules yet.</span>
            )}
            <Button size="s" variant="quiet" onClick={() => setJournal({ section: 'playbooks', setup: setup.id })}>
              Open playbook →
            </Button>
          </div>
        ) : null}
      </Section>
      {!setup ? (
        <Empty compact icon="journal" title="No setup assigned">
          Pick the setup this trade was, to check it against its rules.
        </Empty>
      ) : (
        groups.map((g) => (
          <Section key={g} title={`${g} rules`}>
            {d.rules
              .filter((r) => r.category === g)
              .map((r) => (
                <Check
                  key={r.ruleId}
                  checked={r.checked}
                  onChange={(on) => void update({ rules: [{ ruleId: r.ruleId, checked: on }] })}
                >
                  <span className={cx('jr-rule', r.checked && 'is-done')}>{r.text}</span>
                </Check>
              ))}
          </Section>
        ))
      )}
    </>
  );
}

const KIND: Record<string, string> = { entry: 'Entry', scale_in: 'Scale in', scale_out: 'Scale out', exit: 'Exit' };
const ROLE: Record<string, string> = { stop_loss: 'Stop', take_profit: 'Target', exit: 'Close' };

function ExecutionTimeline({ d }: { d: Detail }) {
  const dp = d.trade.priceDecimals;
  if (!d.executions.length) return <Empty compact icon="trades" title="No executions" />;
  return (
    <ol className="jt-timeline">
      {d.executions.map((e) => (
        <li key={`${e.fillId}-${e.kind}`} className={cx('jt-exec', e.side === 'buy' ? 'up' : 'down')}>
          <span className="jt-exec-dot">
            <Icon name={e.side === 'buy' ? 'long' : 'short'} />
          </span>
          <div className="jt-exec-body">
            <div className="jt-exec-top">
              <b>{KIND[e.kind] ?? e.kind}</b>
              {e.role && ROLE[e.role] ? <Badge tone="outline">{ROLE[e.role]}</Badge> : null}
              <span className="text-t3 jt-exec-time">{clockSec(e.ts)}</span>
            </div>
            <div className="jt-exec-line">
              <span>
                {e.side === 'buy' ? 'Buy' : 'Sell'} {e.qty} @ {formatPrice(e.price, dp)}
              </span>
              {e.realized !== null ? (
                <span className={cx('r', tone(e.realized))}>{formatMoney(e.realized, { signed: true })}</span>
              ) : null}
            </div>
            {e.fee ? <span className="text-t3 jt-exec-fee">Fees {formatMoney(-e.fee, { signed: true })}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

type ContentTab = 'chart' | 'notes' | 'replay' | 'running';

function ContentPanel({
  d,
  lit,
  update,
  Chart,
}: {
  d: Detail;
  lit: { leg: PlanLeg; price: number } | null;
  update: Update;
  Chart: ChartPart;
}) {
  const [tab, setTab] = useState<ContentTab>('chart');
  return (
    <div className="jt-panel">
      <Segmented<ContentTab>
        label="Trade view"
        className="jt-tabs"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'chart', label: 'Chart' },
          { value: 'notes', label: 'Notes' },
          { value: 'replay', label: 'Replay' },
          { value: 'running', label: 'Running P&L' },
        ]}
      />
      {tab === 'chart' ? (
        <div className="jt-chart-pad">
          <Chart d={d} lit={lit} height="100%" />
        </div>
      ) : (
        <ScrollArea className="jt-scroll">
          <div className="jt-pad">
            {tab === 'notes' ? (
              <NotesTab d={d} update={update} />
            ) : tab === 'replay' ? (
              <Replay d={d} />
            ) : (
              <RunningPnl d={d} />
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function NotesTab({ d, update }: { d: Detail; update: Update }) {
  const t = d.trade;
  const act = useJournalAction();
  const [which, setWhich] = useState<'trade' | 'day'>('trade');
  const hasDay = useHasTool('journal.get_day');
  const day = useToolValue('journal.get_day', hasDay && which === 'day' ? { date: t.tradeDate } : null);
  const attach = async (f: File, date?: string) => {
    const dataBase64 = await fileBase64(f);
    return act('journal.add_attachment', {
      ...(date ? { date } : { tradeId: t.id }),
      filename: f.name,
      mediaType: f.type || 'image/png',
      dataBase64,
    });
  };
  return (
    <div className="jt-notes">
      <div className="jt-notes-head">
        <Toggle<'trade' | 'day'>
          label="Notes"
          value={which}
          onChange={setWhich}
          options={[
            { value: 'trade', label: 'Trade note' },
            { value: 'day', label: 'Daily journal' },
          ]}
        />
        {which === 'day' ? (
          <Button size="s" variant="quiet" onClick={() => setJournal({ section: 'days', day: t.tradeDate })}>
            Open full journal →
          </Button>
        ) : null}
      </div>
      {which === 'trade' ? (
        <>
          <RichEditor
            key={t.id}
            value={d.notes}
            placeholder="What did you see, and what did you do about it?"
            onSave={(text) => update({ notes: text || null })}
            onAttach={(f) => attach(f)}
          />
          <Section title="Screenshots">
            <Filmstrip
              items={d.attachments}
              onAdd={(f) => attach(f)}
              onRemove={(id) => void act('journal.delete_attachment', { id })}
            />
          </Section>
        </>
      ) : day ? (
        <RichEditor
          key={`day-${t.tradeDate}`}
          value={day.content}
          placeholder={`What happened on ${dayLabel(t.tradeDate)}?`}
          onSave={(content) => act('journal.save_day', { date: t.tradeDate, content })}
          onAttach={(f) => attach(f, t.tradeDate)}
          minHeight={200}
        />
      ) : (
        <SampleSkeleton label="Loading the day's journal">
          <EditorSample lines={SAMPLE_NOTE_LINES} minHeight={200} />
        </SampleSkeleton>
      )}
    </div>
  );
}

function planNote(from: string | null, what: 'stop' | 'target'): string | null {
  if (from === 'order') return 'bracket';
  if (from === 'activity') return `first ${what}`;
  return null;
}

function PriceField({
  label,
  value,
  dp,
  note,
  recorded,
  onLight,
  onSave,
}: {
  label: string;
  value: number | null;
  dp: number;
  note: string | null;
  recorded: readonly RecordedPrice[];
  onLight: (price: number | null) => void;
  onSave: (v: number | null) => Promise<unknown>;
}) {
  const shown = value === null ? '' : value.toFixed(dp);
  const [text, setText] = useState(shown);
  const [seen, setSeen] = useState(shown);
  if (shown !== seen) {
    setSeen(shown);
    setText(shown);
  }
  const commit = () => {
    const clean = text.replace(/[$,\s]/g, '');
    const v = clean === '' ? null : Number(clean);
    if (v !== null && !Number.isFinite(v)) {
      setText(value === null ? '' : value.toFixed(dp));
      return;
    }
    if (v === value) return;
    void onSave(v);
  };
  const choose = (p: RecordedPrice) => {
    setText(p.price.toFixed(dp));
    if (!p.current) void onSave(p.price);
  };
  const current = recorded.find((p) => p.current);
  return (
    <div className="jr-fact is-input">
      <label className="l" htmlFor={`jr-${label}`}>
        {label}
        {note && value !== null ? <span className="text-t4"> · {note}</span> : null}
      </label>
      <TextInput
        id={`jr-${label}`}
        size="s"
        inputMode="decimal"
        className="v"
        value={text}
        placeholder="—"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setText(value === null ? '' : value.toFixed(dp));
        }}
        unit={
          recorded.length ? (
            <Menu onOpenChange={(open) => (open ? undefined : onLight(null))}>
              <MenuTrigger asChild>
                <button type="button" className="jr-pick" aria-label={`Recorded ${label.toLowerCase()}s`}>
                  <Icon name="chevron-down" />
                </button>
              </MenuTrigger>
              <MenuContent align="end" className="jr-pick-menu" onPointerLeave={() => onLight(null)}>
                <MenuRadioGroup value={current ? String(recorded.indexOf(current)) : ''}>
                  {recorded.map((p, i) => (
                    <MenuRadioItem
                      key={`${String(p.t)}:${String(p.price)}`}
                      value={String(i)}
                      hint={recordedPriceNote(p)}
                      onFocus={() => onLight(p.price)}
                      onSelect={() => choose(p)}
                    >
                      <span className="jr-pick-px">{formatPrice(p.price, dp)}</span>
                      <span className="text-t3">{clockSec(p.t)}</span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
          ) : undefined
        }
      />
    </div>
  );
}
