import type {
  AgentSessionSummary,
  CaseResult,
  DataCoverageOutput,
  RunDigest,
  SplitResult,
  Study,
  StudyRun,
} from '@tessera/protocol';
import { Button, Loaded, PRICE_TEXT, ScrollArea, Segmented, Tooltip, cx, formatMoney } from '@tessera/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { selectSession } from '../../analyst/analystStore.ts';
import { useTool, useToolAction } from '../../app/tools.ts';
import { displaySymbol } from '../../market/instruments.ts';
import { askAnalyst } from '../../shell/tradeActions.ts';
import { showArea } from '../store.ts';
import { Equity } from './Equity.tsx';
import { showTradeOnChart } from './flow.ts';
import { entrySource, marketWords, sourceWords, type Entry, type Source } from './ledger.ts';
import { LiveCard } from '../../analyst/cards/LiveCard.tsx';
import {
  VERDICT_WORD,
  budgetLine,
  coverageInput,
  coverageLines,
  fillsLine,
  moneyCi,
  pct,
  pctCi,
  placeboLine,
  setupRows,
} from './model.ts';
import { sampleRun } from './samples.ts';
import { pickTrade, selectStudy, setRunTab, useResearchView, type RunTab } from './selection.ts';
import { StudyInTrade } from './StudyInTrade.tsx';
import {
  SPLIT_WORD,
  monthBreakdown,
  monthWords,
  testerStats,
  tradeDayZone,
  tradeTime,
  type StatRow,
} from './tester.ts';
import { TradeList } from './Trades.tsx';

const CHANGES = { refresh: ['research.list_studies', 'research.list_runs', 'research.get_study'] };

export function EntryPane({
  entry,
  sessions,
  sample = false,
}: {
  entry: Entry;
  sessions: readonly AgentSessionSummary[] | null;
  sample?: boolean;
}) {
  const source = entrySource(entry, sessions);
  return entry.kind === 'run' ? (
    <RunPane run={entry.run} study={entry.study} source={source} sample={sample} />
  ) : (
    <StudyPane study={entry.study} source={source} />
  );
}

function SourceLink({ source }: { source: Source }) {
  if (source.kind === 'chat' && !source.gone)
    return (
      <button
        type="button"
        className="rs-source"
        onClick={() => {
          selectSession(source.sessionId);
          showArea('agents');
        }}
      >
        {sourceWords(source)}
      </button>
    );
  return <span className="rs-source-plain">{source.kind === 'you' ? 'Run by you' : sourceWords(source)}</span>;
}

function Confirm({ words, onYes, onNo }: { words: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="rs-confirm" role="alertdialog" aria-label="Delete">
      <span>{words}</span>
      <Button size="s" variant="destructive" onClick={onYes}>
        Delete
      </Button>
      <Button size="s" variant="quiet" onClick={onNo}>
        Keep
      </Button>
    </div>
  );
}

function Head({
  name,
  state,
  tags,
  actions,
  meta,
  idea,
  reason,
}: {
  name: string;
  state: { word: string; verdict: string };
  tags: readonly string[];
  actions: ReactNode;
  meta: ReactNode;
  idea: string;
  reason: string | null;
}) {
  return (
    <header className="rs-head">
      <div className="rs-head-line">
        <h2 className="rs-name">{name}</h2>
        <span className="rs-state" data-verdict={state.verdict}>
          {state.word}
        </span>
        {tags.map((t) => (
          <span key={t} className="rs-tag">
            {t}
          </span>
        ))}
        <span className="rs-fill" />
        <div className="rs-actions">{actions}</div>
      </div>
      <p className="rs-meta">{meta}</p>
      {reason ? <p className="rs-reason">{reason}</p> : null}
      <p className="rs-idea" title={idea}>
        {idea}
      </p>
    </header>
  );
}

function useEntryActions(studyId: string, runId: string | null) {
  const [error, setError] = useState<string | null>(null);
  const run = useToolAction('research.run_study', CHANGES, { id: studyId });
  const archive = useToolAction('research.archive_run', CHANGES, { runId: runId ?? '' });
  const removeRun = useToolAction('research.delete_run', CHANGES, { runId: runId ?? '' });
  const removeStudy = useToolAction('research.delete_study', CHANGES, { id: studyId });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  return {
    error,
    busy: run.pending || archive.pending || removeRun.pending || removeStudy.pending,
    running: run.pending,
    rerun: () => {
      if (run.running()) return;
      setError(null);
      void run.run({ id: studyId }).then((d) => selectStudy(d.runId), fail);
    },
    archive: (runId: string, archived: boolean) => {
      setError(null);
      void archive.run({ runId, archived }).catch(fail);
    },
    deleteRun: (runId: string) => {
      setError(null);
      void removeRun.run({ runId }).then(() => selectStudy(null), fail);
    },
    deleteStudy: (id: string) => {
      setError(null);
      void removeStudy.run({ id }).then(() => selectStudy(null), fail);
    },
  };
}

