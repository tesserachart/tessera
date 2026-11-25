import type { AgentSessionSummary, ResearchBudget, RunDigest, Study } from '@tessera/protocol';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Loaded,
  PRICE_TEXT,
  ScrollArea,
  Segmented,
  TextInput,
  Tooltip,
  cx,
  formatMoney,
} from '@tessera/ui';
import { useMemo } from 'react';
import { useAnalyst } from '../../analyst/analystStore.ts';
import { runTool, useTool, valueOf } from '../../app/tools.ts';
import { askAnalyst } from '../../shell/tradeActions.ts';
import { dateIn, displayZone } from '../../state/timeZone.ts';
import { useClock } from '../../app/clock.ts';
import {
  dayWords,
  entrySource,
  entryState,
  entryTotals,
  groupByDay,
  ledgerEntries,
  marketWords,
  matching,
  onShelf,
  pickEntry,
  sourceWords,
  type Entry,
  type Shelf,
} from './ledger.ts';
import { EntryPane } from './RunPane.tsx';
import { SAMPLE_STUDIES, sampleDigest } from './samples.ts';
import { selectStudy, setQuery, setShelf, useResearchView } from './selection.ts';
import './research.css';

const CHANGES = ['research.list_studies', 'research.list_runs', 'research.get_study'];

export function ResearchPage() {
  const studiesRead = useTool('research.list_studies', {});
  const runsRead = useTool('research.list_runs', {});
  const sessions = useAnalyst((s) => s.sessions);
  const studies = valueOf(studiesRead);
  const runs = valueOf(runsRead);
  return (
    <section className="ar-page rs" aria-label="Research">
      <Loaded
        label="Loading research"
        pending={studiesRead.isPending || runsRead.isPending}
        sample={<Station studies={SAMPLE_STUDIES} runs={SAMPLE_RUNS} budgets={[]} sessions={null} sample />}
      >
        {studies && runs ? (
          <Station studies={studies.studies} runs={runs.runs} budgets={studies.budgets} sessions={sessions} />
        ) : null}
      </Loaded>
    </section>
  );
}

const SAMPLE_RUNS: readonly RunDigest[] = SAMPLE_STUDIES.map((s, i) => sampleDigest(s, i));

function Station({
  studies,
  runs,
  budgets,
  sessions,
  sample = false,
}: {
  studies: readonly Study[];
  runs: readonly RunDigest[];
  budgets: readonly ResearchBudget[];
  sessions: readonly AgentSessionSummary[] | null;
  sample?: boolean;
}) {
  const selected = useResearchView((v) => (sample ? null : v.selected));
  const shelf = useResearchView((v) => (sample ? 'active' : v.shelf));
  const query = useResearchView((v) => (sample ? '' : v.query));
  const entries = useMemo(() => ledgerEntries(studies, runs), [studies, runs]);
  const shelved = useMemo(() => onShelf(entries, 'archived').length, [entries]);
  const shown = useMemo(() => matching(onShelf(entries, shelf), query, sessions), [entries, shelf, query, sessions]);
  const current = pickEntry(entries, selected) ?? shown[0] ?? null;
  const trials = budgets.reduce((n, b) => n + b.trials, 0);
  return (
    <>
      <header className="ar-head" data-tauri-drag-region>
        <h1 className="ar-title">Research</h1>
        <span className="rs-ledger">
          {runs.length} {runs.length === 1 ? 'run' : 'runs'} · {trials} {trials === 1 ? 'trial' : 'trials'}
        </span>
      </header>
      {entries.length === 0 ? (
        <div className="rs-none">
          <p>No research yet.</p>
          <Button
            size="s"
            variant="quiet"
            onClick={() =>
              askAnalyst('Research this idea as a study in the research ledger (research.save_study, then run it): ')
            }
          >
            Ask the analyst to test an idea
          </Button>
        </div>
      ) : (
        <div className="rs-station">
          <RunList
            entries={shown}
            current={current}
            sessions={sessions}
            shelf={shelf}
            archived={shelved}
            query={query}
          />
          {current ? (
            <EntryPane key={current.id} entry={current} sessions={sessions} sample={sample} />
          ) : (
            <div className="rs-none">
              <p>Nothing matches.</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function RunList({
  entries,
  current,
  sessions,
  shelf,
  archived,
  query,
}: {
  entries: readonly Entry[];
  current: Entry | null;
  sessions: readonly AgentSessionSummary[] | null;
  shelf: Shelf;
  archived: number;
  query: string;
}) {
  const now = useClock().now();
  const zone = displayZone();
  const today = dateIn(now, zone);
  const groups = groupByDay(entries, zone);
  return (
    <nav className="rs-list" aria-label="Runs">
      <div className="rs-list-tools">
        <TextInput
          className="rs-search"
          type="search"
          placeholder="Search runs"
          aria-label="Search runs"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <Segmented<Shelf>
          label="Shelf"
          className="rs-shelf"
          value={shelf}
          onChange={setShelf}
          options={[
            { value: 'active', label: 'Runs' },
            { value: 'archived', label: archived ? `Archived · ${String(archived)}` : 'Archived' },
          ]}
        />
      </div>
      <ScrollArea className="rs-list-scroll">
        {entries.length === 0 ? (
          <p className="rs-quiet">{shelf === 'archived' ? 'Nothing archived.' : 'Nothing matches.'}</p>
        ) : null}
        {groups.map((g) => (
          <section key={g.day ?? 'unrun'} aria-label={dayWords(g.day, today)}>
            <h2 className="rs-day">{dayWords(g.day, today)}</h2>
            {g.entries.map((e) => (
              <Row key={e.id} entry={e} on={current?.id === e.id} sessions={sessions} />
            ))}
          </section>
        ))}
      </ScrollArea>
    </nav>
  );
}

function Row({ entry, on, sessions }: { entry: Entry; on: boolean; sessions: readonly AgentSessionSummary[] | null }) {
  const state = entryState(entry);
  const totals = entryTotals(entry);
  const source = sourceWords(entrySource(entry, sessions));
  const run = entry.kind === 'run' ? entry.run : null;
  const row = (
    <button
      type="button"
      className={cx('rs-row', on && 'is-on')}
      aria-current={on ? 'true' : undefined}
      onClick={() => selectStudy(entry.id)}
    >
      <span className="rs-row-name">{entry.study.name}</span>
      <span className="rs-row-state" data-verdict={state.verdict}>
        {state.word}
      </span>
      <span className="rs-row-sub">
        {marketWords(entry.study)}
        {totals ? ` · ${String(totals.trades)} trades` : ''} ·{' '}
        <Tooltip content={source}>
          <span className="rs-row-chat">{source}</span>
        </Tooltip>
      </span>
      {totals ? (
        <span className={cx('rs-row-net', PRICE_TEXT, totals.net > 0 ? 'up' : totals.net < 0 ? 'down' : undefined)}>
          {formatMoney(totals.net, { signed: true })}
        </span>
      ) : null}
    </button>
  );
  if (!run) return row;
  const archived = run.archivedAt !== null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() =>
            void runTool('research.archive_run', { runId: run.runId, archived: !archived }, { refresh: CHANGES })
          }
        >
          {archived ? 'Restore' : 'Archive'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
