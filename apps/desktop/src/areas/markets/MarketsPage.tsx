import {
  Button,
  Icon,
  Loaded,
  ScrollArea,
  SearchField,
  Segmented,
  cx,
  isContextMenuKey,
  openContextMenuAt,
} from '@tessera/ui';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { addConnection } from '../../accounts/navigate.ts';
import { useNow } from '../../app/runtimeContext.ts';
import { useSymbolSearch } from '../../market/search.ts';
import { addToWatchlist, openMarkets, removeFromWatchlist, type OpenHow } from '../../markets/actions.ts';
import { useListing } from '../../markets/listing.ts';
import { useResolvedOf, useSortQuotes } from '../../markets/rowData.ts';
import { useWatchlists } from '../../markets/watchlists.ts';
import { useHoldings } from '../../app/portfolio.ts';
import { useShellData } from '../../shell/shellData.ts';
import { useUi } from '../../state/ui.ts';
import { useActiveChart } from '../../state/workspace.ts';
import { ListNav } from './ListNav.tsx';
import { MarketDetail, MarketDetailSample, MultiDetail } from './MarketDetail.tsx';
import { MarketRowsSkeleton, MarketTable, MarketTableSample } from './MarketTable.tsx';
import {
  LIST_WORD,
  clickSelection,
  filterRows,
  flatRows,
  listedCount,
  movingSection,
  rowsOf,
  sectionsOf,
  sortSections,
  symbolRows,
  type MarketRow,
  type Section,
} from './model.ts';
import { useMarketsUi, setMarketsPlace } from './store.ts';
import './markets.css';

function useMinute(): number {
  const now = useNow();
  return Math.floor(now / 60_000) * 60_000;
}

const leaveAsIs = () => undefined;

function NavRowSample({ title, n, on = false }: { title: string; n: number; on?: boolean }) {
  return (
    <button type="button" className={cx('mk-nav-row', on && 'is-on')}>
      <span className="ttl">{title}</span>
      <span className="n">{n}</span>
    </button>
  );
}

function ListNavSample() {
  return (
    <nav className="mk-nav" aria-label="Lists">
      <ScrollArea className="mk-nav-scroll">
        <div className="mk-nav-group">
          <NavRowSample title={LIST_WORD.all} n={120} on />
        </div>
        <div className="mk-nav-group">
          <div className="mk-nav-label">
            <span>Watchlists</span>
            <button type="button" className="mk-nav-add" aria-label="New watchlist">
              <Icon name="plus" />
            </button>
          </div>
          <NavRowSample title="Index futures" n={4} />
          <NavRowSample title="Metals" n={2} />
        </div>
        <div className="mk-nav-group">
          <NavRowSample title={LIST_WORD.recent} n={8} />
          <NavRowSample title={LIST_WORD.positions} n={1} />
        </div>
      </ScrollArea>
    </nav>
  );
}

function MarketsSample({ side }: { side: boolean }) {
  return (
    <>
      <header className="ar-head">
        <h1 className="ar-title">Markets</h1>
        <SearchField
          className="mk-search"
          label="Search markets"
          placeholder="Search symbol, name, exchange"
          value=""
          onValueChange={leaveAsIs}
        />
        <span className="mk-fill" />
        <Segmented
          className="mk-conns"
          label="Connection"
          value=""
          onChange={leaveAsIs}
          options={[{ value: '', label: 'Rithmic Paper' }]}
        />
        <button type="button" className="mk-moving">
          Top movers
        </button>
      </header>
      <div className="mk-body">
        <ListNavSample />
        <MarketTableSample />
        <aside className="mk-side">
          {side ? (
            <MarketDetailSample />
          ) : (
            <p className="mk-side-none">Select a market to see its contract and sessions.</p>
          )}
        </aside>
      </div>
    </>
  );
}

export function MarketsPage() {
  const side = useMarketsUi((s) => s.instrument !== null);
  return (
    <section className="ar-page mk-page" aria-label="Markets" data-focus-zone="table">
      <Loaded label="Loading markets" sample={<MarketsSample side={side} />}>
        <MarketsBody />
      </Loaded>
    </section>
  );
}

