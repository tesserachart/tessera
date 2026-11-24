import { useQueries } from '@tanstack/react-query';
import type { ContractSpec, PullEstimate } from '@tessera/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { everConnectedStore } from '../../app/connection.ts';
import { queryClient } from '../../app/queries.ts';
import { useServer } from '../../app/runtimeContext.ts';
import { patch, useStore } from '../../app/store.ts';
import { peekTool, toolQuery, useHasTool, useToolValue } from '../../app/tools.ts';
import { isReplay } from '../../market/instruments.ts';
import { useWatchlists } from '../../markets/watchlists.ts';
import { useLayouts } from '../../state/layouts.ts';
import { useUi } from '../../state/ui.ts';
import {
  FOLLOWS_DESK,
  HISTORY_REFRESH_MS,
  checkedInputs,
  deskRoots,
  historyProgress,
  historyStore,
  isKnown,
  isOpen,
  marketName,
  offerMarkets,
  offerRows,
  requestsOf,
  toggled,
  type OfferRow,
  type Selection,
} from './history.ts';
import { act, EVERY_PULL } from './pullTools.ts';
import { pullsRefreshEvery } from './savedTrades.ts';

const SPEC_KEPT = { keepFor: Infinity };

function useDeskRoots(): string[] {
  const picked = useUi((s) => s.workspace);
  const fallback = useServer()?.defaultLayoutId ?? 'default';
  const charts = useLayouts((s) => s.layouts[picked ?? fallback]?.charts);
  const instruments = useMemo(
    () => [...new Set(Object.values(charts ?? {}).map((c) => c.instrument))].filter((i) => !isReplay(i)),
    [charts],
  );
  const has = useHasTool('market.get_contract_spec');
  const connected = useStore(everConnectedStore);
  const specs = useQueries(
    {
      queries: instruments.map((instrument) => ({
        ...toolQuery('market.get_contract_spec', { instrument }, SPEC_KEPT),
        enabled: has && connected,
      })),
    },
    queryClient,
  );
  return deskRoots(
    instruments,
    specs.map((q): Pick<ContractSpec, 'instrument' | 'root'> | null => q.data?.spec ?? null),
  );
}

export interface HistoryOffer {
  rows: OfferRow[];
  checked: ReadonlySet<string>;
  ready: boolean;
  starting: boolean;
  failed: string | null;
  toggle: (input: string) => void;
  start: () => Promise<boolean>;
}

export function useHistoryOffer(): HistoryOffer {
  const desk = useDeskRoots();
  const lists = useWatchlists((s) => s.value);
  const inputs = useMemo(
    () =>
      offerMarkets(
        desk,
        lists.lists.flatMap((l) => l.symbols),
      ),
    [desk, lists],
  );
  const has = useHasTool('market.estimate_pull');
  const connected = useStore(everConnectedStore);
  const reads = useQueries(
    {
      queries: inputs.map((instrument) => ({
        ...toolQuery('market.estimate_pull', { instrument }, { keepFor: 30_000 }),
        enabled: has && connected,
      })),
    },
    queryClient,
  );
  const answers = new Map<string, PullEstimate>();
  inputs.forEach((input, i) => {
    const estimate = reads[i]?.data;
    if (estimate) answers.set(input, estimate);
  });
  const listsPulls = useHasTool('market.list_pulls');
  const pulls = useToolValue('market.list_pulls', listsPulls ? EVERY_PULL : null, { keepFor: 10_000 })?.pulls;
  const running = new Set((pulls ?? []).filter((p) => p.state === 'running').map((p) => p.id));
  const rows = offerRows(inputs, answers, running);
  const ready = has && reads.every((q) => !q.isPending);
  const [selection, setSelection] = useState<Selection>(FOLLOWS_DESK);
  const checked = checkedInputs(rows, desk, selection);
  const unknown = rows.filter((r) => isOpen(r) && !isKnown(r.estimate)).map((r) => r.input);
  useQueries(
    {
      queries: unknown.map((instrument) => ({
        ...toolQuery('market.estimate_pull', { instrument }, { keepFor: 30_000, refreshEvery: HISTORY_REFRESH_MS }),
        enabled: true,
      })),
    },
    queryClient,
  );
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const toggle = (input: string) => setSelection((s) => toggled(rows, desk, s, input));
  const start = async (): Promise<boolean> => {
    setStarting(true);
    setFailed(null);
    const picked = rows.filter((r) => checked.has(r.input));
    const asked = requestsOf(rows, checked);
    const outcomes = await Promise.all(asked.map((request) => act('market.pull_trades', request)));
    const at = outcomes.findIndex((o) => o !== null);
    const problem = at < 0 ? null : `${marketName(picked[at]!.estimate)}: ${outcomes[at]!}`;
    setFailed(problem);
    setStarting(false);
    return problem === null;
  };
  return { rows, checked, ready, starting, failed, toggle, start };
}

export function useHistoryProgress() {
  const has = useHasTool('market.list_pulls');
  const every = pullsRefreshEvery(peekTool('market.list_pulls', EVERY_PULL)?.pulls, true);
  const pulls = useToolValue('market.list_pulls', has ? EVERY_PULL : null, {
    keepFor: 10_000,
    refreshEvery: every,
  })?.pulls;
  const seen = useStore(historyStore, (s) => s.ran);
  useEffect(() => {
    const running = (pulls ?? []).filter((p) => p.state === 'running').map((p) => p.id);
    patch(historyStore, (s) => {
      const fresh = running.filter((id) => !s.ran.includes(id));
      return fresh.length > 0 ? { ran: [...s.ran, ...fresh] } : {};
    });
  }, [pulls]);
  const acknowledge = useCallback(() => patch(historyStore, { ran: [] }), []);
  return { progress: historyProgress(pulls ?? [], seen), acknowledge };
}
