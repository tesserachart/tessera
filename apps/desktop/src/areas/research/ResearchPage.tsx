import type { SaveStudyInput, Study } from '@tessera/protocol';
import { Button, Loaded, SampleSkeleton, ScrollArea, Tooltip, cx } from '@tessera/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { selectStudy, startStudy, useResearchView, researchViewStore } from './selection.ts';
import { useTool, useToolAction, useToolValue, valueOf } from '../../app/tools.ts';
import { displaySymbol } from '../../market/instruments.ts';
import { askAnalyst } from '../../shell/tradeActions.ts';
import { displayZone } from '../../state/timeZone.ts';
import { useActiveChart } from '../../state/workspace.ts';
import { blankStudy, dataWords, stateWord, studyInput, studyProblem } from './model.ts';
import { RunSample, RunView } from './RunView.tsx';
import { SAMPLE_DIGEST, SAMPLE_STUDIES } from './samples.ts';
import { StudyForm, StudyFormView } from './StudyForm.tsx';
import { patch } from '../../app/store.ts';
import { StudyInTrade } from './StudyInTrade.tsx';
import './research.css';

export function ResearchPage() {
  const list = useTool('research.list_studies', {});
  const studies = valueOf(list)?.studies ?? [];
  const budgets = valueOf(list)?.budgets ?? [];
  const selected = useResearchView((v) => v.selected);
  const fresh = useResearchView((v) => v.fresh);
  const setSelected = selectStudy;
  const setFresh = (on: boolean) => (on ? startStudy() : patch(researchViewStore, { fresh: false }));
  const current = fresh ? null : (studies.find((s) => s.id === selected) ?? studies[0] ?? null);
  const trials = budgets.reduce((n, b) => n + b.trials, 0);
  return (
    <section className="ar-page rs" aria-label="Research">
      <Loaded label="Loading studies" pending={list.isPending} sample={<ResearchSample />}>
        <ResearchHead studies={studies.length} trials={trials} onNew={() => setFresh(true)} />
        <div className="rs-body">
          <StudyList
            studies={studies}
            current={current}
            onPick={(s) => {
              setFresh(false);
              setSelected(s.id);
            }}
          />
          {fresh || current ? (
            <StudyPane
              key={fresh ? 'new' : `${current!.id}:${String(current!.generation)}:${current!.state}`}
              study={fresh ? null : current}
              onSaved={(s) => {
                setFresh(false);
                setSelected(s.id);
              }}
              onDeleted={() => setSelected(null)}
            />
          ) : (
            <div className="rs-unselected" />
          )}
        </div>
      </Loaded>
    </section>
  );
}

function ResearchHead({ studies, trials, onNew }: { studies: number; trials: number; onNew: () => void }) {
  return (
    <header className="ar-head" data-tauri-drag-region>
      <h1 className="ar-title">Research</h1>
      <span className="rs-ledger">
        {studies} {studies === 1 ? 'study' : 'studies'} · {trials} {trials === 1 ? 'trial' : 'trials'}
      </span>
      <span className="rs-fill" />
      <Button size="s" variant="primary" onClick={onNew}>
        New study
      </Button>
    </header>
  );
}

function StudyList({
  studies,
  current,
  onPick,
}: {
  studies: readonly Study[];
  current: Study | null;
  onPick: (s: Study) => void;
}) {
  return (
    <nav className="rs-list" aria-label="Studies">
      <ScrollArea className="rs-list-scroll">
        {studies.length === 0 ? <p className="rs-empty">No studies yet.</p> : null}
        {studies.map((s) => (
          <button
            key={s.id}
            type="button"
            className={cx('rs-row', current?.id === s.id && 'is-on')}
            aria-current={current?.id === s.id ? 'true' : undefined}
            onClick={() => onPick(s)}
          >
            <span className="rs-row-name">{s.name}</span>
            <span className="rs-row-sub">
              {displaySymbol(s.data.instrument)} · {s.data.tf}
            </span>
            <span className="rs-row-state" data-verdict={verdictOf(s)}>
              {stateWord(s)}
            </span>
          </button>
        ))}
      </ScrollArea>
    </nav>
  );
}

