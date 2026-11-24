import type { JournalView, TradeSortKey } from '@tessera/protocol';

import { analystStore, selectSession } from '../analyst/analystStore.ts';
import { select, pageStore } from '../areas/indicators/model.ts';
import { customIndicator } from '../indicators/custom.ts';
import {
  JOURNAL_SECTIONS,
  journalUiStore,
  REPORT_TABS,
  setJournal,
  type JournalSection,
  type JournalUi,
  type ReportTab,
} from '../areas/journal/store.ts';
import { RANGES, type RangeKey } from '../areas/journal/model/scope.ts';
import { selectStudy, researchViewStore } from '../areas/research/selection.ts';
import { placeSettings } from '../areas/settings/store.ts';
import { currentPlace, placeView, readPlace, setMarketsPlace, marketsUiStore } from '../areas/markets/store.ts';
import { uiStore } from './ui.ts';
import { read, watch } from '../app/store.ts';

export interface AreaView {
  settings?: string;
  agents?: string;
  indicators?: string;
  research?: string;
  journal?: StoredJournalView;
  markets?: ReturnType<typeof placeView>;
}

type StoredJournalView = Omit<JournalView, 'tradeId' | 'date' | 'setupId'> & {
  tradeId: string | null;
  date: string | null;
  setupId: string | null;
};

function journalViewOf(j: JournalUi): StoredJournalView {
  return {
    section: j.section,
    tradeId: j.trade,
    date: j.day,
    setupId: j.setup,
    reportTab: j.reportTab,
    groupBy: j.groupBy,
    account: j.scope.account,
    range: j.scope.range,
    filter: j.filter,
    sort: j.sort,
    ascending: j.ascending,
  };
}

export function currentView(): AreaView {
  const view: AreaView = {
    settings: read(uiStore).settingsSection,
    journal: journalViewOf(read(journalUiStore)),
    markets: placeView(currentPlace()),
  };
  const session = read(analystStore).selected;
  if (session) view.agents = session;
  const sel = read(pageStore).selection;
  if (sel?.kind === 'custom') view.indicators = sel.id;
  else if (sel?.kind === 'builtin') view.indicators = sel.key;
  const study = read(researchViewStore);
  if (study.selected && !study.fresh) view.research = study.selected;
  return view;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function journalPatch(v: unknown, now: JournalUi): Partial<JournalUi> {
  if (!isObject(v)) return {};
  const out: Partial<JournalUi> = {};
  if (JOURNAL_SECTIONS.includes(v.section as JournalSection)) out.section = v.section as JournalSection;
  if (v.tradeId === null || typeof v.tradeId === 'string') out.trade = v.tradeId;
  if (v.date === null || typeof v.date === 'string') out.day = v.date;
  if (v.setupId === null || typeof v.setupId === 'string') out.setup = v.setupId;
  if (REPORT_TABS.includes(v.reportTab as ReportTab)) out.reportTab = v.reportTab as ReportTab;
  if (typeof v.groupBy === 'string' && v.groupBy) out.groupBy = v.groupBy;
  const account = typeof v.account === 'string' && v.account ? v.account : null;
  const range = RANGES.some((r) => r.value === v.range) ? (v.range as RangeKey) : null;
  if (account || range) out.scope = { account: account ?? now.scope.account, range: range ?? now.scope.range };
  if (isObject(v.filter)) out.filter = v.filter;
  if (typeof v.sort === 'string' && v.sort) out.sort = v.sort as TradeSortKey;
  if (typeof v.ascending === 'boolean') out.ascending = v.ascending;
  return out;
}

export function applyView(v: unknown): void {
  if (!isObject(v)) return;
  const now = currentView();
  if (typeof v.settings === 'string' && v.settings && v.settings !== now.settings) placeSettings(v.settings);
  if (typeof v.agents === 'string' && v.agents && v.agents !== now.agents) {
    const known = read(analystStore).sessions?.some((s) => s.id === v.agents) ?? false;
    if (known) selectSession(v.agents);
  }
  if (typeof v.indicators === 'string' && v.indicators && v.indicators !== now.indicators)
    select(
      customIndicator(v.indicators) ? { kind: 'custom', id: v.indicators } : { kind: 'builtin', key: v.indicators },
    );
  if (typeof v.research === 'string' && v.research && v.research !== now.research) selectStudy(v.research);
  if (isObject(v.journal)) {
    const patch = journalPatch(v.journal, read(journalUiStore));
    if (Object.keys(patch).length > 0) setJournal(patch);
  }
  if (isObject(v.markets)) {
    const now = placeView(currentPlace());
    const patch = Object.fromEntries(
      Object.entries(readPlace(v.markets)).filter(([k, x]) => JSON.stringify(x) !== JSON.stringify(now[k])),
    );
    if (Object.keys(patch).length > 0) setMarketsPlace(patch);
  }
}

export function onViewChange(cb: () => void): () => void {
  const offs = [
    watch(journalUiStore, cb),
    watch(analystStore, (s, prev) => {
      if (s.selected !== prev.selected) cb();
    }),
    watch(pageStore, (s, prev) => {
      if (s.selection !== prev.selection) cb();
    }),
    watch(researchViewStore, cb),
    watch(marketsUiStore, cb),
  ];
  return () => {
    for (const off of offs) off();
  };
}
