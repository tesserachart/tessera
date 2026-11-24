import { valueOf } from '../../../app/tools.ts';
import type { EquityPoint, JournalStats, JournalTrade, Setup, SetupRuleInput } from '@tessera/protocol';
import { Button, IconButton, Loaded, Select, Switch, TextInput, cx, Reveal, formatMoney } from '@tessera/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { useCatalog, useJournalAction, useScopedFilter, useStats, useTrades } from '../data.ts';
import { journalDrafts } from '../drafts.ts';
import { useDraft } from '../../../app/overlay.ts';
import { pct, plural, rLabel, shortDate, sideWord } from '../model/format.ts';
import { headline } from '../model/stats.ts';
import { EquityChart } from '../parts/Charts.tsx';
import { Head, StatStrip, type StatCell } from '../parts/Common.tsx';
import { openTrade, setJournal, useJournalUi } from '../store.ts';
import { failureText } from '../../../app/tools.ts';
import { openStudy, studySetup } from '../../research/flow.ts';
import { SAMPLE_SETUPS, SAMPLE_STATS, SAMPLE_TRADE_LIST, SAMPLE_TRADES } from './samples.ts';

const ignore = () => undefined;

export function Playbooks() {
  return (
    <Loaded label="Loading the playbooks" sample={<PlaybooksSample />}>
      <PlaybooksBody />
    </Loaded>
  );
}

function PlaybooksBody() {
  const cat = valueOf(useCatalog());
  const open = useJournalUi((s) => s.setup);
  const act = useJournalAction();
  const setups = useMemo(
    () => [...(cat?.setups ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || b.stats.net - a.stats.net),
    [cat],
  );
  const current = setups.find((s) => s.id === open) ?? setups[0] ?? null;
  const create = async () => {
    const s = await act('journal.save_setup', { name: 'New setup' });
    setJournal({ setup: s.id });
  };
  return (
    <div className="jr-books">
      <SetupList setups={setups} current={current?.id ?? null} onNew={() => void create()} />
      {current ? <SetupPage key={current.id} s={current} /> : <div className="t-blank" />}
    </div>
  );
}

export function PlaybooksSample() {
  const s = SAMPLE_SETUPS[0]!;
  return (
    <div className="jr-books">
      <SetupList setups={SAMPLE_SETUPS} current={s.id} onNew={ignore} />
      <SetupPageView
        s={s}
        avgR={rLabel(SAMPLE_STATS.overview.all.avgR)}
        strip={<SetupStrip stats={SAMPLE_STATS} />}
        equity={<SetupEquity points={SAMPLE_STATS.equity} />}
        latest={<LatestTrades trades={SAMPLE_TRADES} />}
      />
    </div>
  );
}

function SetupList({
  setups,
  current,
  onNew,
}: {
  setups: readonly Setup[];
  current: string | null;
  onNew: () => void;
}) {
  return (
    <aside className="jr-books-list">
      <Head title="Setups">
        <Button size="s" onClick={onNew}>
          New setup
        </Button>
      </Head>
      <ol>
        {setups.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={cx('jr-book', s.id === current && 'is-on', !s.active && 'is-off')}
              onClick={() => setJournal({ setup: s.id })}
            >
              <span className="dot" style={{ background: s.color }} />
              <span className="nm">
                {s.name}
                <span className="text-t3 text-(length:--text-meta)">
                  {s.stats.n ? `${plural(s.stats.n, 'trade')} · ${pct(s.stats.winRate, 0)}` : 'No trades yet'}
                </span>
              </span>
              <span className={cx('fig', s.stats.net > 0 ? 'up' : s.stats.net < 0 ? 'down' : null)}>
                {s.stats.n ? formatMoney(s.stats.net, { signed: true }) : ''}
              </span>
              {i === 0 && s.stats.net > 0 && s.stats.n >= 20 ? <span className="text-t3 jr-lead">leads</span> : null}
            </button>
          </li>
        ))}
      </ol>
      {!setups.length ? (
        <p className="jr-quiet text-t3">
          A setup is a trade you take again and again. Write its rules once, tick them on each trade, and the journal
          measures whether following them pays.
        </p>
      ) : null}
    </aside>
  );
}