const verdictOf = (s: Study) => (s.state === 'draft' ? 'draft' : (s.lastVerdict ?? 'frozen'));

const ignore = () => undefined;

function ResearchSample() {
  const first = SAMPLE_STUDIES[0]!;
  return (
    <>
      <ResearchHead studies={SAMPLE_STUDIES.length} trials={6} onNew={ignore} />
      <div className="rs-body">
        <StudyList studies={SAMPLE_STUDIES} current={first} onPick={ignore} />
        <StudySample study={first} />
      </div>
    </>
  );
}

interface StudyPaneProps {
  study: Study | null;
  onSaved: (s: Study) => void;
  onDeleted: () => void;
}

function StudyPane(props: StudyPaneProps) {
  return (
    <Loaded label="Loading the study" sample={<StudySample study={props.study} />}>
      <StudyBody {...props} />
    </Loaded>
  );
}

interface StudyFrameProps {
  verdict: string;
  state: string;
  hash: ReactNode;
  actions: ReactNode;
  form: ReactNode;
  foot: ReactNode;
  error: ReactNode;
  results: ReactNode;
}

function StudyFrame({ verdict, state, hash, actions, form, foot, error, results }: StudyFrameProps) {
  return (
    <div className="rs-study">
      <div className="rs-proto">
        <div className="rs-proto-head">
          <div className="rs-proto-title">
            <span className="rs-state" data-verdict={verdict}>
              {state}
            </span>
            {hash}
          </div>
          <div className="rs-actions">{actions}</div>
        </div>
        <ScrollArea className="rs-proto-scroll">
          {form}
          <div className="rs-proto-foot">{foot}</div>
        </ScrollArea>
        {error}
      </div>
      <div className="rs-results">{results}</div>
    </div>
  );
}

function NoRun({ data, running }: { data: string; running: boolean }) {
  return (
    <div className="rs-noresult">
      {running ? (
        <SampleSkeleton label="Running the study">
          <RunSample digest={SAMPLE_DIGEST} runs={[SAMPLE_DIGEST]} study={SAMPLE_STUDIES[0]!} symbol="NQ" />
        </SampleSkeleton>
      ) : (
        <p>No run yet.</p>
      )}
      <p className="rs-data">{data}</p>
    </div>
  );
}

function StudySample({ study }: { study: Study | null }) {
  const draft = study ? studyInput(study) : blankStudy('NQ');
  const symbol = displaySymbol(draft.data.instrument);
  return (
    <StudyFrame
      verdict={study ? verdictOf(study) : 'draft'}
      state={study ? stateWord(study) : 'New'}
      hash={null}
      actions={
        <>
          <Button size="s">Save</Button>
          <Button size="s">Freeze</Button>
          <Button size="s" variant="primary">
            Run exploratory
          </Button>
        </>
      }
      form={<StudyFormView value={draft} onChange={ignore} stored={[]} zone={displayZone()} />}
      foot={
        <Button size="s" variant="quiet">
          {study ? 'Ask the analyst to review it' : 'Ask the analyst to research an idea'}
        </Button>
      }
      error={null}
      results={
        study?.lastVerdict ? (
          <RunSample digest={SAMPLE_DIGEST} runs={[SAMPLE_DIGEST]} study={study} symbol={symbol} />
        ) : (
          <NoRun data={dataWords(draft.data, symbol)} running={false} />
        )
      }
    />
  );
}

