import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Icon,
  Menu,
  MenuContent,
  MenuTrigger,
  ScrollArea,
  SampleSkeleton,
  Tooltip,
  cx,
  formatPercent,
  formatPrice,
  formatSigned,
  formatVolume,
  toneOf,
  type Tone,
  PRICE_TEXT,
} from '@tessera/ui';
import {
  useCallback,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useInstrumentInfo } from '../../chart/identity.ts';
import { displaySymbol } from '../../market/instruments.ts';
import { quoteChange } from '../../market/quotes.ts';
import { OPEN_KEYS, OPEN_WORDS, removeFromWatchlist, type OpenHow } from '../../markets/actions.ts';
import { nextSort, type MarketSort, type MarketSortKey } from '../../markets/lists.ts';
import {
  RowVisibilityContext,
  createRowVisibility,
  firstScreenRows,
  useRowInView,
  useRowQuote,
  useRowSpec,
  type RowVisibility,
} from '../../markets/rowData.ts';
import { WatchlistItems } from '../../markets/WatchlistItems.tsx';
import { editWatchlists, moveSymbol, type Watchlist } from '../../markets/watchlists.ts';
import { marketSession, useMarketSessions } from '../../markets/sessions.ts';
import { rowName, type MarketRow, type Section } from './model.ts';

const COLUMNS: { key: string; label: string; title: string; sort?: MarketSortKey; num?: boolean }[] = [
  { key: 'sym', label: 'Symbol', title: 'Symbol', sort: 'symbol' },
  { key: 'last', label: 'Last', title: 'Last price', sort: 'last', num: true },
  { key: 'chg', label: 'Chg', title: 'Change since the prior close', sort: 'chg', num: true },
  { key: 'pct', label: 'Chg%', title: 'Change since the prior close, in percent', sort: 'pct', num: true },
  { key: 'vol', label: 'Vol', title: 'Volume today', sort: 'vol', num: true },
  { key: 'hi', label: 'High', title: 'Session high', num: true },
  { key: 'lo', label: 'Low', title: 'Session low', num: true },
  { key: 'sess', label: 'Session', title: 'Where the market is in its trading hours now' },
];

export interface TableProps {
  sections: readonly Section[];
  showSource: boolean;
  selected: ReadonlySet<string>;
  cursor: string | null;
  charted: (row: MarketRow) => boolean;
  watchlist: Watchlist | null;
  sort: MarketSort | null;
  onSort: (sort: MarketSort | null) => void;
  onClick: (row: MarketRow, e: MouseEvent) => void;
  onOpen: (row: MarketRow, how: OpenHow) => void;
  targetsOf: (row: MarketRow) => MarketRow[];
  onMenu: (row: MarketRow) => void;
  nowMs: number;
  notes: ReactNode;
  empty: ReactNode;
  domId: (row: MarketRow) => string;
  onKeyDown: (e: KeyboardEvent) => void;
  label: string;
}

type Column = (typeof COLUMNS)[number];

function PlainHeading({ column: c }: { column: Column }) {
  return (
    <span role="columnheader" className={cx('h', `c-${c.key}`, c.num && 'num')} title={c.title}>
      {c.label}
    </span>
  );
}

function TableHead({
  sort,
  onSort,
  showSource,
}: {
  sort: MarketSort | null;
  onSort: (sort: MarketSort | null) => void;
  showSource: boolean;
}) {
  return (
    <div className="mk-head" role="row">
      {COLUMNS.map((c) => {
        const on = c.sort !== undefined && sort?.key === c.sort;
        return c.sort ? (
          <button
            key={c.key}
            type="button"
            role="columnheader"
            className={cx('h', `c-${c.key}`, on && 'is-on', c.num && 'num')}
            title={c.title}
            aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            onClick={() => onSort(nextSort(sort, c.sort!))}
          >
            {c.label}
            {on ? <Icon name={sort.dir === 'asc' ? 'sort-asc' : 'sort-desc'} className="dir" /> : null}
          </button>
        ) : (
          <PlainHeading key={c.key} column={c} />
        );
      })}
      {showSource ? (
        <span role="columnheader" className="h c-src" title="The connection that serves it">
          Connection
        </span>
      ) : null}
      <span className="h c-act" />
    </div>
  );
}

interface RowFace {
  symbol: string;
  name: string;
  front: boolean;
  last: string;
  change: string;
  changeTone: Tone;
  pct: string;
  pctTone: Tone;
  vol: string;
  high: string;
  low: string;
  session: string;
  open: boolean | null;
}

