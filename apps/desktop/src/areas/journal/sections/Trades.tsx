import type { Bucket, JournalCatalog, JournalTrade, Setup, TradeSortKey, TrashedTrade } from '@tessera/protocol';
import {
  Button,
  Check,
  ConfirmButton,
  IconButton,
  Loaded,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  SampleSkeleton,
  ScrollArea,
  Segmented,
  Select,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tooltip,
  Tr,
  cx,
  formatPrice,
  formatShortcut,
  usePlatform,
  formatMoney,
} from '@tessera/ui';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useHasTool, useTool, valueOf } from '../../../app/tools.ts';
import { useNow } from '../../../app/runtimeContext.ts';
import { useCatalog, useJournalAction, useScopedFilter, useTrades } from '../data.ts';
import { updateTrade, useTradesShown } from '../tradeEdits.ts';
import { ago } from '../model/dashboard.ts';
import { Badge, DirectionChip, Empty, PageHead, ResultBadge } from '../kit/index.ts';
import { clock, dayLabel, holdLabel, pct, plural, rLabel, shortDate, tone } from '../model/format.ts';
import { COLUMNS, deletePicks, groupByDay, shownColumns, stepRow, type ColumnId } from '../model/table.ts';
import { Rating, TagPicker } from '../parts/Common.tsx';
import { FilterBar } from '../parts/FilterBar.tsx';
import { openTrade, setJournal, useJournalUi } from '../store.ts';
import { SAMPLE_NOW_MS, SAMPLE_TRADE_LIST, SAMPLE_TRASH } from './samples.ts';
import { TradeDetail } from './TradeDetail.tsx';

export function Trades() {
  const trade = useJournalUi((s) => s.trade);
  const [tab, setTab] = useState<'all' | 'trash'>('all');
  if (trade) return <TradeDetail id={trade} />;
  return tab === 'trash' ? <TrashList onBack={() => setTab('all')} /> : <TradeList onTrash={() => setTab('trash')} />;
}

const ignore = () => undefined;

function TradeList({ onTrash }: { onTrash: () => void }) {
  return (
    <Loaded label="Loading the trades" sample={<TradesSample />}>
      <TradeListBody onTrash={onTrash} />
    </Loaded>
  );
}

function TrashList({ onBack }: { onBack: () => void }) {
  return (
    <Loaded label="Loading the trash" sample={<TrashSample />}>
      <TrashListBody onBack={onBack} />
    </Loaded>
  );
}

function TradeTabs({
  tab,
  trash,
  onChange,
}: {
  tab: 'all' | 'trash';
  trash: number | null;
  onChange: (t: 'all' | 'trash') => void;
}) {
  if (trash === null) return null;
  return (
    <Segmented<'all' | 'trash'>
      label="Trades or trash"
      className="jr-tabs"
      value={tab}
      onChange={onChange}
      options={[
        { value: 'all', label: 'All trades' },
        { value: 'trash', label: trash ? `Trash · ${String(trash)}` : 'Trash' },
      ]}
    />
  );
}

function useTrashCount(): number | null {
  const cat = valueOf(useCatalog());
  const has = useHasTool('journal.list_trash');
  return has ? (cat?.trash ?? 0) : null;
}

function TrashListBody({ onBack }: { onBack: () => void }) {
  const has = useHasTool('journal.list_trash');
  const q = useTool('journal.list_trash', has ? {} : null, { keepFor: 15_000 });
  const now = useNow();
  const trash = useTrashCount();
  return <TrashListView rows={valueOf(q)?.trades ?? []} found={q.isSuccess} trash={trash} now={now} onBack={onBack} />;
}

function TrashSample() {
  return <TrashListView rows={SAMPLE_TRASH} found trash={SAMPLE_TRASH.length} now={SAMPLE_NOW_MS} onBack={ignore} />;
}