function RunPane({ run, study, source, sample }: { run: RunDigest; study: Study; source: Source; sample: boolean }) {
  const full = useTool('research.get_run', sample ? null : { runId: run.runId }, { keepFor: Infinity });
  const shown = sample ? sampleRun(run) : full.data;
  const coverageAsked = sample ? null : coverageInput(study, full.data);
  const coverage = useTool('market.data_coverage', coverageAsked, { keepFor: 30_000 });
  const act = useEntryActions(study.id, run.runId);
  const [asking, setAsking] = useState(false);
  const archived = run.archivedAt !== null;
  const symbol = displaySymbol(study.data.instrument);
  const tags = [run.exploratory ? 'Exploratory' : null, archived ? 'Archived' : null].filter(
    (t): t is string => t !== null,
  );
  return (
    <div className="rs-pane">
      <Head
        name={study.name}
        state={{ word: VERDICT_WORD[run.verdict], verdict: run.verdict }}
        tags={tags}
        actions={
          <>
            <Button
              size="s"
              variant="quiet"
              onClick={() =>
                askAnalyst(
                  `Interpret run ${run.runId} of the study "${study.name}" (research.get_run): separate what was measured, the registered hypothesis, and your interpretation; mention the research budget (${budgetLine(run.budget)}) and whether a placebo or a later period would change the reading.`,
                )
              }
            >
              Ask the analyst
            </Button>
            <Button size="s" disabled={act.busy} onClick={act.rerun}>
              {act.running ? 'Running…' : 'Run again'}
            </Button>
            <Button size="s" disabled={act.busy} onClick={() => act.archive(run.runId, !archived)}>
              {archived ? 'Restore' : 'Archive'}
            </Button>
            <Button size="s" variant="destructive" disabled={act.busy} onClick={() => setAsking(true)}>
              Delete
            </Button>
          </>
        }
        meta={
          <>
            <SourceLink source={source} /> · {tradeTime(run.at)} · {marketWords(study)} · {run.sessions} sessions
            {study.generation > 1 ? ` · generation ${String(run.generation)}` : ''} · {budgetLine(run.budget)}
          </>
        }
        idea={study.hypothesis}
        reason={run.reason}
      />
      {asking ? (
        <Confirm
          words="Delete this run? It still counts as one of the backtests tried on this idea."
          onYes={() => act.deleteRun(run.runId)}
          onNo={() => setAsking(false)}
        />
      ) : null}
      {act.error ? (
        <p className="rs-error" data-selectable>
          {act.error}
        </p>
      ) : null}
      <ScrollArea className="rs-scroll">
        <Loaded
          key={run.runId}
          label="Loading the run"
          pending={!sample && (full.isPending || (coverageAsked !== null && coverage.isPending))}
          sample={<RunBody run={run} study={study} full={sampleRun(run)} symbol={symbol} coverage={null} />}
        >
          {shown ? (
            <RunBody run={run} study={study} full={shown} symbol={symbol} coverage={coverage.data ?? null} />
          ) : full.isError ? (
            <p className="rs-quiet">This run could not be read. Run the study again to measure it anew.</p>
          ) : null}
        </Loaded>
      </ScrollArea>
    </div>
  );
}

function StudyPane({ study, source }: { study: Study; source: Source }) {
  const act = useEntryActions(study.id, null);
  const [asking, setAsking] = useState(false);
  const symbol = displaySymbol(study.data.instrument);
  return (
    <div className="rs-pane">
      <Head
        name={study.name}
        state={{ word: 'Not run', verdict: 'draft' }}
        tags={[]}
        actions={
          <>
            <Button size="s" variant="primary" disabled={act.busy} onClick={act.rerun}>
              {act.running ? 'Running…' : 'Run'}
            </Button>
            <Button size="s" variant="destructive" disabled={act.busy} onClick={() => setAsking(true)}>
              Delete
            </Button>
          </>
        }
        meta={
          <>
            <SourceLink source={source} /> · {marketWords(study)}
          </>
        }
        idea={study.hypothesis}
        reason={null}
      />
      {asking ? (
        <Confirm
          words="Delete this study? Its runs still count as backtests tried on this idea."
          onYes={() => act.deleteStudy(study.id)}
          onNo={() => setAsking(false)}
        />
      ) : null}
      {act.error ? (
        <p className="rs-error" data-selectable>
          {act.error}
        </p>
      ) : null}
      <ScrollArea className="rs-scroll">
        <div className="rs-body-pad">
          <Setup study={study} symbol={symbol} />
        </div>
      </ScrollArea>
    </div>
  );
}