function RowCells({ face, source, act }: { face: RowFace; source: string | null; act: ReactNode }) {
  return (
    <>
      <span className="c-sym">
        <b>{face.symbol}</b>
        <span className="nm">{face.name}</span>
        {face.front ? <span className="front">Front</span> : null}
      </span>
      <span className={cx('c-last', PRICE_TEXT)}>{face.last}</span>
      <span className="c-chg" data-tone={face.changeTone}>
        {face.change}
      </span>
      <span className="c-pct" data-tone={face.pctTone}>
        {face.pct}
      </span>
      <span className="c-vol">{face.vol}</span>
      <span className={cx('c-hi', PRICE_TEXT)}>{face.high}</span>
      <span className={cx('c-lo', PRICE_TEXT)}>{face.low}</span>
      <span className="c-sess" data-open={face.open ?? undefined}>
        {face.session}
      </span>
      {source !== null ? <span className="c-src">{source}</span> : null}
      <span className="c-act">{act}</span>
    </>
  );
}

function sampleFace(symbol: string, name: string, last: string, change: string, pct: string, vol: string): RowFace {
  const tone: Tone = change.startsWith('-') ? 'down' : 'up';
  return {
    symbol,
    name,
    front: false,
    last,
    change,
    changeTone: tone,
    pct,
    pctTone: tone,
    vol,
    high: last,
    low: last,
    session: 'Regular',
    open: true,
  };
}

const SAMPLE_FACES: readonly RowFace[] = [
  sampleFace('NQ Z6', 'E-mini Nasdaq-100 Dec 2026', '00,000.00', '+000.00', '+0.00%', '000.0K'),
  sampleFace('ES Z6', 'E-mini S&P 500 Dec 2026', '0,000.00', '+00.00', '+0.00%', '0.00M'),
  sampleFace('GC Z6', 'Gold Dec 2026', '0,000.0', '-00.0', '-0.00%', '000.0K'),
  sampleFace('CL F7', 'Crude Oil Jan 2027', '00.00', '-0.00', '-0.00%', '000.0K'),
  sampleFace('RTY Z6', 'E-mini Russell 2000 Dec 2026', '0,000.0', '+00.0', '+0.00%', '00.0K'),
];

const SAMPLE_ACTS = (
  <>
    <button type="button" className="x" aria-label="Add to a watchlist">
      <Icon name="plus" />
    </button>
    <button type="button" className="x" aria-label="Chart">
      <Icon name="chart" />
    </button>
  </>
);

function SampleRows({ rows }: { rows: number }) {
  return Array.from({ length: rows }, (_, i) => (
    <div key={i} className="mk-row">
      <RowCells face={SAMPLE_FACES[i % SAMPLE_FACES.length]!} source={null} act={SAMPLE_ACTS} />
    </div>
  ));
}

const SAMPLE_ROWS = 14;

const leaveSort = () => undefined;

