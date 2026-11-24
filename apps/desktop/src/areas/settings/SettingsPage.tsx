import { Loaded, PrivateScope, ScrollArea, SearchField, SettingsNavItem, cx } from '@tessera/ui';
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { THEME_COLORS, themeKey } from '../../chart/chartTheme.ts';
import { isTextInput } from '../../commands/registry.ts';
import { useRuntimeSettingsLoaded } from '../../state/runtimeSettings.ts';
import { useUi } from '../../state/ui.ts';
import { showPreviousArea, useArea } from '../store.ts';
import { BANDS } from './chartColours.ts';
import { APP_BANDS } from './themes.ts';
import { SHELL_COLORS } from '../../theme/resolve.ts';
import { connectionItem } from '../../accounts/connections.ts';
import { connectionTarget } from '../../accounts/navigate.ts';
import { useListedConnections } from '../../accounts/useConnections.ts';
import { useShellData } from '../../shell/shellData.ts';
import { CategorySample } from './CategorySample.tsx';
import { Alerts } from './categories/Alerts.tsx';
import { Analyst } from './categories/Analyst.tsx';
import { App } from './categories/App.tsx';
import { Appearance } from './categories/Appearance.tsx';
import { Chart } from './categories/Chart.tsx';
import { Connections } from './categories/Connections.tsx';
import { Data } from './categories/Data.tsx';
import { Levels } from './categories/Levels.tsx';
import { Trading } from './categories/Trading.tsx';
import { useKeyedCommands } from './hooks.ts';
import { commandRow } from './words.ts';
import {
  CATEGORIES,
  categoryDef,
  modelEntries,
  searchSettings,
  type SearchEntry,
  type SettingsCategory,
} from './model.ts';
import { goToSetting, showCategory, useSettingsNav, settingsNavStore } from './store.ts';
import { patch } from '../../app/store.ts';

const VIEWS: Record<SettingsCategory, ComponentType> = {
  connections: Connections,
  trading: Trading,
  chart: Chart,
  levels: Levels,
  alerts: Alerts,
  analyst: Analyst,
  data: Data,
  appearance: Appearance,
  app: App,
};

const PRIVATE_VIEWS: ReadonlySet<SettingsCategory> = new Set(['connections', 'analyst']);

const COLOUR_ENTRIES: readonly SearchEntry[] = THEME_COLORS.flatMap((c) => {
  const band = BANDS.find((b) => b.groups.includes(c.group));
  if (!band) return [];
  return [
    {
      id: `chart.colour.${themeKey(c)}`,
      category: 'chart' as const,
      label: c.label,
      path: `Chart · ${band.role}`,
      help: c.about,
      keywords: [c.about, band.role, 'colour', 'color', c.group],
    },
  ];
});

const APP_COLOUR_ENTRIES: readonly SearchEntry[] = SHELL_COLORS.flatMap((c) => {
  const band = APP_BANDS.find((b) => b.groups.includes(c.group));
  if (!band) return [];
  return [
    {
      id: `appearance.colour.${themeKey(c)}`,
      category: 'appearance' as const,
      label: c.label,
      path: `Appearance · ${band.role}`,
      help: c.about,
      keywords: [c.about, band.role, 'colour', 'color', 'theme', c.group],
    },
  ];
});

function useSearchEntries(): readonly SearchEntry[] {
  const keyed = useKeyedCommands();
  const listed = useListedConnections();
  const { accounts } = useShellData();
  return useMemo(
    () => [
      ...listed.map((l): SearchEntry => {
        const c = connectionItem(l, accounts);
        return {
          id: connectionTarget(c.id),
          category: 'connections',
          label: c.name,
          path: 'Connections',
          help: c.provides,
          keywords: [c.short, c.provides, c.serves ?? '', 'connection'],
        };
      }),
      ...modelEntries(),
      ...COLOUR_ENTRIES,
      ...APP_COLOUR_ENTRIES,
      ...keyed.map((c): SearchEntry => ({
        id: commandRow(c.id),
        category: 'app',
        label: c.title,
        path: `App · Keyboard shortcuts · ${c.group}`,
        keywords: [...(c.keywords ?? []), c.group, 'shortcut', 'key'],
      })),
    ],
    [keyed, listed, accounts],
  );
}

