import type { CaseResult, DataCoverageOutput, RunDigest, SplitDigest, Study, StudyRun } from '@tessera/protocol';
import { Loaded, PRICE_TEXT, ScrollArea, Segmented, Tooltip, cx, formatMoney } from '@tessera/ui';
import { useMemo, useState } from 'react';
import { useTool } from '../../app/tools.ts';
import { askAnalyst } from '../../shell/tradeActions.ts';
import { LiveCard } from '../../analyst/cards/LiveCard.tsx';
import { Equity } from './Equity.tsx';
import { TradesView } from './Trades.tsx';
import {
  VERDICT_WORD,
  budgetLine,
  coverageInput,
  coverageLines,
  dataWords,
  fillsLine,
  moneyCi,
  pct,
  pctCi,
  placeboLine,
} from './model.ts';
import { sampleRun } from './samples.ts';
import { SPLIT_WORD, monthBreakdown, monthWords, testerStats, tradeDayZone, type StatRow } from './tester.ts';

type Tab = 'summary' | 'trades';

export function RunView({
  run,
  runs,
  study,
  symbol,
}: {
  run: RunDigest;
  runs: readonly RunDigest[];
  study: Study;
  symbol: string;
}) {
  const [shown, setShown] = useState(run.runId);
  const current = runs.find((r) => r.runId === shown) ?? run;
  const fullRead = useTool('research.get_run', { runId: current.runId }, { keepFor: Infinity });
  const coverageAsked = coverageInput(study, fullRead.data);
  const coverageRead = useTool('market.data_coverage', coverageAsked, { keepFor: 30_000 });
  return (
    <ScrollArea className="rs-results-scroll">
      <Loaded
        key={current.runId}
        label="Loading the run"
        pending={fullRead.isPending || (coverageAsked !== null && coverageRead.isPending)}
        sample={<RunSample digest={current} runs={runs} study={study} symbol={symbol} />}
      >
        <RunBody
          current={current}
          runs={runs}
          study={study}
          symbol={symbol}
          full={fullRead.data}
          coverage={coverageRead.data}
          onShow={setShown}
        />
      </Loaded>
    </ScrollArea>
  );
}

export function RunSample({
  digest,
  runs,
  study,
  symbol,
}: {
  digest: RunDigest;
  runs: readonly RunDigest[];
  study: Study;
  symbol: string;
}) {
  return (
    <RunBody
      current={digest}
      runs={runs}
      study={study}
      symbol={symbol}
      full={sampleRun(digest)}
      coverage={undefined}
      onShow={() => undefined}
    />
  );
}