export function MarketTableSample() {
  return (
    <div className="mk-table">
      <TableHead sort={null} onSort={leaveSort} showSource={false} />
      <ScrollArea className="mk-scroll">
        <div className="mk-rows">
          <div className="mk-sec">
            <SampleRows rows={SAMPLE_ROWS} />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

export function MarketRowsSkeleton({ rows }: { rows: number }) {
  return (
    <SampleSkeleton label="Searching markets">
      <SampleRows rows={rows} />
    </SampleSkeleton>
  );
}

export function MarketTable(p: TableProps) {
  const [vis, setVis] = useState<RowVisibility | null>(null);
  const onViewport = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const v = createRowVisibility(el);
    setVis(v);
    return () => v.dispose();
  }, []);
  const [menuRow, setMenuRow] = useState<MarketRow | null>(null);
  const canDrag = p.watchlist !== null && p.sort === null;
  const firstScreen = firstScreenRows();
  const starts: number[] = [];
  let total = 0;
  for (const s of p.sections) {
    starts.push(total);
    total += s.rows.length;
  }
  return (
    <div className={cx('mk-table', p.showSource && 'with-src')}>
      <TableHead sort={p.sort} onSort={p.onSort} showSource={p.showSource} />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ScrollArea
            className="mk-scroll"
            viewportRef={onViewport}
            onContextMenu={(e) => {
              if (!(e.target instanceof Element && e.target.closest('.mk-row'))) e.preventDefault();
            }}
          >
            <RowVisibilityContext.Provider value={vis}>
              <div
                className="mk-rows"
                role="listbox"
                aria-label={p.label}
                aria-multiselectable="true"
                tabIndex={0}
                aria-activedescendant={p.cursor ? cursorDomId(p) : undefined}
                onKeyDown={p.onKeyDown}
              >
                {p.notes}
                {p.sections.map((s, si) => (
                  <div key={s.key} role="group" aria-label={s.title} className="mk-sec">
                    {s.title ? (
                      <div className="mk-sec-head" role="presentation">
                        <b>{s.title}</b>
                        {s.meta ? <span className="meta">{s.meta}</span> : null}
                      </div>
                    ) : null}
                    {s.rows.map((r, i) => (
                      <Row
                        key={r.key}
                        row={r}
                        index={i}
                        eager={starts[si]! + i < firstScreen}
                        domId={p.domId(r)}
                        selected={p.selected.has(r.key)}
                        cursor={p.cursor === r.key}
                        charted={p.charted(r)}
                        showSource={p.showSource}
                        section={s.key}
                        watchlist={p.watchlist}
                        draggable={canDrag}
                        nowMs={p.nowMs}
                        targets={() => p.targetsOf(r)}
                        onClick={(e) => p.onClick(r, e)}
                        onOpen={(how) => p.onOpen(r, how)}
                        onMenu={() => {
                          p.onMenu(r);
                          setMenuRow(r);
                        }}
                      />
                    ))}
                  </div>
                ))}
                {p.sections.every((s) => s.rows.length === 0) ? p.empty : null}
              </div>
            </RowVisibilityContext.Provider>
          </ScrollArea>
        </ContextMenuTrigger>
        <RowMenu
          row={menuRow}
          targets={menuRow ? p.targetsOf(menuRow) : []}
          watchlist={p.watchlist}
          onOpen={p.onOpen}
        />
      </ContextMenu>
    </div>
  );
}

function cursorDomId(p: TableProps): string | undefined {
  for (const s of p.sections) {
    const r = s.rows.find((x) => x.key === p.cursor);
    if (r) return p.domId(r);
  }
  return undefined;
}

function RowMenu({
  row,
  targets,
  watchlist,
  onOpen,
}: {
  row: MarketRow | null;
  targets: MarketRow[];
  watchlist: Watchlist | null;
  onOpen: (row: MarketRow, how: OpenHow) => void;
}) {
  if (!row) return <ContextMenuContent style={{ width: 240 }} />;
  const many = targets.length > 1;
  const symbols = targets.map((t) => t.id);
  const at = watchlist && !many ? watchlist.symbols.indexOf(row.id) : -1;
  const how = (h: OpenHow) => (
    <ContextMenuItem key={h} shortcut={OPEN_KEYS[h]} disabled={many && h === 'chart'} onSelect={() => onOpen(row, h)}>
      {OPEN_WORDS[h]}
      {many && h !== 'chart' ? ` (${String(targets.length)})` : ''}
    </ContextMenuItem>
  );
  return (
    <ContextMenuContent style={{ width: 240 }}>
      {(['chart', 'tab', 'split', 'dom'] as const).map(how)}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>Add to watchlist</ContextMenuSubTrigger>
        <ContextMenuSubContent style={{ minWidth: 200 }}>
          <WatchlistItems symbols={symbols} context />
        </ContextMenuSubContent>
      </ContextMenuSub>
      {watchlist ? (
        <ContextMenuItem destructive shortcut="delete" onSelect={() => removeFromWatchlist(watchlist.id, symbols)}>
          Remove from {watchlist.name}
        </ContextMenuItem>
      ) : null}
      {at >= 0 ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={at === 0}
            onSelect={() => editWatchlists((w) => moveSymbol(w, watchlist!.id, row.id, at - 1))}
          >
            Move up
          </ContextMenuItem>
          <ContextMenuItem
            disabled={at === watchlist!.symbols.length - 1}
            onSelect={() => editWatchlists((w) => moveSymbol(w, watchlist!.id, row.id, at + 1))}
          >
            Move down
          </ContextMenuItem>
          <ContextMenuItem
            disabled={at === 0}
            onSelect={() => editWatchlists((w) => moveSymbol(w, watchlist!.id, row.id, 0))}
          >
            Move to top
          </ContextMenuItem>
        </>
      ) : null}
    </ContextMenuContent>
  );
}

const DRAG_TYPE = 'text/x-tessera-symbol';