function TrashListView({
  rows,
  found,
  trash,
  now,
  onBack,
}: {
  rows: readonly TrashedTrade[];
  found: boolean;
  trash: number | null;
  now: number;
  onBack: () => void;
}) {
  const act = useJournalAction();
  return (
    <div className="jr-trades">
      <PageHead title="Trades" sub="Deleted trades stay here until the trash is emptied">
        {rows.length ? (
          <ConfirmButton
            what="the trash"
            question={`Delete ${plural(rows.length, 'trade')} for good?`}
            onConfirm={() => void act('journal.purge_trash', {})}
          >
            Empty trash
          </ConfirmButton>
        ) : null}
      </PageHead>
      <div className="jr-tabrow">
        <TradeTabs tab="trash" trash={trash} onChange={(t) => t === 'all' && onBack()} />
      </div>
      <div className="jr-table-wrap" aria-label="Trash">
        <ScrollArea className="jr-scroll">
          {found && !rows.length ? (
            <Empty icon="trash" title="Trash is empty">
              Trades you delete wait here, and come back with their notes and tags when restored.
            </Empty>
          ) : (
            <Table className="jr-table">
              <THead>
                <tr>
                  <Th>Symbol</Th>
                  <Th>Direction</Th>
                  <Th>Entry</Th>
                  <Th align="right">P&amp;L</Th>
                  <Th>Deleted</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map(({ trade: t, trashedAt }) => (
                  <Tr key={t.id} className="jr-trow">
                    <Td className="col-sym">
                      <b>{t.symbol}</b>
                    </Td>
                    <Td>
                      <DirectionChip side={t.side} size="s" />
                    </Td>
                    <Td className="col-px">
                      <span className="px">{formatPrice(t.entryPrice, t.priceDecimals)}</span>
                      <span className="at">
                        {shortDate(t.tradeDate)} {clock(t.openedAt)}
                      </span>
                    </Td>
                    <Td align="right" className={cx('col-net', tone(t.netPnl))}>
                      {formatMoney(t.netPnl, { signed: true })}
                    </Td>
                    <Td className="t3">{ago(trashedAt, now)}</Td>
                    <Td align="right" className="col-trash-acts">
                      <Button size="s" variant="quiet" onClick={() => void act('journal.restore_trade', { id: t.id })}>
                        Restore
                      </Button>
                      <ConfirmButton
                        what="this trade"
                        question="Delete it for good?"
                        onConfirm={() => void act('journal.purge_trash', { ids: [t.id] })}
                      >
                        Delete forever
                      </ConfirmButton>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

function exportCsv(name: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TradeListBody({ onTrash }: { onTrash: () => void }) {
  const sort = useJournalUi((s) => s.sort);
  const ascending = useJournalUi((s) => s.ascending);
  const scoped = useScopedFilter(true);
  const [limit, setLimit] = useState(PAGE);
  const q = useTrades(scoped, sort, ascending, limit);
  const cat = valueOf(useCatalog());
  const act = useJournalAction();
  const trash = useTrashCount();
  const read = valueOf(q);
  const listed = read?.trades;
  const trades = useTradesShown(
    useMemo(() => listed ?? [], [listed]),
    cat ?? null,
  );
  return (
    <TradeListView
      trades={trades}
      total={read?.total ?? 0}
      summary={read?.summary}
      found={q.isSuccess}
      fetching={q.isFetching}
      catalog={cat ?? null}
      trash={trash}
      onTrash={onTrash}
      onMore={() => setLimit((l) => (trades.length >= l ? l + PAGE : l))}
      onExport={() =>
        void act('journal.export_trades', { filter: scoped }).then((out) => exportCsv(out.filename, out.csv))
      }
    />
  );
}

export function TradesSample() {
  return (
    <TradeListView
      trades={SAMPLE_TRADE_LIST.trades}
      total={SAMPLE_TRADE_LIST.total}
      summary={SAMPLE_TRADE_LIST.summary}
      found
      fetching={false}
      catalog={null}
      trash={0}
      onTrash={ignore}
      onMore={ignore}
      onExport={ignore}
    />
  );
}

interface TradeListViewProps {
  trades: readonly JournalTrade[];
  total: number;
  summary: Bucket | undefined;
  found: boolean;
  fetching: boolean;
  catalog: JournalCatalog | null;
  trash: number | null;
  onTrash: () => void;
  onMore: () => void;
  onExport: () => void;
}

function TradeListView({
  trades,
  total,
  summary,
  found,
  fetching,
  catalog: cat,
  trash,
  onTrash,
  onMore,
  onExport,
}: TradeListViewProps) {
  const platform = usePlatform();
  const filter = useJournalUi((s) => s.filter);
  const sort = useJournalUi((s) => s.sort);
  const ascending = useJournalUi((s) => s.ascending);
  const hidden = useJournalUi((s) => s.hidden);
  const shown = useJournalUi((s) => s.shown);
  const act = useJournalAction();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const reasonId = useId();
  const tableRef = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => trades.map((t) => t.id), [trades]);
  const cols = shownColumns(hidden, shown);
  const grouped = sort === 'opened' || sort === 'closed';
  const groups = grouped ? groupByDay(trades) : [{ date: '', trades, net: 0, n: 0, wins: 0, losses: 0 }];
  const { ids: deletable, brokerCount: fromConnection } = deletePicks(trades, picked);
  const deleteReason =
    fromConnection === 0
      ? null
      : deletable.length
        ? `${plural(fromConnection, 'trade')} from the connection will stay. Synced trades can’t be deleted.`
        : 'From the connection. Synced trades can’t be deleted.';
  const pick = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const sortBy = (key: TradeSortKey) =>
    setJournal(key === sort ? { ascending: !ascending } : { sort: key, ascending: false });
  const bulk = (patch: { reviewed?: boolean; rating?: number; addTags?: string[] }) =>
    void act('journal.bulk_update', { ids: [...picked], ...patch });
  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      const cur = trades.find((t) => t.id === cursor) ?? null;
      if (e.key === 'j' || e.key === 'ArrowDown') setCursor(stepRow(ids, cursor, 1));
      else if (e.key === 'k' || e.key === 'ArrowUp') setCursor(stepRow(ids, cursor, -1));
      else if (e.key === 'Enter' && cur) openTrade(cur.id);
      else if (e.key === 'x' && cur) pick(cur.id);
      else if (e.key === 'r' && cur) void updateTrade(cur.id, { reviewed: !cur.reviewed });
      else if (/^[1-5]$/.test(e.key) && cur) void updateTrade(cur.id, { rating: Number(e.key) });
      else return;
      e.preventDefault();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!cursor) return;
    tableRef.current?.querySelector(`[data-id="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);
  const more = trades.length < total;
  const colIds = cols.map((c) => c.id);
  const deleteButton = (
    <ConfirmButton
      question={`Delete ${plural(deletable.length, 'trade')}?`}
      blocked={!deletable.length}
      describedBy={deleteReason ? reasonId : undefined}
      onConfirm={() => {
        void act('journal.bulk_delete', { ids: deletable });
        setPicked(new Set());
      }}
    >
      Delete{deletable.length && deletable.length < picked.size ? ` ${String(deletable.length)}` : ''}
    </ConfirmButton>
  );
  return (
    <div className="jr-trades">
      <PageHead title="Trades">
        <Columns hidden={hidden} shown={shown} />
        <Button size="s" variant="quiet" onClick={onExport}>
          Export
        </Button>
      </PageHead>
      <div className="jr-tabrow">
        <TradeTabs tab="all" trash={trash} onChange={(t) => t === 'trash' && onTrash()} />
      </div>
      <FilterBar filter={filter} onChange={(f) => setJournal({ filter: f })} catalog={cat ?? null} />
      {picked.size ? (
        <div className="jr-bulk" role="toolbar" aria-label="Selected trades">
          <span>{String(picked.size)} selected</span>
          {deleteReason ? (
            <Tooltip content={deleteReason}>
              <span className="jr-bulk-del">{deleteButton}</span>
            </Tooltip>
          ) : (
            deleteButton
          )}
          {deleteReason ? (
            <span id={reasonId} className="sr-only">
              {deleteReason}
            </span>
          ) : null}
          <Button size="s" onClick={() => bulk({ reviewed: true })}>
            Mark reviewed
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button size="s" variant="quiet">
                Set rating
              </Button>
            </MenuTrigger>
            <MenuContent align="start">
              {[5, 4, 3, 2, 1].map((r) => (
                <MenuItem key={r} onSelect={() => bulk({ rating: r })}>
                  <Rating value={r} size="s" />
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => bulk({ rating: 0 })}>Clear rating</MenuItem>
            </MenuContent>
          </Menu>
          <TagPicker
            tags={cat?.tags ?? []}
            value={[]}
            onChange={(tags) => bulk({ addTags: tags })}
            trigger={
              <Button size="s" variant="quiet">
                Tag
              </Button>
            }
          />
          <Button size="s" variant="quiet" onClick={() => setPicked(new Set())}>
            Cancel
          </Button>
        </div>
      ) : null}
      <div className="jr-table-wrap" ref={tableRef} tabIndex={0} aria-label="Trades">
        <ScrollArea className="jr-scroll">
          <Table className="jr-table">
            <THead>
              <tr>
                <Th className="col-pick">
                  <Check
                    checked={picked.size > 0 && picked.size === ids.length ? true : picked.size ? 'mixed' : false}
                    onChange={(on) => setPicked(on ? new Set(ids) : new Set())}
                  >
                    <span className="sr-only">Pick all</span>
                  </Check>
                </Th>
                {cols.map((c) => (
                  <Th
                    key={c.id}
                    align={c.align}
                    className={cx(c.sort && 'is-sortable', c.sort === sort && 'is-sorted')}
                    aria-sort={c.sort === sort ? (ascending ? 'ascending' : 'descending') : undefined}
                    onClick={c.sort ? () => sortBy(c.sort!) : undefined}
                  >
                    {c.label}
                    {c.sort ? (
                      <span className={cx('jr-sortmark', c.sort !== sort && 'is-idle')}>
                        {c.sort === sort ? (ascending ? '↑' : '↓') : '↕'}
                      </span>
                    ) : null}
                  </Th>
                ))}
                <Th className="col-act">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {groups.map((g) => (
                <DayRows
                  key={g.date || 'all'}
                  date={g.date}
                  trades={g.trades}
                  sub={g.date ? { net: g.net, n: g.n, wins: g.wins, losses: g.losses } : null}
                  cols={colIds}
                  picked={picked}
                  cursor={cursor}
                  onPick={pick}
                  onCursor={setCursor}
                  setups={cat?.setups ?? []}
                />
              ))}
            </TBody>
          </Table>
          {found && !trades.length ? (
            <Empty
              icon="trades"
              title="No trades found"
              actions={
                Object.keys(filter).length ? undefined : (
                  <>
                    <Button onClick={() => setJournal({ section: 'import' })}>Manual entry</Button>
                    <Button variant="primary" onClick={() => setJournal({ section: 'import' })}>
                      Import CSV
                    </Button>
                  </>
                )
              }
            >
              {Object.keys(filter).length
                ? 'Try adjusting your filters.'
                : 'Trades on your connected accounts arrive by themselves; bring older ones from an export.'}
            </Empty>
          ) : null}
          {trades.length && more && fetching ? <LoadingMore cols={colIds} /> : null}
          {trades.length ? <Sentinel more={more} onMore={onMore} /> : null}
        </ScrollArea>
      </div>
      <div className="jr-foot">
        <span>{summary ? plural(total, 'trade') : ''}</span>
        {more ? <span className="text-t3">{String(trades.length)} shown</span> : null}
        {summary ? (
          <>
            <span className={summary.net > 0 ? 'up' : summary.net < 0 ? 'down' : undefined}>
              {formatMoney(summary.net, { signed: true })}
            </span>
            <span className="text-t3">win rate {pct(summary.winRate)}</span>
            <span className="text-t3">
              PF{' '}
              {summary.profitFactor === null ? (summary.grossProfit > 0 ? '∞' : '—') : summary.profitFactor.toFixed(2)}
            </span>
            {summary.nR ? <span className="text-t3">{rLabel(summary.totalR)} total</span> : null}
          </>
        ) : null}
        <span className="jr-foot-keys text-t4">
          j k move · {formatShortcut('enter', platform)} open · x pick · r reviewed · 1–5 rate
        </span>
      </div>
    </div>
  );
}

const PAGE = 100;

function LoadingMore({ cols }: { cols: ColumnId[] }) {
  return (
    <SampleSkeleton label="Loading more trades">
      <Table className="jr-table">
        <TBody>
          <TradeRow
            t={SAMPLE_TRADE_LIST.trades[0]!}
            cols={cols}
            picked={false}
            cursor={false}
            onPick={ignore}
            onCursor={ignore}
            setups={[]}
          />
        </TBody>
      </Table>
    </SampleSkeleton>
  );
}

function Sentinel({ more, onMore }: { more: boolean; onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onMore);
  useEffect(() => {
    cb.current = onMore;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) cb.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [more]);
  return (
    <div ref={ref} className="jr-sentinel text-t3">
      {more ? null : 'End of trades'}
    </div>
  );
}

function Columns({ hidden, shown }: { hidden: readonly ColumnId[]; shown: readonly ColumnId[] }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="s" variant="quiet">
          Columns
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>Columns</MenuLabel>
        {COLUMNS.filter((c) => !c.fixed).map((c) => {
          const on = c.visible ? !hidden.includes(c.id) : shown.includes(c.id);
          return (
            <MenuCheckboxItem
              key={c.id}
              checked={on}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(v) =>
                setJournal(
                  c.visible
                    ? { hidden: v ? hidden.filter((h) => h !== c.id) : [...hidden, c.id] }
                    : { shown: v ? [...shown, c.id] : shown.filter((h) => h !== c.id) },
                )
              }
            >
              {c.label}
            </MenuCheckboxItem>
          );
        })}
        <MenuItem onSelect={() => setJournal({ hidden: [], shown: [] })}>As they were</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function DayRows({
  date,
  trades,
  sub,
  cols,
  picked,
  cursor,
  onPick,
  onCursor,
  setups,
}: {
  date: string;
  trades: readonly JournalTrade[];
  sub: { net: number; n: number; wins: number; losses: number } | null;
  cols: ColumnId[];
  picked: ReadonlySet<string>;
  cursor: string | null;
  onPick: (id: string) => void;
  onCursor: (id: string) => void;
  setups: readonly Setup[];
}) {
  return (
    <>
      {sub ? (
        <tr className="jr-dayrow">
          <td colSpan={cols.length + 2}>
            <button type="button" onClick={() => setJournal({ section: 'days', day: date })}>
              <span className="jr-dayrow-d">{dayLabel(date)}</span>
              <span className={sub.net > 0 ? 'up' : sub.net < 0 ? 'down' : undefined}>
                {formatMoney(sub.net, { signed: true })}
              </span>
              <span className="text-t3">
                {plural(sub.n, 'trade')} · {String(sub.wins)}W {String(sub.losses)}L
              </span>
            </button>
          </td>
        </tr>
      ) : null}
      {trades.map((t) => (
        <TradeRow
          key={t.id}
          t={t}
          cols={cols}
          picked={picked.has(t.id)}
          cursor={cursor === t.id}
          onPick={() => onPick(t.id)}
          onCursor={() => onCursor(t.id)}
          setups={setups}
        />
      ))}
    </>
  );
}

function TradeRow({
  t,
  cols,
  picked,
  cursor,
  onPick,
  onCursor,
  setups,
}: {
  t: JournalTrade;
  cols: ColumnId[];
  picked: boolean;
  cursor: boolean;
  onPick: () => void;
  onCursor: () => void;
  setups: readonly Setup[];
}) {
  const act = useJournalAction();
  const dp = t.priceDecimals;
  const cell = (id: ColumnId) => {
    switch (id) {
      case 'symbol':
        return (
          <Td className="col-sym">
            <b>{t.symbol}</b>
          </Td>
        );
      case 'side':
        return (
          <Td>
            <DirectionChip side={t.side} size="s" />
          </Td>
        );
      case 'entry':
        return (
          <Td className="col-px">
            <span className="px">{formatPrice(t.entryPrice, dp)}</span>
            <span className="at">
              {shortDate(t.tradeDate)} {clock(t.openedAt)}
            </span>
          </Td>
        );
      case 'exit':
        return t.status === 'open' || t.exitPrice === null || t.closedAt === null ? (
          <Td className="col-px t3">Open</Td>
        ) : (
          <Td className="col-px">
            <span className="px">{formatPrice(t.exitPrice, dp)}</span>
            <span className="at">{clock(t.closedAt)}</span>
          </Td>
        );
      case 'qty':
        return <Td align="right">{t.qty}</Td>;
      case 'net':
        return (
          <Td align="right" className={cx('col-net', tone(t.netPnl))}>
            {t.status === 'open' ? <span className="text-t3">—</span> : formatMoney(t.netPnl, { signed: true })}
          </Td>
        );
      case 'r':
        return (
          <Td align="right" className={t.rMultiple === null ? 't4' : t.rMultiple >= 0 ? 'up' : 'down'}>
            {rLabel(t.rMultiple)}
          </Td>
        );
      case 'hold':
        return (
          <Td align="right" className="t3">
            {holdLabel(t.holdSecs)}
          </Td>
        );
      case 'result':
        return (
          <Td>
            <ResultBadge result={t.result} />
          </Td>
        );
      case 'setup':
        return (
          <Td className="col-setup">
            <Select
              size="s"
              variant="quiet"
              label="Setup"
              value={t.setupId ?? NO_SETUP}
              onValueChange={(v) => void updateTrade(t.id, { setupId: v === NO_SETUP ? null : v })}
              options={[
                { value: NO_SETUP, label: <span className="text-t4">—</span>, textValue: 'No setup' },
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
              ]}
            />
          </Td>
        );
      case 'tags':
        return (
          <Td className="col-tags">
            <span className="jr-badges">
              {t.tags.slice(0, 2).map((g) => (
                <Badge key={g.id} color={g.color}>
                  {g.name}
                </Badge>
              ))}
              {t.tags.length > 2 ? <span className="text-t3">+{t.tags.length - 2}</span> : null}
            </span>
          </Td>
        );
      case 'rating':
        return (
          <Td className="col-rating">
            <Rating value={t.rating} size="s" onChange={(r) => void updateTrade(t.id, { rating: r })} />
          </Td>
        );
      case 'reviewed':
        return (
          <Td className="col-rev">
            <button
              type="button"
              className={cx('jr-revc', t.reviewed && 'is-on')}
              aria-pressed={t.reviewed}
              aria-label={t.reviewed ? 'Reviewed' : 'Not reviewed'}
              onClick={(e) => {
                e.stopPropagation();
                void updateTrade(t.id, { reviewed: !t.reviewed });
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" />
                {t.reviewed ? <path d="M5 8.2l2 2 4-4.4" /> : null}
              </svg>
            </button>
            {t.hasNotes ? (
              <span className="jr-glyph" title="Notes">
                ¶
              </span>
            ) : null}
            {t.attachments ? (
              <span className="jr-glyph" title={`${String(t.attachments)} files`}>
                ▣
              </span>
            ) : null}
          </Td>
        );
      case 'account':
        return <Td className="t3 col-acct">{t.accountName}</Td>;
      case 'fees':
        return (
          <Td align="right" className="t3">
            {formatMoney(-t.fees, { signed: true })}
          </Td>
        );
      case 'mae':
        return (
          <Td align="right" className="t3">
            {t.mae === null ? '—' : `${formatMoney(t.mae, { signed: true })} · ${formatMoney(t.mfe, { signed: true })}`}
          </Td>
        );
    }
  };
  return (
    <Tr
      selected={cursor}
      data-id={t.id}
      className={cx('jr-trow', picked && 'is-picked')}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, label, [role="combobox"]')) return;
        onCursor();
        openTrade(t.id);
      }}
    >
      <Td className="col-pick">
        <Check checked={picked} onChange={onPick}>
          <span className="sr-only">Pick</span>
        </Check>
      </Td>
      {cols.map((id) => (
        <CellFragment key={id}>{cell(id)}</CellFragment>
      ))}
      <Td className="col-act">
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="Trade actions" icon="more" className="jr-rowmenu w-7 h-7" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => openTrade(t.id)}>View details</MenuItem>
            <MenuItem
              disabled={t.origin === 'broker'}
              why={t.origin === 'broker' ? 'From the connection' : undefined}
              onSelect={() => void act('journal.delete_trade', { id: t.id })}
            >
              Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      </Td>
    </Tr>
  );
}

const NO_SETUP = 'none';

function CellFragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
