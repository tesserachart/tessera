import type { JournalTrade, TradeSortKey } from '@tessera/protocol';

export type ColumnId =
  | 'symbol'
  | 'side'
  | 'entry'
  | 'exit'
  | 'qty'
  | 'net'
  | 'r'
  | 'result'
  | 'setup'
  | 'rating'
  | 'reviewed'
  | 'hold'
  | 'tags'
  | 'account'
  | 'fees'
  | 'mae';

export interface Column {
  id: ColumnId;
  label: string;
  align: 'left' | 'right';
  sort?: TradeSortKey;
  visible: boolean;
  fixed?: boolean;
}

export const COLUMNS: readonly Column[] = [
  { id: 'symbol', label: 'Symbol', align: 'left', sort: 'symbol', visible: true, fixed: true },
  { id: 'side', label: 'Side', align: 'left', sort: 'side', visible: true },
  { id: 'entry', label: 'Entry', align: 'left', sort: 'opened', visible: true },
  { id: 'exit', label: 'Exit', align: 'left', sort: 'closed', visible: true },
  { id: 'qty', label: 'Size', align: 'right', sort: 'qty', visible: true },
  { id: 'net', label: 'P&L', align: 'right', sort: 'pnl', visible: true, fixed: true },
  { id: 'r', label: 'R', align: 'right', sort: 'r', visible: true },
  { id: 'result', label: 'Result', align: 'left', visible: true },
  { id: 'setup', label: 'Setup', align: 'left', sort: 'setup', visible: true },
  { id: 'rating', label: 'Rating', align: 'left', sort: 'rating', visible: true },
  { id: 'reviewed', label: 'Reviewed', align: 'left', visible: true },
  { id: 'hold', label: 'Duration', align: 'right', sort: 'hold', visible: false },
  { id: 'tags', label: 'Tags', align: 'left', visible: false },
  { id: 'account', label: 'Account', align: 'left', sort: 'account', visible: false },
  { id: 'fees', label: 'Fees', align: 'right', sort: 'fees', visible: false },
  { id: 'mae', label: 'MAE · MFE', align: 'right', visible: false },
];

export function shownColumns(hidden: readonly ColumnId[], shown: readonly ColumnId[]): Column[] {
  return COLUMNS.filter((c) => (c.fixed ?? false) || (c.visible ? !hidden.includes(c.id) : shown.includes(c.id)));
}

export interface DayGroup {
  date: string;
  trades: JournalTrade[];
  net: number;
  n: number;
  wins: number;
  losses: number;
}

export function groupByDay(trades: readonly JournalTrade[]): DayGroup[] {
  const out: DayGroup[] = [];
  for (const t of trades) {
    let g = out[out.length - 1];
    if (g?.date !== t.tradeDate) {
      g = { date: t.tradeDate, trades: [], net: 0, n: 0, wins: 0, losses: 0 };
      out.push(g);
    }
    g.trades.push(t);
    if (t.status === 'closed') {
      g.n += 1;
      g.net = Math.round((g.net + t.netPnl) * 100) / 100;
      if (t.outcome === 'win') g.wins += 1;
      if (t.outcome === 'loss') g.losses += 1;
    }
  }
  return out;
}

export interface DeletePicks {
  ids: string[];
  brokerCount: number;
}

export function deletePicks(trades: readonly JournalTrade[], picked: ReadonlySet<string>): DeletePicks {
  const ids: string[] = [];
  let brokerCount = 0;
  for (const t of trades) {
    if (!picked.has(t.id)) continue;
    if (t.origin === 'broker') brokerCount += 1;
    else ids.push(t.id);
  }
  return { ids, brokerCount };
}

export function stepRow(ids: readonly string[], id: string | null, step: 1 | -1): string | null {
  if (!ids.length) return null;
  if (id === null) return step === 1 ? ids[0]! : ids[ids.length - 1]!;
  const i = ids.indexOf(id);
  if (i < 0) return ids[0]!;
  return ids[Math.min(ids.length - 1, Math.max(0, i + step))]!;
}