const SPLITS = ['development', 'later'] as const;

function money(v: number | null | undefined) {
  return (
    <span className={cx(PRICE_TEXT, v && v > 0 ? 'up' : v && v < 0 ? 'down' : undefined)}>
      {formatMoney(v, { signed: true })}
    </span>
  );
}

function SplitTable({ base }: { base: CaseResult }) {
  return (
    <table className="rs-table rs-splits" aria-label="Development and later">
      <thead>
        <tr>
          <th />
          <th>Net</th>
          <th>Trades</th>
          <th>Win rate</th>
          <th>Profit factor</th>
          <th>Max drawdown</th>
          <th>Expectancy</th>
        </tr>
      </thead>
      <tbody>
        {SPLITS.map((k) => {
          const s: SplitResult = base[k];
          const m = s.metrics;
          return (
            <tr key={k}>
              <th scope="row">{SPLIT_WORD[k]}</th>
              <td>{money(m.netPnl)}</td>
              <td className={PRICE_TEXT}>{m.trades}</td>
              <td className={PRICE_TEXT}>{pct(m.winRate)}</td>
              <td className={PRICE_TEXT}>{m.profitFactor === null ? '—' : m.profitFactor.toFixed(2)}</td>
              <td className={PRICE_TEXT}>{formatMoney(m.maxDrawdown)}</td>
              <td>{money(m.avgTrade)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RunBody({
  run,
  study,
  full,
  symbol,
  coverage,
}: {
  run: RunDigest;
  study: Study;
  full: StudyRun;
  symbol: string;
  coverage: DataCoverageOutput | null;
}) {
  const tab = useResearchView((v) => v.tab);
  const picked = useResearchView((v) => v.trade);
  const base = full.evaluation.cases[0] ?? null;
  if (!base) return <p className="rs-quiet">This run measured nothing.</p>;
  return (
    <div className="rs-body-pad">
      <SplitTable base={base} />
      <section className="rs-sec">
        <Equity points={base.equity} laterFrom={base.later.from} />
      </section>
      <Segmented<RunTab>
        label="Run"
        className="rs-tabs"
        value={tab}
        onChange={setRunTab}
        options={[
          { value: 'overview', label: 'Overview' },
          { value: 'trades', label: `Trades · ${String(base.trades.length)}` },
          { value: 'setup', label: 'Setup' },
        ]}
      />
      {tab === 'overview' ? <Overview run={run} base={base} study={study} coverage={coverage} /> : null}
      {tab === 'trades' ? (
        <TradeList
          base={base}
          picked={picked}
          onShow={(n) => {
            pickTrade(n);
            const t = base.trades[n - 1];
            if (t) void showTradeOnChart(study, run.runId, n, t);
          }}
        />
      ) : null}
      {tab === 'setup' ? <Setup study={study} symbol={symbol} /> : null}
    </div>
  );
}

function Overview({
  run,
  base,
  study,
  coverage,
}: {
  run: RunDigest;
  base: CaseResult;
  study: Study;
  coverage: DataCoverageOutput | null;
}) {
  const zone = tradeDayZone(study);
  const stats = useMemo(() => testerStats(base, zone), [base, zone]);
  const months = useMemo(() => monthBreakdown(base, zone), [base, zone]);
  const gates = run.cases[0]?.gates ?? [];
  return (
    <>
      <section className="rs-sec">
        <h3 className="rs-sec-title">Statistics · {base.case.name}</h3>
        <QuantTable rows={stats.quant} />
      </section>
      {gates.length ? (
        <section className="rs-sec">
          <h3 className="rs-sec-title">Pass rules</h3>
          <table className="rs-table rs-gates">
            <thead>
              <tr>
                <th />
                {run.cases.map((c) => (
                  <th key={c.case.name}>{c.case.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {gates.map((g, i) => (
                <tr key={g.gate}>
                  <th scope="row">{g.gate}</th>
                  {run.cases.map((c) => {
                    const r = c.gates[i];
                    return (
                      <td key={c.case.name} className={cx(r && (r.passed ? 'is-pass' : 'is-fail'))}>
                        {r ? (
                          <>
                            <span className={PRICE_TEXT}>{r.measured}</span>{' '}
                            <span aria-label={r.passed ? 'Passed' : 'Failed'}>{r.passed ? '✓' : '×'}</span>
                          </>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {placeboLine(run.placebo) ? <p className="rs-note">{placeboLine(run.placebo)}</p> : null}
        </section>
      ) : null}
      {months.length ? (
        <section className="rs-sec">
          <h3 className="rs-sec-title">By month</h3>
          <table className="rs-table rs-months">
            <thead>
              <tr>
                <th />
                <th>Trades</th>
                <th>Win rate</th>
                <th>Net</th>
                <th aria-label="Split" />
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{monthWords(m.month)}</th>
                  <td className={PRICE_TEXT}>{m.trades}</td>
                  <td className={PRICE_TEXT}>{pct(m.trades ? m.wins / m.trades : null)}</td>
                  <td>{money(m.net)}</td>
                  <td className="rs-dim">{m.splits.map((s) => SPLIT_WORD[s]).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <section className="rs-sec">
        <h3 className="rs-sec-title">Fill cases</h3>
        <table className="rs-table">
          <thead>
            <tr>
              <th />
              <th>Trades</th>
              <th>Win rate (95%)</th>
              <th>Mean trade (95%)</th>
              <th>Net</th>
              <th>Max drawdown</th>
            </tr>
          </thead>
          <tbody>
            {run.cases.flatMap((c) =>
              SPLITS.map((k) => {
                const s = c[k];
                return (
                  <tr key={`${c.case.name}-${k}`}>
                    <th scope="row">
                      {k === 'development' ? `${c.case.name} ${String(c.case.slippageTicks)}t · ` : ''}
                      <span className="rs-dim">{SPLIT_WORD[k]}</span>
                    </th>
                    <td className={PRICE_TEXT}>{s.trades}</td>
                    <td className={PRICE_TEXT}>{pctCi(s.winRate, s.winRateCi)}</td>
                    <td className={PRICE_TEXT}>{moneyCi(s.avgTrade, s.avgTradeCi)}</td>
                    <td>{money(s.netPnl)}</td>
                    <td className={PRICE_TEXT}>{formatMoney(s.maxDrawdown)}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
        {fillsLine(run) ? <p className="rs-note">{fillsLine(run)}</p> : null}
      </section>
      {coverage ? (
        <section className="rs-sec">
          <h3 className="rs-sec-title">Saved data</h3>
          <LiveCard card={coverage.card} />
        </section>
      ) : null}
      {run.levels ? (
        <section className="rs-sec">
          <h3 className="rs-sec-title">Level inputs</h3>
          {coverageLines(run.levels).map((l) => (
            <p key={l} className="rs-note">
              {l}
            </p>
          ))}
        </section>
      ) : null}
    </>
  );
}

function QuantTable({ rows }: { rows: readonly StatRow[] }) {
  return (
    <table className="rs-table rs-quant">
      <thead>
        <tr>
          <th />
          <th>{SPLIT_WORD.development}</th>
          <th>{SPLIT_WORD.later}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">
              {r.hint ? (
                <Tooltip content={r.hint}>
                  <span className="rs-hint" tabIndex={0}>
                    {r.label}
                  </span>
                </Tooltip>
              ) : (
                r.label
              )}
            </th>
            <td className={cx(PRICE_TEXT, r.development.tone)}>{r.development.text}</td>
            <td className={cx(PRICE_TEXT, r.later.tone)}>{r.later.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Setup({ study, symbol }: { study: Study; symbol: string }) {
  return (
    <>
      <section className="rs-sec">
        <h3 className="rs-sec-title">Hypothesis</h3>
        <p className="rs-prose" data-selectable>
          {study.hypothesis}
        </p>
        {study.notes ? (
          <p className="rs-prose rs-dim" data-selectable>
            {study.notes}
          </p>
        ) : null}
      </section>
      <section className="rs-sec">
        <h3 className="rs-sec-title">Setup</h3>
        <dl className="rs-setup">
          {setupRows(study, symbol).map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd data-selectable>{r.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      {study.strategy.kind === 'script' ? (
        <section className="rs-sec">
          <h3 className="rs-sec-title">Strategy</h3>
          <pre className="rs-code" data-selectable>
            {study.strategy.code}
          </pre>
        </section>
      ) : null}
      <div className="rs-foot">
        <StudyInTrade study={study} />
      </div>
    </>
  );
}