function StudyBody({ study, onSaved, onDeleted }: StudyPaneProps) {
  const chart = useActiveChart();
  const [draft, setDraft] = useState<SaveStudyInput>(() =>
    study ? studyInput(study) : blankStudy(chart?.instrument ?? 'NQ'),
  );
  const [error, setError] = useState<string | null>(null);
  const changes = { refresh: ['research.list_studies', 'research.get_study'] };
  const save = useToolAction('research.save_study', changes);
  const freeze = useToolAction('research.freeze_study', changes);
  const run = useToolAction('research.run_study', changes, study ? { id: study.id } : null);
  const remove = useToolAction('research.delete_study', changes);
  const detail = useToolValue('research.get_study', study ? { id: study.id } : null);
  const runs = detail?.runs ?? [];
  const latest = runs[0] ?? null;
  const frozen = study !== null && study.state !== 'draft';
  const changed = useMemo(
    () => study === null || JSON.stringify(studyInput(study)) !== JSON.stringify(draft),
    [study, draft],
  );
  const problem = studyProblem(draft);
  const busy = save.pending || freeze.pending || run.pending;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const saveNow = async (): Promise<Study | null> => {
    setError(null);
    try {
      const s = await save.run(draft);
      onSaved(s);
      return s;
    } catch (e) {
      fail(e);
      return null;
    }
  };
  const runNow = async () => {
    setError(null);
    const s = changed ? await saveNow() : study;
    if (!s) return;
    try {
      await run.run({ id: s.id });
    } catch (e) {
      fail(e);
    }
  };
  const freezeNow = async () => {
    setError(null);
    const s = changed ? await saveNow() : study;
    if (!s) return;
    try {
      onSaved(await freeze.run({ id: s.id }));
    } catch (e) {
      fail(e);
    }
  };

  const symbol = displaySymbol(draft.data.instrument);
  return (
    <StudyFrame
      verdict={study ? verdictOf(study) : 'draft'}
      state={study ? stateWord(study) : 'New'}
      hash={
        study?.manifestHash ? (
          <Tooltip content={`Frozen as ${study.manifestHash}`}>
            <span className="rs-hash">{study.manifestHash.slice(0, 8)}</span>
          </Tooltip>
        ) : null
      }
      actions={
        <>
          {!frozen || changed ? (
            <Button size="s" disabled={busy || problem !== null || !changed} onClick={() => void saveNow()}>
              {frozen ? 'Save as next generation' : 'Save'}
            </Button>
          ) : null}
          {!frozen ? (
            <Button size="s" disabled={busy || problem !== null} onClick={() => void freezeNow()}>
              Freeze
            </Button>
          ) : null}
          <Button size="s" variant="primary" disabled={busy || problem !== null} onClick={() => void runNow()}>
            {run.pending ? 'Running…' : frozen && !changed ? 'Run' : 'Run exploratory'}
          </Button>
        </>
      }
      form={<StudyForm value={draft} onChange={setDraft} />}
      foot={
        <>
          {study ? (
            <Button
              size="s"
              variant="quiet"
              onClick={() =>
                askAnalyst(
                  `Review the study "${study.name}" (research.get_study id ${study.id}): is the hypothesis testable as registered, what would a placebo or a stricter gate show, and what should the next generation change? Keep measured results apart from your interpretation.`,
                )
              }
            >
              Ask the analyst to review it
            </Button>
          ) : (
            <Button
              size="s"
              variant="quiet"
              onClick={() =>
                askAnalyst(
                  `Research this idea as a study in the research ledger (research.save_study, then run it): ${draft.hypothesis || '…'}`,
                )
              }
            >
              Ask the analyst to research an idea
            </Button>
          )}
          {study ? <StudyInTrade study={study} /> : null}
          {study ? (
            <Button
              size="s"
              variant="destructive"
              what={study.name}
              disabled={busy}
              onClick={() => {
                void remove.run({ id: study.id }).then(() => {
                  onDeleted();
                }, fail);
              }}
            >
              Delete
            </Button>
          ) : null}
        </>
      }
      error={
        (error ?? (problem && changed)) ? (
          <p className="rs-error" data-selectable>
            {error ?? problem}
          </p>
        ) : null
      }
      results={
        latest && study ? (
          <RunView run={latest} runs={runs} study={study} symbol={symbol} />
        ) : (
          <NoRun data={dataWords(draft.data, symbol)} running={run.pending} />
        )
      }
    />
  );
}