function MarketsBody() {
  const place = useMarketsUi((s) => s);
  const listing = useListing();
  const lists = useWatchlists((s) => s.value.lists);
  const recents = useUi((s) => s.recentSymbols);
  const { accountId } = useShellData();
  const holdings = useHoldings();
  const nowMs = useMinute();
  const chart = useActiveChart();
  const resolvedOf = useResolvedOf();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const all = useMemo(() => rowsOf(listing.listings), [listing.listings]);
  const connections = listing.listings;
  const connection = place.connection && connections.some((c) => c.id === place.connection) ? place.connection : null;
  const watch = place.list === 'watchlist' ? (lists.find((l) => l.id === place.watchlist) ?? lists[0] ?? null) : null;
  const held = useMemo(
    () => [
      ...new Set(
        (holdings ?? [])
          .filter((p) => p.qty !== 0 && (accountId === null || p.accountId === accountId))
          .map((p) => p.instrument),
      ),
    ],
    [holdings, accountId],
  );
  const query = place.query.trim();

  let base: Section[];
  if (place.list === 'watchlist' || place.list === 'recent' || place.list === 'positions') {
    const symbols = place.list === 'watchlist' ? (watch?.symbols ?? []) : place.list === 'recent' ? recents : held;
    const rows = filterRows(symbolRows(symbols, all, place.list), { connection: null, query });
    base = [{ key: place.list, title: '', meta: '', rows }];
  } else {
    base = sectionsOf(filterRows(all, { connection, query }));
  }
  const found = useSymbolSearch(place.list === 'all' ? query : '', 20);
  const hits = found.hits;
  const listedIds = new Set(all.map((r) => r.id));
  const beyond = hits.filter((h) => !listedIds.has(h.instrument));
  if (query && beyond.length > 0 && place.list === 'all')
    base = [
      ...base,
      {
        key: 'beyond',
        title: 'More matches',
        meta: '',
        rows: symbolRows(
          beyond.map((h) => h.instrument),
          all,
          'beyond',
        ),
      },
    ];

  const baseRows = flatRows(base);
  const quoteKey = (r: MarketRow) => (r.instrument ? r.id : resolvedOf(r.id));
  const quoteOf = useSortQuotes(
    baseRows.map(quoteKey),
    place.moving || (place.sort !== null && place.sort.key !== 'symbol'),
  );
  const sections = place.moving
    ? [movingSection(baseRows, (r) => quoteOf(quoteKey(r)))]
    : sortSections(base, place.sort, (r) => quoteOf(quoteKey(r)));
  const rows = flatRows(sections);
  const order = rows.map((r) => r.key);

  const shownSel = [...selected].filter((k) => order.includes(k));
  const selRows = rows.filter((r) => shownSel.includes(r.key));
  const cursorRow = rows.find((r) => r.key === cursor) ?? null;
  const focusRow = cursorRow ?? (place.instrument ? (rows.find((r) => r.id === place.instrument) ?? null) : null);
  const [followed, setFollowed] = useState(place.instrument);
  if (place.instrument !== followed) {
    setFollowed(place.instrument);
    const r = rows.find((x) => x.id === place.instrument);
    if (r && cursorRow?.id !== place.instrument) {
      setCursor(r.key);
      setSelected(new Set([r.key]));
      setAnchor(r.key);
    }
  }
  useEffect(() => {
    if (cursor) document.getElementById(domIdOfKey(cursor))?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const targetsOf = (r: MarketRow): MarketRow[] => (shownSel.includes(r.key) && selRows.length > 1 ? selRows : [r]);
  const charted = (r: MarketRow) => chart !== null && (chart.instrument === r.id || chart.instrument === quoteKey(r));
  const open = (r: MarketRow, how: OpenHow) =>
    void openMarkets(
      targetsOf(r).map((t) => t.id),
      how,
    );
  const pick = (r: MarketRow, e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => {
    const toggle = e.metaKey || e.ctrlKey;
    setSelected(clickSelection(order, new Set(shownSel), anchor, r.key, { toggle, range: e.shiftKey }));
    if (!e.shiftKey) setAnchor(r.key);
    setCursor(r.key);
    setMarketsPlace({ instrument: r.id });
  };
  const move = (d: number, extend: boolean) => {
    if (rows.length === 0) return;
    const at = cursorRow ? rows.indexOf(cursorRow) : -1;
    const r = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + d))]!;
    pick(r, { metaKey: false, ctrlKey: false, shiftKey: extend });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const r = cursorRow ?? focusRow;
    if (isContextMenuKey(e)) {
      e.preventDefault();
      const el = r ? document.getElementById(domId(r)) : null;
      if (el) openContextMenuAt(el);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
    } else if (e.key === 'Enter' && r) {
      e.preventDefault();
      open(r, e.metaKey || e.ctrlKey ? 'tab' : e.shiftKey ? 'split' : e.altKey ? 'dom' : 'chart');
    } else if ((e.key === '+' || e.key === '=') && r) {
      e.preventDefault();
      const to = watch ?? lists[0];
      if (to)
        addToWatchlist(
          to.id,
          targetsOf(r).map((t) => t.id),
        );
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && r && watch) {
      e.preventDefault();
      removeFromWatchlist(
        watch.id,
        targetsOf(r).map((t) => t.id),
      );
    } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSelected(new Set(order));
    } else if (e.key === 'Escape' && shownSel.length > 1) {
      e.preventDefault();
      setSelected(new Set(cursor ? [cursor] : []));
    } else if (
      e.key === '/' ||
      (e.key.length === 1 && /[a-z0-9]/i.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey)
    ) {
      e.preventDefault();
      search.current?.focus();
      if (e.key !== '/') setMarketsPlace({ query: place.query + e.key });
    }
  };

  const listed = listedCount(connection ? all.filter((r) => r.connection?.id === connection) : all);
  const listedConnections = connections.filter((c) => c.instruments.length > 0);
  const showSource = listedConnections.length > 1 && connection === null;
  const notes = connectionNotes(listing, connection);
  const title = place.list === 'watchlist' ? (watch?.name ?? 'Watchlist') : LIST_WORD[place.list];

  return (
    <>
      <header className="ar-head" data-tauri-drag-region>
        <h1 className="ar-title">Markets</h1>
        <SearchField
          className="mk-search"
          inputRef={search}
          label="Search markets"
          placeholder="Search symbol, name, exchange"
          value={place.query}
          onValueChange={(query) => setMarketsPlace({ query })}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') onKeyDown(e);
          }}
        />
        <span className="mk-fill" />
        {connections.length > 0 ? (
          <Segmented
            className="mk-conns"
            label="Connection"
            value={connection ?? ''}
            onChange={(v) => setMarketsPlace({ connection: v || null })}
            options={[
              ...(connections.length > 1 ? [{ value: '', label: 'All connections' }] : []),
              ...connections.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        ) : null}
        <button
          type="button"
          className={cx('mk-moving', place.moving && 'is-on')}
          aria-pressed={place.moving}
          onClick={() => setMarketsPlace({ moving: !place.moving })}
        >
          Top movers
        </button>
      </header>
      <div className="mk-body">
        <ListNav
          list={place.list}
          watchlist={watch?.id ?? null}
          listed={listed}
          recent={recents.length}
          positions={holdings === null ? null : held.length}
          renaming={renaming}
          onRenaming={setRenaming}
        />
        <MarketTable
          label={title}
          sections={sections}
          showSource={showSource}
          selected={new Set(shownSel)}
          cursor={cursorRow?.key ?? null}
          charted={charted}
          watchlist={watch}
          sort={place.moving ? null : place.sort}
          onSort={(sort) => setMarketsPlace({ sort, moving: false })}
          onClick={(r, e) => pick(r, e)}
          onOpen={open}
          targetsOf={targetsOf}
          onMenu={(r) => {
            if (!shownSel.includes(r.key)) pick(r, { metaKey: false, ctrlKey: false, shiftKey: false });
          }}
          nowMs={nowMs}
          notes={notes}
          empty={
            found.searching ? (
              <MarketRowsSkeleton rows={3} />
            ) : place.list === 'positions' && holdings === null ? null : (
              <p className="mk-none">{emptyWords(place.list, query, place.moving, listing.available)}</p>
            )
          }
          domId={domId}
          onKeyDown={onKeyDown}
        />
        <aside className="mk-side">
          {selRows.length > 1 ? (
            <MultiDetail
              rows={selRows}
              watchlist={watch}
              onOpen={(how) =>
                void openMarkets(
                  selRows.map((r) => r.id),
                  how,
                )
              }
            />
          ) : focusRow || place.instrument ? (
            <MarketDetail
              key={focusRow?.key ?? place.instrument}
              subject={{ id: focusRow?.id ?? place.instrument!, row: focusRow }}
              connectionOf={(id) => all.find((r) => r.id === id)?.connection ?? null}
              nowMs={nowMs}
              onOpen={(id, how) => void openMarkets([id], how)}
            />
          ) : (
            <p className="mk-side-none">Select a market to see its contract and sessions.</p>
          )}
        </aside>
      </div>
    </>
  );
}

