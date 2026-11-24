import { valueOf } from '../../../app/tools.ts';
import type { JournalCatalog, SavedFilter, TradeFilter } from '@tessera/protocol';
import {
  Button,
  Dialog,
  DialogContent,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Switch,
  TextInput,
  cx,
} from '@tessera/ui';
import { useEffect, useRef, useState } from 'react';
import { useJournalAction, useStats, useToday } from '../data.ts';
import { Badge, Panel } from '../kit/index.ts';
import { dayLabel, plural } from '../model/format.ts';
import { clean, scopedFilter } from '../model/scope.ts';
import { useJournalUi } from '../store.ts';
import { AdvancedFilters, QuickSelects } from './FilterBar.tsx';

export function QueryBar({
  filter,
  onChange,
  catalog,
}: {
  filter: TradeFilter;
  onChange: (f: TradeFilter) => void;
  catalog: JournalCatalog | null;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TradeFilter>(filter);
  const [managing, setManaging] = useState(false);
  const scope = useJournalUi((s) => s.scope);
  const today = useToday();
  const shown = open ? draft : filter;
  const count = valueOf(useStats(scopedFilter(scope, shown, today), true));
  const n = count?.overview.all.n;
  const saved = catalog?.filters ?? [];
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current || !catalog) return;
    loaded.current = true;
    const def = catalog.filters.find((f) => f.isDefault);
    if (def && !Object.keys(clean(filter)).length) onChange(def.filter);
  }, [catalog, filter, onChange]);
  const set = (patch: Partial<TradeFilter>) => setDraft((d) => clean({ ...d, ...patch }));
  const dirty = JSON.stringify(clean(draft)) !== JSON.stringify(clean(filter));
  return (
    <div className="jq-bar">
      <QueryLine
        filter={filter}
        shown={shown}
        catalog={catalog}
        n={n}
        open={open}
        onToggle={() => {
          if (!open) setDraft(filter);
          setOpen(!open);
        }}
        onLoad={(f) => {
          onChange(f);
          setDraft(f);
        }}
        onManage={() => setManaging(true)}
      />
      {open ? (
        <Panel
          chrome="query builder"
          className="jq-panel"
          actions={
            <>
              <Button size="s" variant="quiet" onClick={() => setDraft({})}>
                Reset
              </Button>
              <Button
                size="s"
                variant="primary"
                disabled={!dirty}
                onClick={() => {
                  onChange(clean(draft));
                  setOpen(false);
                }}
              >
                Apply
              </Button>
            </>
          }
          title="Measure over"
          description={dirty ? 'Not applied yet: the count is what Apply would keep.' : 'Applied.'}
        >
          <div className="jq-quick">
            <QuickSelects filter={draft} set={set} catalog={catalog} />
          </div>
          <AdvancedFilters filter={draft} set={set} catalog={catalog} />
        </Panel>
      ) : null}
      <ManagePresets open={managing} onOpenChange={setManaging} saved={saved} />
    </div>
  );
}

const ignore = () => undefined;

export function QueryBarSample({ filter, trades }: { filter: TradeFilter; trades: number }) {
  return (
    <div className="jq-bar">
      <QueryLine
        filter={filter}
        shown={filter}
        catalog={null}
        n={trades}
        open={false}
        onToggle={ignore}
        onLoad={ignore}
        onManage={ignore}
      />
    </div>
  );
}

function QueryLine({
  filter,
  shown,
  catalog,
  n,
  open,
  onToggle,
  onLoad,
  onManage,
}: {
  filter: TradeFilter;
  shown: TradeFilter;
  catalog: JournalCatalog | null;
  n: number | undefined;
  open: boolean;
  onToggle: () => void;
  onLoad: (f: TradeFilter) => void;
  onManage: () => void;
}) {
  return (
    <div className="jq-line">
      <button type="button" className={cx('jq-summary', open && 'is-open')} aria-expanded={open} onClick={onToggle}>
        <span className="jq-prompt">›</span>
        <span>{summary(shown, catalog)}</span>
      </button>
      <Badge tone="outline">{n === undefined ? '…' : plural(n, 'trade')}</Badge>
      <Presets saved={catalog?.filters ?? []} filter={filter} onLoad={onLoad} onManage={onManage} />
    </div>
  );
}

function summary(f: TradeFilter, catalog: JournalCatalog | null): string {
  const parts: string[] = [];
  parts.push(f.symbols?.length ? f.symbols.join(', ') : 'All symbols');
  if (f.from || f.to) parts.push(`${f.from ? dayLabel(f.from) : 'start'} → ${f.to ? dayLabel(f.to) : 'today'}`);
  if (f.setups?.length) {
    const names = f.setups.map((id) =>
      id === 'none' ? 'No setup' : (catalog?.setups.find((s) => s.id === id)?.name ?? id),
    );
    parts.push(names.join(', '));
  }
  const others = Object.keys(clean(f)).filter((k) => !['symbols', 'from', 'to', 'setups'].includes(k)).length;
  if (others) parts.push(plural(others, 'filter'));
  return parts.join(' · ');
}

function Presets({
  saved,
  filter,
  onLoad,
  onManage,
}: {
  saved: readonly SavedFilter[];
  filter: TradeFilter;
  onLoad: (f: TradeFilter) => void;
  onManage: () => void;
}) {
  const act = useJournalAction();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
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
          placeholder="Name this preset"
          aria-label="Preset name"
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
      <MenuContent align="end">
        {saved.length ? <MenuLabel>Presets</MenuLabel> : null}
        {saved.map((f) => (
          <MenuItem key={f.id} onSelect={() => onLoad(f.filter)} hint={f.isDefault ? 'Default' : undefined}>
            {f.name}
          </MenuItem>
        ))}
        {saved.length ? <MenuSeparator /> : null}
        <MenuItem disabled={!Object.keys(clean(filter)).length} onSelect={() => setNaming(true)}>
          Save current query
        </MenuItem>
        <MenuItem disabled={!saved.length} onSelect={onManage}>
          Manage presets…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function ManagePresets({
  open,
  onOpenChange,
  saved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saved: readonly SavedFilter[];
}) {
  const act = useJournalAction();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="jk-dialog"
        title="Manage presets"
        description="The default preset loads when the analytics open on no query of their own."
      >
        <ol className="jk-sortable">
          {saved.map((f) => (
            <li key={f.id} className="jq-preset">
              <span />
              <TextInput
                size="s"
                defaultValue={f.name}
                aria-label="Preset name"
                onBlur={(e) =>
                  e.target.value.trim() &&
                  e.target.value !== f.name &&
                  void act('journal.save_filter', { id: f.id, name: e.target.value.trim(), filter: f.filter })
                }
              />
              <Switch
                label="Default"
                checked={f.isDefault}
                onCheckedChange={(v) =>
                  void act('journal.save_filter', { id: f.id, name: f.name, filter: f.filter, isDefault: v })
                }
              >
                Default
              </Switch>
              <IconButton label="Delete" icon="trash" onClick={() => void act('journal.delete_filter', { id: f.id })} />
            </li>
          ))}
        </ol>
        {!saved.length ? <p className="text-t3 jk-sortable-empty">No presets yet.</p> : null}
      </DialogContent>
    </Dialog>
  );
}
