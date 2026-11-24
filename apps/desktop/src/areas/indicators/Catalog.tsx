import type { CustomIndicator, IndicatorSpec } from '@tessera/protocol';
import { ScrollArea, SearchField, cx } from '@tessera/ui';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { INDICATOR_GROUPS, searchIndicators } from '../../chart/settings/catalog.ts';
import { onChartWords, select, type Selection } from './model.ts';

interface Row {
  selection: Exclude<Selection, null>;
  key: string;
  title: string;
  meta: string;
}

function isSelected(row: Row, selection: Selection): boolean {
  if (!selection) return false;
  if (selection.kind === 'builtin' && row.selection.kind === 'builtin') return selection.key === row.selection.key;
  if (selection.kind === 'custom' && row.selection.kind === 'custom') return selection.id === row.selection.id;
  return selection.kind === 'new' && row.selection.kind === 'new';
}

export function Catalog({
  builtins,
  custom,
  selection,
  drafting,
  onChart,
}: {
  builtins: readonly IndicatorSpec[];
  custom: readonly CustomIndicator[];
  selection: Selection;
  drafting: boolean;
  onChart: ReadonlyMap<string, number>;
}) {
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const q = query.trim();
    const bySpec = new Map<IndicatorSpec, CustomIndicator>(custom.map((c) => [c.spec, c]));
    const found = new Set(q ? searchIndicators(q, [...custom.map((c) => c.spec), ...builtins]) : null);
    const keep = (s: IndicatorSpec) => !q || found.has(s);
    const yours: Row[] = [
      ...(drafting && !q
        ? [{ selection: { kind: 'new' as const }, key: 'new', title: 'New indicator', meta: 'not saved' }]
        : []),
      ...custom
        .filter((c) => keep(c.spec))
        .map((c) => ({
          selection: { kind: 'custom' as const, id: c.id },
          key: c.id,
          title: c.spec.title,
          meta: `v${String(c.latest)}`,
        })),
    ];
    const out: { label: string; rows: Row[] }[] = [];
    if (yours.length > 0) out.push({ label: 'Yours', rows: yours });
    for (const g of INDICATOR_GROUPS) {
      if (g.group === 'custom') continue;
      const rows = builtins
        .filter((s) => s.group === g.group && keep(s) && !bySpec.has(s))
        .map((s) => ({
          selection: { kind: 'builtin' as const, key: s.kind },
          key: s.kind,
          title: s.title,
          meta: s.short,
        }));
      if (rows.length > 0) out.push({ label: g.label, rows });
    }
    return out;
  }, [builtins, custom, query, drafting]);
  const rows = groups.flatMap((g) => g.rows);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = rows.findIndex((r) => isSelected(r, selection));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    select(next.selection);
    list.current?.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <aside className="ia-cat" aria-label="Indicators" onKeyDown={onKeyDown}>
      <SearchField
        className="ia-cat-search"
        label="Search indicators"
        placeholder="Search indicators"
        value={query}
        onValueChange={setQuery}
      />
      <ScrollArea className="ia-cat-scroll" viewportRef={list}>
        {groups.map((g) => (
          <div key={g.label} className="ia-cat-group" role="group" aria-label={g.label}>
            <div className="ia-cat-label">{g.label}</div>
            {g.rows.map((r) => (
              <button
                key={r.key}
                type="button"
                data-key={r.key}
                className={cx('ia-cat-row', isSelected(r, selection) && 'is-on')}
                aria-current={isSelected(r, selection) ? 'true' : undefined}
                onClick={() => select(r.selection)}
              >
                <span className="ttl">{r.title}</span>
                <span className="meta">{r.meta}</span>
                <span className="on">{onChartWords(onChart.get(r.key) ?? 0)}</span>
              </button>
            ))}
          </div>
        ))}
        {rows.length === 0 ? <p className="ia-cat-none">Nothing matches “{query.trim()}”</p> : null}
      </ScrollArea>
    </aside>
  );
}
