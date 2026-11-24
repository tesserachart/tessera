import type { SymbolMonth } from '@tessera/protocol';
import { monthLabel } from './format.ts';

export function symbolSeries(
  rows: readonly SymbolMonth[],
  mode: 'cumulative' | 'monthly',
  max = 8,
): { months: string[]; lines: { key: string; label: string; values: number[] }[] } {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.symbol, (counts.get(r.symbol) ?? 0) + r.n);
  const symbols = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([s]) => s);
  const lines = symbols.map((sym) => {
    const by = new Map(rows.filter((r) => r.symbol === sym).map((r) => [r.month, r.net]));
    let acc = 0;
    const values = months.map((m) => {
      const v = by.get(m) ?? 0;
      acc += v;
      return Math.round((mode === 'cumulative' ? acc : v) * 100) / 100;
    });
    return { key: sym, label: sym, values };
  });
  return { months: months.map((m) => monthLabel(m).replace(/^(\w{3})\w* (\d{4})$/, '$1 $2')), lines };
}
