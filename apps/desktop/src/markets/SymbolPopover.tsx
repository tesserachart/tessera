import {
  Icon,
  Loaded,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  cx,
  formatPercent,
  formatPrice,
  formatShortcut,
  toneOf,
  usePlatform,
  type Platform,
  type Tone,
  PRICE_TEXT,
} from '@tessera/ui';
import { useEffect, useEffectEvent, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNow } from '../app/runtimeContext.ts';
import { useInstrumentInfo, venueLabel } from '../chart/identity.ts';
import { displaySymbol } from '../market/instruments.ts';
import { quoteChange } from '../market/quotes.ts';
import { symbolRowName, useSymbolSearch } from '../market/search.ts';
import { setMarketsPlace } from '../areas/markets/store.ts';
import { showArea } from '../areas/store.ts';
import { useUi, closeSymbolSearch } from '../state/ui.ts';
import { openChartTab, showInstrument, splitWithSymbol } from '../workspace/addChart.ts';
import { useListing } from './listing.ts';
import {
  TAB_WORD,
  TABS,
  futuresRows,
  nextTab,
  setPopoverPlace,
  symbolRows,
  usePopoverPlace,
  type PopoverRow,
  type Tab,
} from './popoverModel.ts';
import { useRowQuote, useRowSpec } from './rowData.ts';
import { useWatchlists } from './watchlists.ts';
import { marketSession, useMarketSessions } from './sessions.ts';
import { tickWords, dayWords } from './words.ts';

type PickHow = 'chart' | 'tab' | 'split';

function pickHint(forTab: boolean, platform: Platform): string {
  const key = (shortcut: string) => formatShortcut(shortcut, platform);
  return forTab
    ? `${key('enter')} new tab · ${key('shift+enter')} split`
    : `${key('enter')} chart · ${key('mod+enter')} tab · ${key('shift+enter')} split`;
}