function useReveal(body: { current: HTMLDivElement | null }, category: SettingsCategory) {
  const target = useSettingsNav((s) => s.target);
  useEffect(() => {
    if (!target) {
      body.current?.scrollTo({ top: 0 });
      return;
    }
    let frames = 0;
    let raf = 0;
    let clear: ReturnType<typeof setTimeout> | null = null;
    const find = () => {
      const el = body.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(target.id)}"]`);
      const loading = body.current?.querySelector('[role="status"][aria-busy="true"]') !== null;
      if (!el || loading) {
        if (loading || ++frames < 60) raf = requestAnimationFrame(find);
        return;
      }
      el.scrollIntoView({ block: 'center' });
      el.removeAttribute('data-found');
      raf = requestAnimationFrame(() => el.setAttribute('data-found', ''));
      clear = setTimeout(() => el.removeAttribute('data-found'), 1700);
      const control = el.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [role="switch"]',
      );
      control?.focus({ preventScroll: true });
    };
    raf = requestAnimationFrame(find);
    return () => {
      cancelAnimationFrame(raf);
      if (clear) clearTimeout(clear);
    };
  }, [target, category, body]);
}

function usePageKeys(live: boolean, search: { current: HTMLInputElement | null }) {
  useEffect(() => {
    if (!live) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof Element ? e.target : null;
      if (isTextInput(t)) return;
      if (t?.closest('[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper]')) return;
      if (e.key === '/') {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        showPreviousArea();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, search]);
}

function Results({
  results,
  active,
  onActive,
  listId,
}: {
  results: readonly SearchEntry[];
  active: number;
  onActive: (i: number) => void;
  listId: string;
}) {
  if (results.length === 0) return <p className="st-none">No match</p>;
  return (
    <div className="st-results t-set-card" role="listbox" id={listId} aria-label="Settings found">
      {results.map((r, i) => (
        <button
          key={`${r.category}:${r.id}`}
          type="button"
          role="option"
          id={`${listId}-${String(i)}`}
          aria-selected={i === active}
          className={cx('st-result', i === active && 'is-on')}
          tabIndex={-1}
          onPointerMove={() => onActive(i)}
          onClick={() => goToSetting(r.id, r.category)}
        >
          <span className="lab">
            <span className="t">{r.label}</span>
            {r.help ? <span className="help">{r.help}</span> : null}
          </span>
          <span className="at">{r.path}</span>
        </button>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const category = useUi((s) => s.settingsSection);
  const query = useSettingsNav((s) => s.query);
  const live = useArea((s) => s.area === 'settings');
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const entries = useSearchEntries();
  const results = useMemo(() => searchSettings(entries, query), [entries, query]);
  const [active, setActive] = useState(0);
  const [lastQuery, setLastQuery] = useState(query);
  if (lastQuery !== query) {
    setLastQuery(query);
    setActive(0);
  }
  const listId = useId();
  useReveal(body, category);
  usePageKeys(live, search);
  const View = VIEWS[category];
  const known = useRuntimeSettingsLoaded();
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!query) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = results.length;
      if (n > 0) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[active];
      if (r) goToSetting(r.id, r.category);
    }
  };
  return (
    <section className="st-page" aria-label="Settings" data-focus-zone="settings">
      <header className="ar-head st-head" data-tauri-drag-region>
        <h1 className="ar-title">Settings</h1>
        <span className="st-location">{query ? 'Search results' : categoryDef(category).label}</span>
      </header>
      <nav className="st-nav" aria-label="Settings">
        <SearchField
          className="st-search"
          label="Search settings"
          placeholder="Search"
          value={query}
          inputRef={search}
          controls={listId}
          activeDescendant={query && results.length > 0 ? `${listId}-${String(active)}` : undefined}
          onValueChange={(q) => patch(settingsNavStore, { query: q })}
          onKeyDown={onSearchKey}
        />
        <div className="st-cats">
          {CATEGORIES.map((c) => (
            <SettingsNavItem
              key={c.id}
              label={c.label}
              current={!query && c.id === category}
              onClick={() => {
                patch(settingsNavStore, { query: '' });
                showCategory(c.id);
              }}
            />
          ))}
        </div>
      </nav>
      <ScrollArea className="st-body" viewportRef={body}>
        {query ? (
          <div className="st-col" data-category="search" role="region" aria-label="Search results">
            <Results results={results} active={active} onActive={setActive} listId={listId} />
          </div>
        ) : (
          <Loaded
            key={category}
            label={`Loading ${categoryDef(category).label}`}
            pending={!known}
            sample={<CategorySample category={category} />}
          >
            {PRIVATE_VIEWS.has(category) ? (
              <PrivateScope>
                <div
                  className="st-col"
                  data-category={category}
                  data-private=""
                  role="region"
                  aria-label={categoryDef(category).label}
                >
                  <View />
                </div>
              </PrivateScope>
            ) : (
              <div className="st-col" data-category={category} role="region" aria-label={categoryDef(category).label}>
                <View />
              </div>
            )}
          </Loaded>
        )}
      </ScrollArea>
    </section>
  );
}
