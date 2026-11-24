import type { TradeFilter, TradeSortKey } from '@tessera/protocol';
import * as Contract from '@tessera/protocol/schemas';
import { z } from 'zod';
import { patch, makeStore, type Persist, useStore } from '../../app/store.ts';
import { ALL_ACCOUNTS, RANGES, type RangeKey, type Scope } from './model/scope.ts';
import { COLUMNS, type ColumnId } from './model/table.ts';

export type JournalSection = 'overview' | 'trades' | 'days' | 'reports' | 'playbooks' | 'import' | 'settings';

export const JOURNAL_SECTIONS: readonly JournalSection[] = [
  'overview',
  'trades',
  'days',
  'reports',
  'playbooks',
  'import',
  'settings',
];

export type ReportTab = 'overview' | 'time' | 'risk' | 'symbols' | 'behaviour' | 'breakdowns';

export const REPORT_TABS: readonly ReportTab[] = ['overview', 'time', 'risk', 'symbols', 'behaviour', 'breakdowns'];

export interface JournalUi {
  section: JournalSection;
  scope: Scope;
  filter: TradeFilter;
  sort: TradeSortKey;
  ascending: boolean;
  hidden: ColumnId[];
  shown: ColumnId[];
  trade: string | null;
  day: string | null;
  setup: string | null;
  reportTab: ReportTab;
  groupBy: string;
}

const initial: JournalUi = {
  section: 'overview',
  scope: { account: ALL_ACCOUNTS, range: 'all' },
  filter: {},
  sort: 'opened',
  ascending: false,
  hidden: [],
  shown: [],
  trade: null,
  day: null,
  setup: null,
  reportTab: 'overview',
  groupBy: 'symbol',
};

const Columns = z.array(z.enum(COLUMNS.map((c) => c.id)));

const PERSISTED: Persist<JournalUi>['fields'] = {
  section: z.enum(JOURNAL_SECTIONS),
  scope: z.object({ account: z.string(), range: z.enum(RANGES.map((r) => r.value)) }),
  filter: Contract.TradeFilter,
  sort: Contract.TradeSortKey,
  ascending: z.boolean(),
  hidden: Columns,
  shown: Columns,
  reportTab: z.enum(REPORT_TABS),
  groupBy: z.string(),
};

export const journalUiStore = makeStore<JournalUi>(initial, {
  persist: { key: 'tessera.journal', version: 1, fields: PERSISTED },
});

export const useJournalUi = <T>(pick: (s: JournalUi) => T): T => useStore(journalUiStore, pick);

export function setJournal(change: Partial<JournalUi>): void {
  patch(journalUiStore, change);
}

export function openTrade(id: string): void {
  setJournal({ section: 'trades', trade: id });
}

export function openDay(date: string | null): void {
  setJournal({ section: 'days', day: date });
}

export function setRange(range: RangeKey): void {
  patch(journalUiStore, (s) => ({ scope: { ...s.scope, range } }));
}

export function setAccount(account: string): void {
  patch(journalUiStore, (s) => ({ scope: { ...s.scope, account } }));
}