export function SymbolPopover() {
  const platform = usePlatform();
  const initial = useUi((s) => s.symbolSearch) ?? '';
  const forTab = useUi((s) => s.symbolSearchFor === 'tab');
  const recents = useUi((s) => s.recentSymbols);
  const lists = useWatchlists((s) => s.value.lists);
  const place = usePopoverPlace();
  const [query, setQuery] = useState(initial);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;
  const found = useSymbolSearch(query, 12);
  const listing = useListing(!searching && place.tab === 'futures');
  const watch = lists.find((l) => l.id === place.watchlist) ?? lists[0] ?? null;
  const futures = useMemo(() => futuresRows(listing.listings.flatMap((c) => c.instruments)), [listing.listings]);
  const rows: PopoverRow[] = searching
    ? found.hits.map((h) => ({ id: h.instrument, name: h.name, heading: null, front: false }))
    : place.tab === 'watchlist'
      ? symbolRows(watch?.symbols ?? [])
      : place.tab === 'futures'
        ? futures
        : symbolRows(recents);
  const index = Math.min(sel, Math.max(0, rows.length - 1));
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    document.getElementById(`sym-hit-${String(index)}`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  const pickWhenFound = useRef<PickHow | null>(null);
  const pick = (row: PopoverRow | undefined, how: PickHow = forTab ? 'tab' : 'chart') => {
    if (!row) return;
    closeSymbolSearch();
    void (how === 'tab' ? openChartTab(row.id) : how === 'split' ? splitWithSymbol(row.id) : showInstrument(row.id));
  };
  const pickHeld = useEffectEvent(() => {
    const how = pickWhenFound.current;
    pickWhenFound.current = null;
    if (how) pick(rows[index], how);
  });
  useEffect(() => {
    if (!found.searching) pickHeld();
  }, [found.searching]);
  const showTab = (tab: Tab) => {
    setPopoverPlace({ tab });
    setSel(0);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length || 1;
      setSel((index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const how = e.metaKey || e.ctrlKey ? 'tab' : e.shiftKey ? 'split' : forTab ? 'tab' : 'chart';
      if (found.searching) pickWhenFound.current = how;
      else pick(rows[index], how);
    } else if (!searching && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      showTab(nextTab(place.tab, e.key === 'ArrowRight' ? 1 : -1));
    }
  };
  const allMarkets = () => {
    closeSymbolSearch();
    setMarketsPlace({ query: query.trim(), list: 'all', moving: false });
    showArea('markets');
  };
  return (
    <div className="sym-search sym-pop" data-focus-zone="palette">
      <label className="t-input">
        <Icon name="search" />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label={forTab ? 'Search symbols for a new chart tab' : 'Search symbols'}
          aria-expanded="true"
          aria-controls="sym-hits"
          aria-activedescendant={rows[index] ? `sym-hit-${String(index)}` : undefined}
          placeholder="Symbol, name or exchange"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
            pickWhenFound.current = null;
          }}
          onKeyDown={onKeyDown}
        />
        <span className="hint">{pickHint(forTab, platform)}</span>
      </label>
      {searching ? null : (
        <div className="sym-tabs" role="tablist" aria-label="Lists">
          {TABS.map((t) =>
            t === 'watchlist' && lists.length > 1 ? (
              <Menu key={t}>
                <MenuTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={place.tab === t}
                    className={cx(place.tab === t && 'is-on')}
                    onPointerDown={() => showTab(t)}
                  >
                    {watch?.name ?? TAB_WORD[t]}
                    <Icon name="chevron-down" className="chev" />
                  </button>
                </MenuTrigger>
                <MenuContent align="start" style={{ minWidth: 180 }}>
                  <MenuRadioGroup
                    value={watch?.id ?? ''}
                    onValueChange={(id) => {
                      setPopoverPlace({ tab: 'watchlist', watchlist: id });
                      setSel(0);
                      input.current?.focus();
                    }}
                  >
                    {lists.map((l) => (
                      <MenuRadioItem key={l.id} value={l.id} hint={String(l.symbols.length)}>
                        {l.name}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuContent>
              </Menu>
            ) : (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={place.tab === t}
                className={cx(place.tab === t && 'is-on')}
                onClick={() => {
                  showTab(t);
                  input.current?.focus();
                }}
              >
                {t === 'watchlist' ? (watch?.name ?? TAB_WORD[t]) : TAB_WORD[t]}
              </button>
            ),
          )}
        </div>
      )}
      <Loaded
        key={rows.map((r) => r.id).join('\n')}
        label="Loading symbols"
        pending={found.searching || listing.loading}
        sample={<HitsSample />}
      >
        <HitsPanel
          rows={rows}
          index={index}
          empty={emptyWords(searching, query, place.tab, listing)}
          onHover={setSel}
          onPick={pick}
          onAllMarkets={allMarkets}
        />
      </Loaded>
    </div>
  );
}

function emptyWords(searching: boolean, query: string, tab: Tab, listing: ReturnType<typeof useListing>): string {
  if (searching) return `No symbol matches “${query.trim()}”`;
  if (tab === 'watchlist') return 'This watchlist is empty. Add symbols from Markets.';
  if (tab === 'recent') return 'Nothing charted yet';
  if (!listing.available) return 'This runtime does not list its instruments';
  return 'No connection lists futures';
}

function AllMarkets({ onClick, inert = false }: { onClick: () => void; inert?: boolean }) {
  return (
    <button
      type="button"
      className="sym-all"
      onClick={onClick}
      aria-hidden={inert || undefined}
      tabIndex={inert ? -1 : undefined}
    >
      All markets
    </button>
  );
}

function HitsPanel({
  rows,
  index,
  empty,
  onHover,
  onPick,
  onAllMarkets,
}: {
  rows: readonly PopoverRow[];
  index: number;
  empty: string;
  onHover: (index: number) => void;
  onPick: (row: PopoverRow, how?: 'tab' | 'split') => void;
  onAllMarkets: () => void;
}) {
  const current = rows[index]?.id ?? null;
  useBriefFacts(current);
  return (
    <>
      <div id="sym-hits" role="listbox" aria-label="Symbols" className="sym-hits">
        {rows.map((r, i) => (
          <PopoverRowView
            key={`${r.id}:${String(i)}`}
            id={`sym-hit-${String(i)}`}
            row={r}
            selected={i === index}
            onHover={() => onHover(i)}
            onPick={(how) => onPick(r, how)}
          />
        ))}
        {rows.length === 0 ? <div className="sym-none">{empty}</div> : null}
      </div>
      <footer className="sym-foot">
        {current ? (
          <Loaded key={current} label="Loading details" sample={<BriefWords words={SAMPLE_BRIEF} />}>
            <Brief id={current} />
          </Loaded>
        ) : (
          <span className="brief" />
        )}
        <AllMarkets onClick={onAllMarkets} />
      </footer>
    </>
  );
}

interface HitFace {
  symbol: string;
  name: string;
  front: boolean;
  heading: string | null;
  last: string;
  pct: string;
  pctTone: Tone;
  missing: boolean;
}

function HitRow({
  face,
  id,
  selected,
  onHover,
  onPick,
}: {
  face: HitFace;
  id?: string;
  selected: boolean;
  onHover?: () => void;
  onPick?: (how?: 'tab' | 'split') => void;
}) {
  return (
    <>
      {face.heading ? (
        <div className="sym-head" role="presentation">
          {face.heading}
        </div>
      ) : null}
      <div
        id={id}
        role="option"
        aria-selected={selected}
        className={cx('sym-hit', selected && 'is-on', face.missing && 'is-missing')}
        onPointerMove={onHover}
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => onPick?.(e.metaKey || e.ctrlKey ? 'tab' : e.shiftKey ? 'split' : undefined)}
      >
        <b className="sym">{face.symbol}</b>
        <span className="name">
          {face.name}
          {face.front ? <span className="front"> · Front</span> : null}
        </span>
        <span className={PRICE_TEXT}>{face.last}</span>
        <span className="chg" data-tone={face.pctTone}>
          {face.pct}
        </span>
      </div>
    </>
  );
}

function sampleHit(symbol: string, name: string, last: string, pct: string): HitFace {
  return {
    symbol,
    name,
    front: false,
    heading: null,
    last,
    pct,
    pctTone: pct.startsWith('-') ? 'down' : 'up',
    missing: false,
  };
}

const SAMPLE_HITS: readonly HitFace[] = [
  sampleHit('NQ Z6', 'E-mini Nasdaq-100 · CME Globex', '00,000.00', '+0.00%'),
  sampleHit('ES Z6', 'E-mini S&P 500 · CME Globex', '0,000.00', '+0.00%'),
  sampleHit('GC Z6', 'Gold · COMEX', '0,000.0', '-0.00%'),
  sampleHit('CL F7', 'Crude Oil · NYMEX', '00.00', '-0.00%'),
  sampleHit('RTY Z6', 'E-mini Russell 2000 · CME Globex', '0,000.0', '+0.00%'),
  sampleHit('YM Z6', 'E-mini Dow · CBOT', '00,000', '+0.00%'),
];

const SAMPLE_BRIEF = 'E-mini Nasdaq-100 · CME Globex · Regular · tick 0.25 = $5.00 · expires Fri 18 Dec 2026';

const stayOpen = () => undefined;

function HitsSample() {
  return (
    <>
      <div className="sym-hits">
        {SAMPLE_HITS.map((h, i) => (
          <HitRow key={h.symbol} face={h} selected={i === 0} />
        ))}
      </div>
      <footer className="sym-foot">
        <BriefWords words={SAMPLE_BRIEF} />
        <AllMarkets onClick={stayOpen} inert />
      </footer>
    </>
  );
}

function PopoverRowView({
  row,
  id,
  selected,
  onHover,
  onPick,
}: {
  row: PopoverRow;
  id: string;
  selected: boolean;
  onHover: () => void;
  onPick: (how?: 'tab' | 'split') => void;
}) {
  const { spec, resolved, missing } = useRowSpec(row.id, false, true);
  const info = useInstrumentInfo(row.name === null ? row.id : null, resolved);
  const q = useRowQuote(resolved, true);
  const { pct } = quoteChange(q);
  const symbol = displaySymbol(resolved ?? row.id);
  const name = missing
    ? 'No connection serves it'
    : symbolRowName({ symbol, instrument: row.id, catalog: row.name ?? info?.name ?? '' });
  return (
    <HitRow
      face={{
        symbol,
        name,
        front: row.front,
        heading: row.heading,
        last: q?.last !== undefined && q.last !== null ? formatPrice(q.last, spec?.priceDecimals ?? 2) : '',
        pct: pct === null ? '' : formatPercent(pct),
        pctTone: toneOf(pct),
        missing,
      }}
      id={id}
      selected={selected}
      onHover={onHover}
      onPick={onPick}
    />
  );
}

function useBriefFacts(id: string | null) {
  const { spec, resolved } = useRowSpec(id ?? '', false, id !== null);
  const info = useInstrumentInfo(id, resolved);
  const now = Math.floor(useNow() / 60_000) * 60_000;
  const sessions = useMarketSessions(spec && id ? (resolved ?? id) : null, now);
  return { spec, info, sessions, now };
}

function Brief({ id }: { id: string }) {
  const { spec, info, sessions, now } = useBriefFacts(id);
  const words = [
    info?.name ?? null,
    info ? venueLabel(info.exchange) : null,
    sessions ? marketSession(now, sessions).label : null,
    spec ? `tick ${tickWords(spec)}` : null,
    spec?.expiry ? `expires ${dayWords(spec.expiry) ?? spec.expiry}` : null,
  ].filter(Boolean);
  return <BriefWords words={words.join(' · ')} />;
}

function BriefWords({ words }: { words: string }) {
  return <span className="brief">{words}</span>;
}
