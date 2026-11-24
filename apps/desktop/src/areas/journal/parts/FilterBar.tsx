import type { JournalCatalog, TradeFilter, TradeResult } from '@tessera/protocol';
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Select,
  TextInput,
  cx,
} from '@tessera/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useJournalAction } from '../data.ts';
import { EMOTIONS, emotionWord, resultWord } from '../model/format.ts';
import { clean, filterChips, toggle, withoutChip } from '../model/scope.ts';
import { Badge, Panel } from '../kit/index.ts';
import { Rating } from './Common.tsx';

export function FilterBar({
  filter,
  onChange,
  catalog,
  right,
}: {
  filter: TradeFilter;
  onChange: (f: TradeFilter) => void;
  catalog: JournalCatalog | null;
  right?: ReactNode;
}) {
  const [words, setWords] = useState(filter.search ?? '');
  const [seen, setSeen] = useState(filter.search);
  const [open, setOpen] = useState(false);
  if (filter.search !== seen) {
    setSeen(filter.search);
    setWords(filter.search ?? '');
  }
  useEffect(() => {
    const id = window.setTimeout(() => {
      if ((filter.search ?? '') !== words.trim()) onChange(clean({ ...filter, search: words.trim() || undefined }));
    }, 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce the words only
  }, [words]);
  const set = (patch: Partial<TradeFilter>) => onChange(clean({ ...filter, ...patch }));
  const quick = new Set(['search', 'side', 'outcome', 'status', 'reviewed', 'setups']);
  const chips = filterChips(filter, catalog).filter((c) => !quick.has(c.key));
  const advanced = advancedCount(filter);
  const all = Object.keys(clean(filter)).length;
  return (
    <div className="jr-filters">
      <div className="jr-filters-row">
        <TextInput
          size="s"
          className="jr-search"
          value={words}
          placeholder="Search symbol, setup, notes…"
          aria-label="Search trades"
          onChange={(e) => setWords(e.target.value)}
        />
        <QuickSelects filter={filter} set={set} catalog={catalog} />
        <Button size="s" variant={open || advanced ? 'secondary' : 'quiet'} onClick={() => setOpen((o) => !o)}>
          Advanced
          {advanced ? <Badge tone="mist">{advanced}</Badge> : null}
        </Button>
        <SavedFilters filter={filter} onChange={onChange} catalog={catalog} />
        {all ? (
          <Button size="s" variant="quiet" onClick={() => onChange({})}>
            Clear ({all})
          </Button>
        ) : null}
        <span className="jr-filters-r">{right}</span>
      </div>
      {open ? (
        <Panel chrome="advanced filters" className="jr-advanced">
          <AdvancedFilters filter={filter} set={set} catalog={catalog} />
        </Panel>
      ) : null}
      {chips.length && !open ? (
        <div className="jr-chips">
          {chips.map((c) => (
            <button
              type="button"
              key={c.key}
              className="jr-chip"
              onClick={() => onChange(withoutChip(filter, c.key))}
              title="Remove"
            >
              {c.label}
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function advancedCount(filter: TradeFilter): number {
  return (
    (filter.tags?.length ?? 0) +
    (filter.weekdays?.length ?? 0) +
    (filter.hours?.length ?? 0) +
    (filter.sessions?.length ?? 0) +
    (filter.results?.length ?? 0) +
    (filter.emotions?.length ?? 0) +
    (filter.symbols?.length ?? 0) +
    Number(filter.from !== undefined || filter.to !== undefined) +
    Number(filter.minPnl !== undefined || filter.maxPnl !== undefined) +
    Number(filter.minR !== undefined || filter.maxR !== undefined) +
    Number(filter.minRating !== undefined)
  );
}

export function QuickSelects({
  filter,
  set,
  catalog,
}: {
  filter: TradeFilter;
  set: (p: Partial<TradeFilter>) => void;
  catalog: JournalCatalog | null;
}) {
  const setups = catalog?.setups ?? [];
  const oneSetup = filter.setups?.length === 1 ? filter.setups[0] : undefined;
  return (
    <>
      <Select
        size="s"
        label="Status"
        value={filter.status ?? 'all'}
        onValueChange={(v) => set({ status: v === 'all' ? undefined : v })}
        options={[
          { value: 'all', label: 'All status' },
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Closed' },
        ]}
      />
      <Select
        size="s"
        label="Direction"
        value={filter.side ?? 'all'}
        onValueChange={(v) => set({ side: v === 'all' ? undefined : v })}
        options={[
          { value: 'all', label: 'All directions' },
          { value: 'buy', label: 'Long' },
          { value: 'sell', label: 'Short' },
        ]}
      />
      <Select
        size="s"
        label="Result"
        value={filter.outcome ?? 'all'}
        onValueChange={(v) => set({ outcome: v === 'all' ? undefined : v })}
        options={[
          { value: 'all', label: 'All results' },
          { value: 'win', label: 'Winners' },
          { value: 'loss', label: 'Losers' },
          { value: 'breakeven', label: 'Breakeven' },
        ]}
      />
      <Select
        size="s"
        label="Review"
        value={filter.reviewed === undefined ? 'all' : filter.reviewed ? 'yes' : 'no'}
        onValueChange={(v) => set({ reviewed: v === 'all' ? undefined : v === 'yes' })}
        options={[
          { value: 'all', label: 'All reviews' },
          { value: 'yes', label: 'Reviewed' },
          { value: 'no', label: 'Not reviewed' },
        ]}
      />
      <Select
        size="s"
        label="Setup"
        value={(filter.setups?.length ?? 0) > 1 ? 'many' : (oneSetup ?? 'all')}
        onValueChange={(v) => set({ setups: v === 'all' || v === 'many' ? undefined : [v] })}
        options={[
          { value: 'all', label: 'All setups' },
          ...((filter.setups?.length ?? 0) > 1
            ? [{ value: 'many', label: `${String(filter.setups?.length)} setups` }]
            : []),
          ...setups.map((x) => ({
            value: x.id,
            textValue: x.name,
            label: (
              <span className="jr-setup-opt">
                <i style={{ background: x.color }} />
                {x.name}
              </span>
            ),
          })),
          { value: 'none', label: 'No setup' },
        ]}
      />
    </>
  );
}

const RESULTS: TradeResult[] = ['target', 'stop', 'trailed', 'breakeven', 'manual', 'open'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function Toggles<T>({
  label,
  items,
  value,
  onChange,
  word,
  dense,
}: {
  label: string;
  items: readonly T[];
  value: readonly T[] | undefined;
  onChange: (v: T[] | undefined) => void;
  word: (v: T) => ReactNode;
  dense?: boolean;
}) {
  if (!items.length) return null;
  return (
    <div className="jr-fgroup">
      <span className="jr-label">{label}</span>
      <div className={cx('jr-toggles', dense && 'is-dense')}>
        {items.map((v) => {
          const on = value?.includes(v) ?? false;
          return (
            <button
              type="button"
              key={String(v)}
              className={cx('jr-toggle', on && 'is-on')}
              aria-pressed={on}
              onClick={() => onChange(toggle(value, v))}
            >
              {word(v)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function num(v: string): number | undefined {
  const n = Number(v);
  return v.trim() === '' || !Number.isFinite(n) ? undefined : n;
}

function Range({
  label,
  lo,
  hi,
  onChange,
  unit,
}: {
  label: string;
  lo: number | undefined;
  hi: number | undefined;
  onChange: (lo: number | undefined, hi: number | undefined) => void;
  unit: string;
}) {
  return (
    <div className="jr-fgroup">
      <span className="jr-label">{label}</span>
      <div className="jr-range">
        <TextInput
          size="s"
          inputMode="decimal"
          placeholder="from"
          aria-label={`${label} from`}
          defaultValue={lo ?? ''}
          unit={unit}
          onBlur={(e) => onChange(num(e.target.value), hi)}
        />
        <TextInput
          size="s"
          inputMode="decimal"
          placeholder="to"
          aria-label={`${label} to`}
          defaultValue={hi ?? ''}
          unit={unit}
          onBlur={(e) => onChange(lo, num(e.target.value))}
        />
      </div>
    </div>
  );
}

export function AdvancedFilters({
  filter,
  set,
  catalog,
}: {
  filter: TradeFilter;
  set: (p: Partial<TradeFilter>) => void;
  catalog: JournalCatalog | null;
}) {
  const tags = catalog?.tags ?? [];
  return (
    <div className="jr-adv">
      <div className="jr-fcol">
        <span className="jk-caps">What</span>
        <Toggles
          label="Symbols"
          items={catalog?.symbols ?? []}
          value={filter.symbols}
          onChange={(v) => set({ symbols: v })}
          word={(s) => s}
        />
        <Toggles
          label="Tags"
          items={tags.map((t) => t.id)}
          value={filter.tags}
          onChange={(v) => set({ tags: v })}
          word={(id) => {
            const t = tags.find((x) => x.id === id);
            return t ? `${t.group ? `${t.group}: ` : ''}${t.name}` : id;
          }}
        />
      </div>
      <div className="jr-fcol">
        <span className="jk-caps">When</span>
        <div className="jr-fgroup">
          <span className="jr-label">Date range</span>
          <div className="jr-range">
            <TextInput
              size="s"
              type="date"
              aria-label="From"
              value={filter.from ?? ''}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
            <TextInput
              size="s"
              type="date"
              aria-label="To"
              value={filter.to ?? ''}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          </div>
        </div>
        <Toggles
          label="Day of week"
          items={[1, 2, 3, 4, 5, 6, 7]}
          value={filter.weekdays}
          onChange={(v) => set({ weekdays: v })}
          word={(d) => WEEKDAYS[d - 1]}
        />
        <Toggles
          label="Entry hour"
          items={Array.from({ length: 24 }, (_, h) => h)}
          value={filter.hours}
          onChange={(v) => set({ hours: v })}
          word={(h) => String(h).padStart(2, '0')}
          dense
        />
        <Toggles
          label="Session"
          items={catalog?.settings.sessions.map((s) => s.name) ?? []}
          value={filter.sessions}
          onChange={(v) => set({ sessions: v })}
          word={(s) => s}
        />
      </div>
      <div className="jr-fcol">
        <span className="jk-caps">How</span>
        <Range
          label="P&L range"
          lo={filter.minPnl}
          hi={filter.maxPnl}
          unit="$"
          onChange={(lo, hi) => set({ minPnl: lo, maxPnl: hi })}
        />
        <Range
          label="R-multiple"
          lo={filter.minR}
          hi={filter.maxR}
          unit="R"
          onChange={(lo, hi) => set({ minR: lo, maxR: hi })}
        />
        <Toggles
          label="Mood"
          items={EMOTIONS}
          value={filter.emotions}
          onChange={(v) => set({ emotions: v })}
          word={emotionWord}
        />
      </div>
      <div className="jr-fcol">
        <span className="jk-caps">Result</span>
        <Toggles
          label="Exit reason"
          items={RESULTS}
          value={filter.results}
          onChange={(v) => set({ results: v })}
          word={resultWord}
        />
        <div className="jr-fgroup">
          <span className="jr-label">Rating at least</span>
          <Rating value={filter.minRating ?? null} onChange={(r) => set({ minRating: r ?? undefined })} />
        </div>
      </div>
    </div>
  );
}

function SavedFilters({
  filter,
  onChange,
  catalog,
}: {
  filter: TradeFilter;
  onChange: (f: TradeFilter) => void;
  catalog: JournalCatalog | null;
}) {
  const act = useJournalAction();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const saved = catalog?.filters ?? [];
  const has = Object.keys(clean(filter)).length > 0;
  if (naming) {
    return (
      <form
        className="jr-savefilter"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void act('journal.save_filter', { name: name.trim(), filter }).then(() => {
            setNaming(false);
            setName('');
          });
        }}
      >
        <TextInput
          size="s"
          autoFocus
          value={name}
          placeholder="Name this filter"
          aria-label="Filter name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => !name && setNaming(false)}
        />
        <Button size="s" type="submit" disabled={!name.trim()}>
          Save
        </Button>
      </form>
    );
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="s" variant="quiet">
          Presets
        </Button>
      </MenuTrigger>
      <MenuContent align="start">
        {saved.length ? <MenuLabel>Saved filters</MenuLabel> : null}
        {saved.map((f) => (
          <MenuItem key={f.id} onSelect={() => onChange(f.filter)} hint={<DeleteSaved id={f.id} />}>
            {f.name}
          </MenuItem>
        ))}
        {saved.length ? <MenuSeparator /> : null}
        <MenuItem disabled={!has} onSelect={() => setNaming(true)}>
          Save current filters
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function DeleteSaved({ id }: { id: string }) {
  const act = useJournalAction();
  return (
    <span
      role="button"
      tabIndex={-1}
      className="jr-x"
      aria-label="Delete"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void act('journal.delete_filter', { id });
      }}
    >
      ×
    </span>
  );
}