const CATEGORIES = [
  { value: 'entry', label: 'Entry' },
  { value: 'exit', label: 'Exit' },
  { value: 'risk', label: 'Risk' },
  { value: 'management', label: 'Management' },
];

function SetupPage({ s }: { s: Setup }) {
  const base = useScopedFilter(false);
  const stats = valueOf(useStats({ ...base, setups: [s.id] }));
  const trades = valueOf(useTrades({ ...base, setups: [s.id] }, 'opened', false, 12));
  return (
    <SetupPageView
      s={s}
      avgR={stats ? rLabel(stats.overview.all.avgR) : ''}
      strip={
        <Reveal label="Loading the setup's stats" data={stats} sample={SAMPLE_STATS}>
          {(stats) => <SetupStrip stats={stats} />}
        </Reveal>
      }
      equity={
        <Reveal label="Loading the setup's equity" data={stats?.equity} sample={SAMPLE_STATS.equity}>
          {(points) => <SetupEquity points={points} />}
        </Reveal>
      }
      latest={
        <Reveal label="Loading the setup's trades" data={trades} sample={SAMPLE_TRADE_LIST}>
          {(list) => <LatestTrades trades={list.trades} />}
        </Reveal>
      }
    />
  );
}

function stripCells(stats: JournalStats): StatCell[] {
  return headline(stats).map((c) => ({ label: c.label, value: c.text, tone: c.tone, hint: c.hint, sub: c.sub }));
}

function SetupStrip({ stats }: { stats: JournalStats }) {
  if (!stats.overview.all.n)
    return <p className="jr-quiet text-t3">No closed trades with this setup in this range yet.</p>;
  return <StatStrip cells={stripCells(stats)} />;
}

function SetupEquity({ points }: { points: readonly EquityPoint[] }) {
  return <EquityChart points={points} height={220} onPick={openTrade} empty="Its trades draw the curve." />;
}