function RunBody({
  current,
  runs,
  study,
  symbol,
  full,
  coverage,
  onShow,
}: {
  current: RunDigest;
  runs: readonly RunDigest[];
  study: Study;
  symbol: string;
  full: StudyRun | undefined;
  coverage: DataCoverageOutput | undefined;
  onShow: (runId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('summary');
  const base = full?.evaluation.cases[0] ?? null;
  return (
    <div className="rs-run">
      <div className="rs-verdict" data-verdict={current.verdict}>
        <span className="rs-verdict-word">{VERDICT_WORD[current.verdict]}</span>
        <span className="rs-verdict-why">{current.reason}</span>
      </div>
      <p className="rs-meta">
        {current.exploratory ? 'Exploratory: run on a draft, not evidence · ' : ''}
        {dataWords(study.data, symbol)} · {current.sessions} sessions, later from session {current.laterFromSession + 1}
      </p>

      {base && full ? (
        <>
          <Segmented<Tab>
            label="Results"
            className="rs-tabs"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'summary', label: 'Summary' },
              { value: 'trades', label: `Trades · ${String(base.trades.length)}` },
            ]}
          />
          {tab === 'summary' ? (
            <Summary base={base} study={study} />
          ) : (
            <TradesView study={study} run={full} base={base} symbol={symbol} />
          )}
        </>
      ) : null}

      <PassRules current={current} />

      {runs.length > 1 ? (
        <section className="rs-sec">
          <h3 className="rs-sec-title">Runs</h3>
          <ul className="rs-runs">
            {runs.map((r) => (
              <li key={r.runId}>
                <button
                  type="button"
                  className={cx('rs-run-row', r.runId === current.runId && 'is-on')}
                  onClick={() => onShow(r.runId)}
                >
                  <span data-verdict={r.verdict}>{VERDICT_WORD[r.verdict]}</span>
                  <span>{r.exploratory ? 'exploratory' : 'evidence'}</span>
                  <span className={PRICE_TEXT}>{formatMoney(r.cases[0]?.later.netPnl, { signed: true })}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="rs-more">
        <summary>Hypothesis · data · every fill case</summary>
        <More current={current} study={study} coverage={coverage} />
      </details>
    </div>
  );
}

function Summary({ base, study }: { base: CaseResult; study: Study }) {
  const zone = tradeDayZone(study);
  const stats = useMemo(() => testerStats(base, zone), [base, zone]);
  const months = useMemo(() => monthBreakdown(base, zone), [base, zone]);
  return (
    <>
      <section className="rs-sec">
        <h3 className="rs-sec-title">Equity · {base.case.name}</h3>
        <Equity points={base.equity} laterFrom={base.later.from} />
      </section>
      <section className="rs-sec">
        <h3 className="rs-sec-title">Development vs later</h3>
        <div className="rs-sides">
          {(['development', 'later'] as const).map((split) => (
            <div key={split} className="rs-side" role="group" aria-label={SPLIT_WORD[split]}>
              <span className="rs-side-name">{SPLIT_WORD[split]}</span>
              <dl className="rs-side-stats">
                {stats.headline.map((s) => (
                  <div key={s.label}>
                    <dt>{s.label}</dt>
                    <dd className={cx(PRICE_TEXT, s[split].tone)}>{s[split].text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <QuantTable rows={stats.quant} />
      </section>
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
                  <td className={cx(PRICE_TEXT, m.net > 0 ? 'up' : m.net < 0 ? 'down' : undefined)}>
                    {formatMoney(m.net, { signed: true })}
                  </td>
                  <td className="rs-months-split">{m.splits.map((s) => SPLIT_WORD[s]).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

function PassRules({ current }: { current: RunDigest }) {
  const gates = current.cases[0]?.gates ?? [];
  if (!gates.length) return null;
  return (
    <section className="rs-sec">
      <h3 className="rs-sec-title">Pass rules</h3>
      <table className="rs-table rs-gates">
        <thead>
          <tr>
            <th />
            {current.cases.map((c) => (
              <th key={c.case.name}>{c.case.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {gates.map((g, i) => (
            <tr key={g.gate}>
              <th scope="row">{g.gate}</th>
              {current.cases.map((c) => {
                const r = c.gates[i];
                if (!r) return <td key={c.case.name} />;
                return (
                  <td key={c.case.name} className={cx('rs-gate', r.passed ? 'is-pass' : 'is-fail')}>
                    <span className={PRICE_TEXT}>{r.measured}</span>
                    <span className="rs-gate-mark" aria-label={r.passed ? 'Passed' : 'Failed'}>
                      {r.passed ? '✓' : '×'}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {placeboLine(current.placebo) ? <p className="rs-placebo">{placeboLine(current.placebo)}</p> : null}
    </section>
  );
}

function More({
  current,
  study,
  coverage,
}: {
  current: RunDigest;
  study: Study;
  coverage: DataCoverageOutput | undefined;
}) {
  return (
    <div className="rs-more-body">
      <section className="rs-sec">
        <h3 className="rs-sec-title">Hypothesis</h3>
        <p className="rs-hyp">{study.hypothesis}</p>
      </section>

      {current.levels ? (
        <section className="rs-sec">
          <h3 className="rs-sec-title">Level inputs</h3>
          <ul className="rs-levels">
            {coverageLines(current.levels).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {coverage ? (
        <section className="rs-sec">
          <h3 className="rs-sec-title">Saved data</h3>
          <LiveCard card={coverage.card} />
        </section>
      ) : null}

      <section className="rs-sec">
        <h3 className="rs-sec-title">Every fill case</h3>
        <table className="rs-table">
          <thead>
            <tr>
              <th />
              <th>Trades</th>
              <th>Win rate (95%)</th>
              <th>Mean trade (5-session blocks)</th>
              <th>Net</th>
              <th>Max drawdown</th>
            </tr>
          </thead>
          <tbody>
            {current.cases.map((c) => (
              <CaseRows
                key={c.case.name}
                name={c.case.name}
                slip={c.case.slippageTicks}
                dev={c.development}
                later={c.later}
              />
            ))}
          </tbody>
        </table>
        {fillsLine(current) ? <p className="rs-meta rs-approx">{fillsLine(current)}</p> : null}
      </section>

      <section className="rs-sec">
        <h3 className="rs-sec-title">Interpretation</h3>
        <p className="rs-interp">
          The measurements above are this history&apos;s. What they mean is a reading, kept apart from them.
        </p>
        <button
          type="button"
          className="rs-link"
          onClick={() =>
            askAnalyst(
              `Interpret run ${current.runId} of the study "${study.name}" (research.get_run): separate what was measured, the registered hypothesis, and your interpretation; mention the research budget (${budgetLine(current.budget)}) and whether a placebo or a later period would change the reading.`,
            )
          }
        >
          Ask the analyst to interpret this run
        </button>
      </section>

      <p className="rs-budget">{budgetLine(current.budget)} · every run counts</p>
    </div>
  );
}

function CaseRows({ name, slip, dev, later }: { name: string; slip: number; dev: SplitDigest; later: SplitDigest }) {
  const row = (label: string, s: SplitDigest) => (
    <tr>
      <th scope="row">
        {label === 'Development' ? (
          <span className="rs-case">
            {name} <span className="rs-slip">{slip}t</span>
          </span>
        ) : null}
        <span className="rs-split">{label}</span>
      </th>
      <td className={PRICE_TEXT}>{s.trades}</td>
      <td className={PRICE_TEXT}>{pctCi(s.winRate, s.winRateCi)}</td>
      <td className={cx(PRICE_TEXT, (s.avgTrade ?? 0) > 0 ? 'up' : (s.avgTrade ?? 0) < 0 ? 'down' : undefined)}>
        {moneyCi(s.avgTrade, s.avgTradeCi)}
      </td>
      <td className={cx(PRICE_TEXT, s.netPnl > 0 ? 'up' : s.netPnl < 0 ? 'down' : undefined)}>
        {formatMoney(s.netPnl, { signed: true })}
      </td>
      <td className={PRICE_TEXT}>{formatMoney(s.maxDrawdown)}</td>
    </tr>
  );
  return (
    <>
      {row('Development', dev)}
      {row('Later', later)}
    </>
  );
}
