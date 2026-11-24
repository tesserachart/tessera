import { INDICATOR_SPECS, type ChartLayer, type IndicatorSpec } from '@tessera/protocol';
import { Dialog, DialogContent, Icon, Key, cx } from '@tessera/ui';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { customRef, useCustomIndicators } from '../../indicators/custom.ts';
import { focusPastClosingMenu } from '../focus.ts';
import { openConnections } from '../../accounts/navigate.ts';
import { addCustomToChart, addToChart } from './actions.ts';
import { requirementWords, useUnavailableKinds } from './availability.ts';
import { catalogGroups, searchIndicators } from './catalog.ts';
import { isChart, useIndicatorUi, type ChartRef, closeAdd } from './store.ts';

export function AddIndicatorDialog({ chart, layers }: { chart: ChartRef; layers: readonly ChartLayer[] }) {
  const open = useIndicatorUi((s) => isChart(s.adding, chart));
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : closeAdd())}>
      <DialogContent title="Add indicator" hideTitle className="ind-add" onKeyDown={(e) => e.stopPropagation()}>
        {open ? <AddIndicatorPanel chart={chart} layers={layers} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddIndicatorPanel({ chart, layers }: { chart: ChartRef; layers: readonly ChartLayer[] }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [added, setAdded] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== '';
  const custom = useCustomIndicators();
  const { specs, keyOf } = useMemo(() => {
    const keys = new Map<IndicatorSpec, string>();
    for (const c of custom) keys.set(c.spec, c.id);
    for (const s of INDICATOR_SPECS) keys.set(s, s.kind);
    return {
      specs: [...custom.map((c) => c.spec), ...INDICATOR_SPECS],
      keyOf: (s: IndicatorSpec) => keys.get(s) ?? s.kind,
    };
  }, [custom]);
  const groups = searching ? null : catalogGroups(specs);
  const hits: IndicatorSpec[] = groups ? groups.flatMap((g) => g.specs) : searchIndicators(query, specs);
  const index = Math.min(sel, Math.max(0, hits.length - 1));
  useEffect(() => focusPastClosingMenu(() => input.current?.focus()), []);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  const onChart = (spec: IndicatorSpec) =>
    spec.kind === 'custom'
      ? layers.filter((l) => l.kind === 'custom' && customRef(l.params) === keyOf(spec)).length
      : layers.filter((l) => l.kind === spec.kind).length;
  const unavailable = useUnavailableKinds(chart, true);

  const add = (spec: IndicatorSpec | undefined, stay: boolean) => {
    if (!spec || unavailable.has(spec.kind)) return;
    if (spec.kind === 'custom') addCustomToChart(chart, keyOf(spec));
    else addToChart(chart, spec.kind);
    if (stay) {
      setAdded(keyOf(spec));
      input.current?.focus();
    } else closeAdd();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = hits.length || 1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Home' || e.key === 'End') {
      if (query) return;
      e.preventDefault();
      setSel(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(hits[index], e.shiftKey || e.metaKey || e.ctrlKey);
    }
  };
  const row = (spec: IndicatorSpec, i: number) => {
    const count = onChart(spec);
    const key = keyOf(spec);
    const why = spec.kind === 'custom' ? undefined : unavailable.get(spec.kind);
    if (why) {
      return (
        <div
          key={key}
          id={`ind-add-${key}`}
          role="option"
          aria-selected={i === index}
          aria-disabled="true"
          title={why.reason || undefined}
          className={cx('ind-add-row', 'is-unavailable', i === index && 'is-on')}
          onPointerMove={() => setSel(i)}
          onPointerDown={(e) => e.preventDefault()}
        >
          <span className="ttl">{spec.title}</span>
          <span className="why">{requirementWords(why.requires)}</span>
          <button
            type="button"
            className="go"
            onClick={() => {
              closeAdd();
              openConnections();
            }}
          >
            Connections
          </button>
        </div>
      );
    }
    return (
      <div
        key={key}
        id={`ind-add-${key}`}
        role="option"
        aria-selected={i === index}
        className={cx('ind-add-row', i === index && 'is-on')}
        onPointerMove={() => setSel(i)}
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => add(spec, e.shiftKey || e.metaKey || e.ctrlKey)}
      >
        <span className="ttl">{spec.title}</span>
        <span className="short">{spec.short !== spec.title ? spec.short : ''}</span>
        <span className="on">
          {added === key ? 'added' : count > 1 ? `${String(count)} on chart` : count === 1 ? 'on chart' : ''}
        </span>
      </div>
    );
  };

  let k = 0;
  return (
    <div className="ind-add-panel" data-focus-zone="palette">
      <label className="t-input ind-add-search">
        <Icon name="plus" />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label="Search indicators"
          aria-expanded="true"
          aria-controls="ind-add-list"
          aria-activedescendant={hits[index] ? `ind-add-${keyOf(hits[index])}` : undefined}
          placeholder="Indicator"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
            setAdded(null);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="hint">
          <span>
            <Key shortcut="enter" />
            add
          </span>
          <span>
            <Key shortcut="shift+enter" />
            add another
          </span>
        </span>
      </label>
      <div id="ind-add-list" ref={list} role="listbox" aria-label="Indicators" className="ind-add-list">
        {groups
          ? groups.map((g) => (
              <Fragment key={g.group}>
                <div className="t-menu-label" role="presentation">
                  {g.label}
                </div>
                {g.specs.map((s) => row(s, k++))}
              </Fragment>
            ))
          : hits.map((s, i) => row(s, i))}
        {hits.length === 0 ? <div className="ind-add-none">No indicator matches “{query.trim()}”</div> : null}
      </div>
    </div>
  );
}