function LatestTrades({ trades }: { trades: readonly JournalTrade[] }) {
  return (
    <ol className="jr-mini-trades">
      {trades.map((t) => (
        <li key={t.id}>
          <button type="button" onClick={() => openTrade(t.id)}>
            <span className="text-t3">{shortDate(t.tradeDate)}</span>
            <b>{t.symbol}</b>
            <span className={t.side === 'buy' ? 'up' : 'down'}>{sideWord(t.side)}</span>
            <span className="text-t3">{rLabel(t.rMultiple)}</span>
            <span className={cx('r', t.netPnl > 0 ? 'up' : t.netPnl < 0 ? 'down' : null)}>
              {formatMoney(t.netPnl, { signed: true })}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function SetupPageView({
  s,
  avgR,
  strip,
  equity,
  latest,
}: {
  s: Setup;
  avgR: string;
  strip: ReactNode;
  equity: ReactNode;
  latest: ReactNode;
}) {
  const act = useJournalAction();
  const save = (patch: Parameters<typeof act<'journal.save_setup'>>[1]) =>
    act('journal.save_setup', { id: s.id, ...patch });
  const draft = useDraft<SetupRuleInput[]>(journalDrafts, `setup/${s.id}/rules`, s.rules);
  const rules = draft.value;
  const saveRules = (next: SetupRuleInput[]) =>
    draft.save(next, (v) => save({ rules: v.filter((r) => r.text.trim()) }));
  const adherence = new Map(s.adherence.map((a) => [a.ruleId, a]));
  const [studyError, setStudyError] = useState<string | null>(null);
  return (
    <article className="jr-book-page">
      <header className="jr-book-head">
        <input
          className="jr-book-name jr-serif"
          defaultValue={s.name}
          aria-label="Setup name"
          onBlur={(e) =>
            e.target.value.trim() && e.target.value !== s.name && void save({ name: e.target.value.trim() })
          }
        />
        <span className="jr-head-r">
          <Switch label="Active" checked={s.active} onCheckedChange={(v) => void save({ active: v })}>
            In use
          </Switch>
          <Button
            size="s"
            variant="quiet"
            onClick={() => setJournal({ section: 'trades', trade: null, filter: { setups: [s.id] } })}
          >
            Its trades
          </Button>
          <StudyIt s={s} onError={setStudyError} />
          <Button
            size="s"
            variant="destructive"
            what="setup"
            onClick={() => void act('journal.delete_setup', { id: s.id }).then(() => setJournal({ setup: null }))}
          >
            Delete
          </Button>
        </span>
      </header>
      {studyError ? (
        <p className="jr-error" data-selectable>
          {studyError}
        </p>
      ) : null}
      {strip}
      <div className="jr-book-body">
        <div className="jr-book-text">
          <Text
            label="What it is"
            value={s.description}
            onSave={(v) => save({ description: v })}
            placeholder="The idea, the market it works in."
          />
          <Text
            label="When to enter"
            value={s.entryCriteria}
            onSave={(v) => save({ entryCriteria: v })}
            placeholder="What has to be true before you take it."
          />
          <Text
            label="How to exit"
            value={s.exitRules}
            onSave={(v) => save({ exitRules: v })}
            placeholder="Stop, targets, when you are wrong."
          />
          <section className="jr-region" aria-label="Rules">
            <h3 className="jr-sub">Rules, ticked on each trade</h3>
            {rules.map((r, i) => {
              const a = r.id ? adherence.get(r.id) : undefined;
              return (
                <div className="jr-rule-row" key={r.id ?? `new-${String(i)}`}>
                  <Select
                    size="s"
                    variant="quiet"
                    label="Category"
                    value={r.category ?? 'entry'}
                    onValueChange={(c) => saveRules(rules.map((x, j) => (j === i ? { ...x, category: c } : x)))}
                    options={CATEGORIES}
                  />
                  <TextInput
                    size="s"
                    defaultValue={r.text}
                    aria-label="Rule"
                    onBlur={(e) =>
                      e.target.value !== r.text &&
                      saveRules(rules.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                    }
                  />
                  <span className="text-t3 jr-adh" title="Trades it was followed on, over the setup's closed trades">
                    {a?.trades ? `${String(a.followed)}/${String(a.trades)}` : ''}
                  </span>
                  <IconButton
                    label="Remove rule"
                    icon="remove"
                    onClick={() => saveRules(rules.filter((_, j) => j !== i))}
                  />
                </div>
              );
            })}
            <form
              className="jr-rule-row"
              onSubmit={(e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.namedItem('rule') as HTMLInputElement;
                if (!input.value.trim()) return;
                saveRules([...rules, { text: input.value.trim(), category: 'entry' }]);
                input.value = '';
              }}
            >
              <span />
              <TextInput size="s" name="rule" placeholder="Add a rule" aria-label="Add a rule" />
              <Button size="s" type="submit">
                Add
              </Button>
            </form>
          </section>
        </div>
        <div className="jr-book-chart">
          <Head title="Equity">
            <span className="text-t3">{avgR} average</span>
          </Head>
          {equity}
          <Head title="Latest trades" />
          {latest}
        </div>
      </div>
    </article>
  );
}

function StudyIt({ s, onError }: { s: Setup; onError: (why: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  if (!s.studyId && !s.stats.n) return null;
  return (
    <Button
      size="s"
      variant="quiet"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        onError(null);
        void studySetup(s)
          .then(openStudy)
          .catch((e: unknown) => onError(failureText(e)))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Studying its trades…' : s.studyId ? 'Open its study' : 'Study it in Research'}
    </Button>
  );
}

function Text({
  label,
  value,
  onSave,
  placeholder,
}: {
  label: string;
  value: string;
  onSave: (v: string) => Promise<unknown>;
  placeholder: string;
}) {
  return (
    <label className="jr-textblock">
      <span className="jr-label">{label}</span>
      <textarea
        className="jr-area"
        defaultValue={value}
        placeholder={placeholder}
        rows={3}
        onBlur={(e) => e.target.value !== value && void onSave(e.target.value)}
      />
    </label>
  );
}
