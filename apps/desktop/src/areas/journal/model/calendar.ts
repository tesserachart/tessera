import type { CalendarDay } from '@tessera/protocol';

export interface GridDay {
  date: string;
  inMonth: boolean;
  cell: CalendarDay | null;
}

export interface GridWeek {
  start: string;
  days: GridDay[];
  net: number;
  trades: number;
  traded: number;
}

function iso(t: Date): string {
  return t.toISOString().slice(0, 10);
}

function at(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + n, 1));
  return iso(t).slice(0, 7);
}

export function monthBounds(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const last = at(`${addMonths(month, 1)}-01`);
  last.setUTCDate(0);
  return { from, to: iso(last) };
}

export function monthGrid(month: string, days: readonly CalendarDay[]): GridWeek[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const { from, to } = monthBounds(month);
  const start = at(from);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const weeks: GridWeek[] = [];
  const cur = new Date(start);
  while (iso(cur) <= to) {
    const week: GridWeek = { start: iso(cur), days: [], net: 0, trades: 0, traded: 0 };
    for (let i = 0; i < 7; i++) {
      const date = iso(cur);
      const cell = byDate.get(date) ?? null;
      const inMonth = date >= from && date <= to;
      week.days.push({ date, inMonth, cell });
      if (cell && inMonth && cell.stats.n > 0) {
        week.net += cell.stats.net;
        week.trades += cell.stats.n;
        week.traded += 1;
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    week.net = Math.round(week.net * 100) / 100;
    weeks.push(week);
  }
  return weeks;
}

export function intensity(net: number, maxAbs: number): 0 | 1 | 2 | 3 | 4 {
  if (!net || maxAbs <= 0) return 0;
  const r = Math.abs(net) / maxAbs;
  if (r < 0.25) return 1;
  if (r < 0.5) return 2;
  if (r < 0.75) return 3;
  return 4;
}

export function maxAbsNet(days: readonly CalendarDay[]): number {
  return days.reduce((m, d) => Math.max(m, Math.abs(d.stats.net)), 0);
}

export function yearColumns(end: string, weeks = 53): GridDay[][] {
  const last = at(end);
  last.setUTCDate(last.getUTCDate() + (6 - ((last.getUTCDay() + 6) % 7)));
  const first = new Date(last);
  first.setUTCDate(first.getUTCDate() - weeks * 7 + 1);
  const cols: GridDay[][] = [];
  const cur = new Date(first);
  for (let w = 0; w < weeks; w++) {
    const col: GridDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = iso(cur);
      col.push({ date, inMonth: date <= end, cell: null });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    cols.push(col);
  }
  return cols;
}

export function monthSummary(days: readonly CalendarDay[], month: string): { net: number; n: number; traded: number } {
  return days.reduce(
    (acc, d) =>
      d.date.startsWith(month) && d.stats.n > 0
        ? { net: acc.net + d.stats.net, n: acc.n + d.stats.n, traded: acc.traded + 1 }
        : acc,
    { net: 0, n: 0, traded: 0 },
  );
}