const domIdOfKey = (key: string) => `mk-row-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
const domId = (r: MarketRow) => domIdOfKey(r.key);

function emptyWords(list: string, query: string, moving: boolean, available: boolean): string {
  if (!available) return 'This runtime does not list its instruments.';
  if (query) return `No market matches “${query}”.`;
  if (moving) return 'Nothing has moved yet today.';
  if (list === 'watchlist') return 'No symbols yet. Add any market with + on its row, or drag one onto a list.';
  if (list === 'recent') return 'Nothing charted yet.';
  if (list === 'positions') return 'Flat.';
  return 'No connection lists instruments here.';
}

function connectionNotes(listing: ReturnType<typeof useListing>, connection: string | null) {
  if (!listing.available) return null;
  if (listing.error) return <p className="mk-note">The connections could not be listed: {listing.error}</p>;
  if (listing.listings.length === 0)
    return (
      <p className="mk-note">
        No market-data connection is set up.
        <Button size="s" variant="quiet" onClick={() => addConnection()}>
          Add a connection
        </Button>
      </p>
    );
  const quiet = listing.listings.filter(
    (c) => (connection === null || c.id === connection) && (c.error !== null || c.instruments.length === 0),
  );
  if (quiet.length === 0) return null;
  return (
    <>
      {quiet.map((c) => (
        <p key={c.id} className="mk-note">
          {c.name} lists nothing{c.error ? `: ${c.error}` : '.'}
        </p>
      ))}
    </>
  );
}