function Row({
  row,
  index,
  eager,
  domId,
  selected,
  cursor,
  charted,
  showSource,
  section,
  watchlist,
  draggable,
  nowMs,
  targets,
  onClick,
  onOpen,
  onMenu,
}: {
  row: MarketRow;
  index: number;
  eager: boolean;
  domId: string;
  selected: boolean;
  cursor: boolean;
  charted: boolean;
  showSource: boolean;
  section: string;
  watchlist: Watchlist | null;
  draggable: boolean;
  nowMs: number;
  targets: () => MarketRow[];
  onClick: (e: MouseEvent) => void;
  onOpen: (how: OpenHow) => void;
  onMenu: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { visible, seen } = useRowInView(ref, eager);
  const { spec, resolved, missing } = useRowSpec(row.id, row.instrument !== null, seen);
  const info = useInstrumentInfo(seen && !row.instrument ? row.id : null, resolved);
  const q = useRowQuote(resolved, visible || eager, seen);
  const [over, setOver] = useState<'above' | 'below' | null>(null);
  const i = row.instrument ?? info;
  const dp = spec?.priceDecimals ?? 2;
  const { change, pct } = quoteChange(q);
  const vol = q?.session?.volume ?? null;
  const symbol = displaySymbol(resolved ?? row.id);
  const name = missing ? 'No connection serves it' : i ? rowName(section, i) : '';
  const sessions = useMarketSessions(seen && spec ? (resolved ?? row.id) : null, nowMs);
  const now = sessions ? marketSession(nowMs, sessions) : null;
  const session = now?.label ?? null;
  const open = now?.open ?? null;
  const price = (v: number | null | undefined) => (v === null || v === undefined ? '' : formatPrice(v, dp));
  const onDragOver = (e: DragEvent) => {
    if (!draggable || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setOver(e.clientY < r.top + r.height / 2 ? 'above' : 'below');
  };
  const onDrop = (e: DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const at = over === 'below' ? index + 1 : index;
    setOver(null);
    if (!id || !watchlist) return;
    e.preventDefault();
    const from = watchlist.symbols.indexOf(id);
    editWatchlists((w) => moveSymbol(w, watchlist.id, id, from >= 0 && at > from ? at - 1 : at));
  };
  return (
    <div
      ref={ref}
      id={domId}
      role="option"
      aria-selected={selected}
      aria-current={charted ? 'true' : undefined}
      aria-label={symbol}
      className={cx(
        'mk-row',
        selected && 'is-sel',
        cursor && 'is-cursor',
        charted && 'is-charted',
        missing && 'is-missing',
        over && `drop-${over}`,
      )}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, row.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(null)}
      onDrop={onDrop}
      onClick={onClick}
      onDoubleClick={() => onOpen('chart')}
      onContextMenu={onMenu}
    >
      <RowCells
        face={{
          symbol,
          name,
          front: i?.isFront === true && Boolean(i.root),
          last: price(q?.last),
          change: change === null ? '' : formatSigned(change, dp, true),
          changeTone: toneOf(change),
          pct: pct === null ? '' : formatPercent(pct),
          pctTone: toneOf(pct),
          vol: vol && vol > 0 ? formatVolume(vol) : '',
          high: price(q?.session?.high),
          low: price(q?.session?.low),
          session: session ?? '',
          open,
        }}
        source={showSource ? (row.connection?.name ?? '') : null}
        act={
          <>
            {watchlist ? (
              <Tooltip content={`Remove from ${watchlist.name}`} shortcut="delete">
                <button
                  type="button"
                  className="x"
                  aria-label={`Remove ${symbol} from ${watchlist.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFromWatchlist(
                      watchlist.id,
                      targets().map((t) => t.id),
                    );
                  }}
                >
                  <Icon name="remove" />
                </button>
              </Tooltip>
            ) : (
              <Menu>
                <Tooltip content="Add to watchlist" shortcut="+">
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      className="x"
                      aria-label={`Add ${symbol} to a watchlist`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Icon name="plus" />
                    </button>
                  </MenuTrigger>
                </Tooltip>
                <MenuContent align="end" style={{ minWidth: 200 }}>
                  <WatchlistItems symbols={targets().map((t) => t.id)} />
                </MenuContent>
              </Menu>
            )}
            <Tooltip content={OPEN_WORDS.chart} shortcut="enter">
              <button
                type="button"
                className="x"
                aria-label={`Chart ${symbol}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen('chart');
                }}
              >
                <Icon name="chart" />
              </button>
            </Tooltip>
          </>
        }
      />
    </div>
  );
}
