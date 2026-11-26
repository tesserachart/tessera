import { useBracketMode } from '../../chart/ticket/useTicketModel.ts';
import type { Side } from '@tessera/protocol';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  SampleSkeleton,
  Tooltip,
  formatPrice,
  useLoadPending,
} from '@tessera/ui';
import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ordersElsewhere, useLiveDrafts } from '../../app/orders.ts';
import { useClock } from '../../app/clock.ts';
import { useConnection } from '../../app/runtimeContext.ts';
import { draftsFor, groupBrackets } from '../../chart/brackets.ts';
import { placementFor, type PlaceQuote } from '../../chart/placement.ts';
import { usePlacementKeys } from '../../chart/placementRun.ts';
import { flowHub } from '../../market/flow/hub.ts';
import { useTileSight } from './inSight.ts';
import { useAccountContract } from '../../market/contracts.ts';
import { openConnections } from '../../accounts/navigate.ts';
import { displaySymbol, useInstrumentSpec } from '../../market/instruments.ts';
import { useQuoteReader } from '../../market/quotes.ts';
import { instrumentRoot } from '../../shell/oco.ts';
import { orderEntryOf } from '../../shell/orderEntry.ts';
import { useHasTool, useToolValue } from '../../app/tools.ts';
import { useShellData } from '../../shell/shellData.ts';
import { noticeLine } from '../../shell/noticeWords.ts';
import { askAnalyst, type ActionResult } from '../../shell/tradeActions.ts';
import { mathOf, useOco } from '../../shell/tradeContext.ts';
import { endPlacement, usePlacement } from '../../state/placement.ts';
import { BASE_TICKET } from '../../state/tickets.ts';
import { useClosedNote } from '../../markets/sessions.ts';
import { DomController, type DomContext, type MenuRow } from '../../orderflow/dom/domController.ts';
import {
  DEFAULT_DOM_PARAMS,
  domSummary,
  droppedReader,
  ladderHeader,
  ladderTags,
  LADDER_MIN_WIDTH,
  readDomParams,
  sizeWords,
  unsizedWords,
  type AccountGate,
  type DomParams,
  type EdgeMark,
  type HeaderCell,
  type LadderColumns,
  type Strip,
} from '../../orderflow/dom/ladderModel.ts';
import { LadderSample } from '../../orderflow/dom/LadderSample.tsx';
import { LadderView } from '../../orderflow/dom/ladderView.ts';
import {
  breakevenHere,
  breakevenView,
  cancelAllHere,
  closeTag,
  domTicketSend,
  flattenHere,
  hoverTrade,
  menuTrades,
  moveTag,
  placingLine,
  reverseHere,
  spawnFromPosition,
  tradeClick,
  type DomTradeSetup,
  type MenuTrade,
} from '../../orderflow/dom/trading.ts';
import { DomSettings } from '../../orderflow/dom/DomSettings.tsx';
import { addDomTile } from '../../orderflow/place.ts';
import { bindTileKeys } from '../../orderflow/tileKeys.ts';
import { useOrderKeys } from '../../chart/ticket/commands.ts';
import { runOrderKey } from '../../chart/ticket/orderKeys.ts';
import { BREAKEVEN_KEY } from '../../shell/keys.ts';
import type { OrderKeyAction } from '../../shell/orderHotkeys.ts';
import { setTileParams, useTileSettings } from '../dock/tileSettings.ts';
import { openTileSettings } from '../dock/tileSettingsUi.ts';
import { flowTab, flowTitle } from './flowTab.tsx';
import { PinnedRow } from './PinnedRow.tsx';
import { RowMetrics } from '../../orderflow/rowMetrics.ts';
import { useFollowedInstrument, useNoChartOpen, useSizingChart } from '../../orderflow/tileInstrument.ts';
import { NoChartOpen } from './NoChartOpen.tsx';
import { pickTicketAccount, useTicketTrade } from '../../chart/ticket/useTicketTrade.ts';
import { revealApproval } from '../../analyst/review.ts';
import { revealTile } from '../dock/open.ts';
import { registerTile, type TileSettingsProps } from './registry.ts';
import { FlowScope } from '../dock/header/Scope.tsx';

const OFF_PAPER = new Set(['eval', 'funded', 'live']);
const STRIP_FLIP_PX = 48;
const EDGES = ['above', 'below'] as const;

export function DomTile({ params, api }: IDockviewPanelProps<Partial<DomParams>>) {
  const p = readDomParams(params);
  const clock = useClock();
  const instrument = useFollowedInstrument(p);
  const noChart = useNoChartOpen(instrument);
  const spec = useInstrumentSpec(instrument);
  const broker = spec?.instrument ?? instrument;
  const symbol = broker ? displaySymbol(broker) : '';
  useEffect(() => {
    api.setTitle(flowTitle(symbol, 'DOM'));
  }, [api, symbol]);

  const { accounts, providers, allOrders } = useShellData();
  const sizer = useSizingChart(p.link, p.instrument);
  const unsized = instrument !== null && sizer === null;
  const trade = useTicketTrade(sizer?.tileId ?? BASE_TICKET);
  const { update: accountUpdate, orders, positions, entry } = trade;
  const scopeLayout = sizer?.layoutId ?? null;
  const scopeTile = sizer?.tileId ?? null;
  const scope = useMemo(
    () => (scopeLayout && scopeTile ? { layoutId: scopeLayout, tileId: scopeTile } : null),
    [scopeLayout, scopeTile],
  );
  const liveDrafts = useLiveDrafts();
  const conn = useConnection();
  const dropped = useMemo(() => droppedReader(conn, providers), [conn, providers]);
  const closed = useClosedNote(instrument);
  const hasConnections = useHasTool('connections.list');
  const connections = useToolValue('connections.list', hasConnections ? {} : null, { keepFor: 5_000 })?.connections;
  const tradable = accounts.filter((a) => orderEntryOf(a, connections).open).length;
  const { qty, sizing, risk, entry: entryKind } = trade.setup;
  const accountId = accountUpdate?.account.id ?? null;
  const drafts = useMemo(() => draftsFor(liveDrafts, accountId), [liveDrafts, accountId]);
  const root = broker ? instrumentRoot(broker, spec?.root ?? null) : null;
  const { saved: oco } = useOco(accountId, root);
  const traded = useAccountContract(accountUpdate && entry.open && !unsized ? accountId : null, broker);
  const execId = traded.instrument ?? broker;
  const math = useMemo(() => mathOf(traded.spec ?? spec, execId), [traded.spec, spec, execId]);
  const placing = usePlacement((s) => s.placing);

  const ids = useMemo(
    () => new Set([instrument, spec?.instrument, traded.instrument].filter((x): x is string => !!x)),
    [instrument, spec?.instrument, traded.instrument],
  );
  const brackets = useMemo(() => groupBrackets(orders, positions, drafts, ids), [orders, positions, drafts, ids]);
  const tick = math?.tick ?? 0.01;
  const elsewhere = useMemo(
    () =>
      ordersElsewhere(allOrders, accountId, accounts).flatMap(({ account, orders: theirs }) =>
        ladderTags(groupBrackets(theirs, [], [], ids), tick).map((t) => ({
          ...t,
          key: `${account.id}:${t.key}`,
          orders: [],
          account,
        })),
      ),
    [allOrders, accountId, accounts, ids, tick],
  );
  const tags = useMemo(() => [...ladderTags(brackets, tick), ...elsewhere], [brackets, tick, elsewhere]);
  const posBracket = brackets.find((b) => b.kind === 'position') ?? null;
  const gate: AccountGate = !accountUpdate
    ? { kind: 'none' }
    : unsized
      ? { kind: 'readonly', why: unsizedWords(symbol) }
      : !entry.open
        ? { kind: 'readonly', why: entry.why }
        : traded.refused !== null
          ? { kind: 'refused', why: traded.refused }
          : traded.pending
            ? { kind: 'readonly', why: `Asking ${accountUpdate.account.displayName}'s connection for ${symbol}` }
            : { kind: 'open', offPaper: OFF_PAPER.has(accountUpdate.account.environment) };
  const bracketMode = useBracketMode();
  const orderKeys = useOrderKeys();
  const setup: DomTradeSetup = {
    account: accountUpdate,
    gate,
    instrument: execId ?? '',
    ids,
    symbol,
    math,
    ticket: { qty, sizing, risk, entry: entryKind },
    oco,
    scope,
    mode: bracketMode,
  };
  const here = placementFor(placing, accountId, ids, scope);
  const position = posBracket
    ? { side: posBracket.side, qty: posBracket.qty, average: posBracket.price, bracket: posBracket }
    : null;

  const rowsRef = useRef<HTMLDivElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<DomController | null>(null);
  const readQuote = useQuoteReader(broker, () => ctrlRef.current?.invalidate());
  const [strip, setStrip] = useState<Strip | null>(null);
  const [edges, setEdges] = useState<readonly EdgeMark[]>([]);
  const [columns, setColumns] = useState<LadderColumns | null>(null);
  const [loading, setLoading] = useState(true);
  useLoadPending(loading && !!instrument);
  const [menu, setMenu] = useState<{ row: MenuRow; trades: MenuTrade[] } | null>(null);
  const [stripTop, setStripTop] = useState(false);

  const report = (r: ActionResult | null) => {
    if (r && r.tone !== 'ok')
      ctrlRef.current?.say(
        noticeLine(r, accountUpdate?.account.displayName ?? null),
        r.tone === 'err' ? 'err' : 'info',
      );
  };
  const keyReport = (r: ActionResult) =>
    ctrlRef.current?.say(noticeLine(r, accountUpdate?.account.displayName ?? null), r.tone === 'err' ? 'err' : 'info');
  const latest = {
    setup,
    pickAccount: (id: string) => pickTicketAccount(sizer?.tileId ?? BASE_TICKET, id, accounts),
    drafts,
    brackets,
    position,
    report,
    keyReport,
    get quote() {
      return readQuote();
    },
    stopLimitTicks: trade.setup.stopLimitTicks,
    context: {
      params: p,
      gate,
      tags,
      position,
      placing: here,
      get quote(): PlaceQuote {
        const quote = readQuote();
        return { bid: quote?.bid ?? null, ask: quote?.ask ?? null, last: quote?.last ?? null };
      },
      dropped,
      closed,
      placingLine: (pl, price, qq) => placingLine(pl, price, qq, brackets),
      hoverTrade: (side, price, qq) => hoverTrade(setup, side, price, qq, position),
      decimals: math?.decimals ?? 2,
      who: tradable > 1 && accountUpdate ? accountUpdate.account.displayName : null,
    } satisfies DomContext,
  };
  const live = useRef(latest);
  useLayoutEffect(() => {
    live.current = latest;
    ctrlRef.current?.invalidate();
  });

  useLayoutEffect(() => {
    const el = rowsRef.current;
    const frame = tileRef.current;
    if (!el || !frame) return;
    const view = new LadderView(el, frame);
    const metrics = new RowMetrics(el, () => ctrlRef.current?.invalidate());
    const rowHeight = () => metrics.rowH;
    const ctrl: DomController = new DomController(
      view,
      () => live.current.context,
      {
        trade: (side: Side, price: number): Promise<string | null> =>
          tradeClick(live.current.setup, side, price, ctrl.quote(), live.current.brackets, live.current.report),
        close: (tag) => void closeTag(live.current.setup, tag).then(live.current.report),
        endPlacement,
        move: (tag, from, to) =>
          moveTag(live.current.setup, tag, from, to).then((r) => {
            live.current.report(r);
            return r === null || r.tone === 'ok';
          }),
        spawn: (price) => {
          const pos = live.current.position;
          if (pos)
            void spawnFromPosition(live.current.setup, pos.bracket, price, ctrl.quote().last).then(live.current.report);
        },
        pickAccount: (id) => live.current.pickAccount(id),
        showDraft: (tag) =>
          revealApproval(live.current.drafts.find((d) => d.draftId === tag.draftId)?.approvalId ?? null),
        setRowTicks: (rt) => setTileParams<DomParams>(api, { rowTicks: rt }),
        cancelAll: () => void cancelAllHere(live.current.setup).then(live.current.report),
        flatten: () => void flattenHere(live.current.setup).then(live.current.report),
        strip: setStrip,
        edge: setEdges,
        columns: setColumns,
        loading: setLoading,
      },
      rowHeight,
    );
    ctrlRef.current = ctrl;
    const ro = new ResizeObserver(() => {
      metrics.refresh();
      ctrl.onResized();
    });
    ro.observe(el);
    const unbind = bindTileKeys('dom', frame, {
      scroll: (rows) => ctrl.scroll(rows),
      page: (dir) => ctrl.scroll(dir * ctrl.page),
      centre: () => ctrl.centre(),
      holding: () => ctrl.holding,
      escape: () => void ctrl.escape(),
      cancelAll: () => void cancelAllHere(live.current.setup).then(live.current.report),
      flatten: () => void flattenHere(live.current.setup).then(live.current.report),
      breakeven: () =>
        void breakevenHere(live.current.setup, live.current.position?.bracket ?? null).then(live.current.report),
      order: (action) => {
        const l = live.current;
        const ticket = domTicketSend(l.setup, l.quote, l.brackets, l.stopLimitTicks);
        runOrderKey(action, ticket, l.keyReport);
      },
      sends: () => live.current.setup.gate.kind === 'open',
    });
    return () => {
      unbind();
      ro.disconnect();
      metrics.dispose();
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, [api]);

  useTileSight(api, (inSight) => ctrlRef.current?.setHidden(!inSight));

  const tickSize = spec?.tickSize ?? null;
  const decimals = spec?.priceDecimals ?? null;
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl || !instrument || tickSize === null || decimals === null) {
      ctrl?.setFlow(null, null);
      return;
    }
    const { flow, release } = flowHub(clock).acquire(instrument, tickSize, decimals);
    const offBook = flow.useBook();
    const offTrades = flow.useTrades();
    const profiles = p.volumeColumn === 'session' || p.traded === 'session' ? flow.useProfiles() : null;
    ctrl.setFlow(flow, profiles?.feed ?? null);
    return () => {
      ctrl.setFlow(null, null);
      profiles?.release();
      offTrades();
      offBook();
      release();
    };
  }, [clock, instrument, tickSize, decimals, p.volumeColumn, p.traded]);

  usePlacementKeys(here !== null, brackets, report);

  const onPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = tileRef.current?.getBoundingClientRect();
    if (!box) return;
    const near = e.clientY > box.bottom - STRIP_FLIP_PX;
    if (near !== stripTop) setStripTop(near);
  };

  return (
    <div
      ref={tileRef}
      className="tile dom-tile"
      tabIndex={0}
      data-focus-zone="dom"
      aria-label={symbol ? `${symbol} depth of market` : 'Depth of market'}
      onPointerMove={onPointer}
      onPointerDown={() => tileRef.current?.focus({ preventScroll: true })}
    >
      <LadderHeader cells={columns && !loading ? ladderHeader(columns, p) : []} />
      <div className="dom-rows">
        <ContextMenu
          onOpenChange={(o) => {
            if (o) ctrlRef.current?.menuOpened();
            else {
              ctrlRef.current?.menuClosed();
              setMenu(null);
            }
          }}
        >
          <ContextMenuTrigger asChild>
            <div
              ref={rowsRef}
              className="t-ladder"
              data-vol={p.volumeColumn}
              onContextMenu={(e) => {
                const ctrl = ctrlRef.current;
                const row = ctrl?.menuRow(e.clientX, e.clientY, e.target) ?? null;
                const trades = ctrl && row ? menuTrades(row, setup, ctrl.quote(), ctrl.entriesOpen().ok) : [];
                setMenu(ctrl && row ? { row, trades } : null);
              }}
            />
          </ContextMenuTrigger>
          <ContextMenuContent aria-label="Ladder menu">
            {menu ? (
              <RowMenu
                row={menu.row}
                symbol={symbol}
                gate={gate}
                trades={menu.trades}
                decimals={math?.decimals ?? 2}
                hasOrders={tags.some((t) => t.orders.length > 0)}
                hasPosition={position !== null}
                breakevenWhy={() => breakevenView(setup, posBracket).why}
                onTrade={(t) => {
                  const ctrl = ctrlRef.current;
                  if (!ctrl) return;
                  const open = ctrl.entriesOpen();
                  if (!open.ok) {
                    ctrl.say(`${open.why}; nothing sent`);
                    return;
                  }
                  void tradeClick(setup, t.side, t.price, ctrl.quote(), brackets, report, 'entry').then(
                    (why) => why && ctrlRef.current?.say(why),
                  );
                }}
                onCancelRow={() => {
                  for (const t of menu.row.tags) if (t.orders.length) void closeTag(setup, t).then(report);
                }}
                onCancelAll={() => void cancelAllHere(setup).then(report)}
                onFlatten={() => void flattenHere(setup).then(report)}
                onBreakeven={() => void breakevenHere(setup, posBracket).then(report)}
                onReverse={() => void reverseHere(setup, posBracket).then((r) => r && keyReport(r))}
                keys={orderKeys}
              />
            ) : null}
            {menu ? <ContextMenuSeparator /> : null}
            <ContextMenuItem onSelect={() => openTileSettings(api.id)}>Settings…</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {noChart ? <NoChartOpen /> : null}
        {loading && instrument ? (
          <SampleSkeleton
            label="Loading the book"
            className="pointer-events-none absolute inset-0 flex flex-col overflow-hidden bg-ink"
          >
            <LadderSample like={rowsRef} />
          </SampleSkeleton>
        ) : null}
        {EDGES.map((where) => {
          const marks = edges.filter((m) => m.where === where);
          return marks.length > 0 ? (
            <div key={where} className="t-ladder-edge" data-where={where}>
              {marks.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  data-role={m.role}
                  title={m.label}
                  aria-label={m.label}
                  onClick={() => (m.role === 'last' ? ctrlRef.current?.centre() : ctrlRef.current?.show(m.tick))}
                >
                  {where === 'above' ? '▲' : '▼'} {m.text}
                </button>
              ))}
            </div>
          ) : null;
        })}
        {strip ? (
          <div
            className="t-ladder-strip"
            role="status"
            data-at={stripTop ? 'top' : 'bottom'}
            data-tone={strip.tone}
            title={strip.right ? `${strip.left} · ${strip.right}` : strip.left}
          >
            <span className="l">{strip.left}</span>
            {strip.who ? <span className="who">{strip.who}</span> : null}
            {strip.right ? (
              <span className="rt" data-tone={strip.rightTone}>
                {strip.rightShort ? (
                  <>
                    <span className="long">{strip.right}</span>
                    <span className="short">{strip.rightShort}</span>
                  </>
                ) : (
                  strip.right
                )}
              </span>
            ) : null}
            {strip.action ? (
              <Button
                className="act"
                variant="quiet"
                size="s"
                onClick={() => {
                  const act = strip.action!;
                  if (act.section === 'connections') openConnections();
                  else void revealTile('accounts', { via: 'pointer', focus: true, tab: act.section });
                }}
              >
                {strip.action.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LadderHeader({ cells }: { cells: readonly HeaderCell[] }) {
  return (
    <div className="t-ladder-head">
      {cells.map((cell) =>
        cell.labels.length === 0 ? (
          <div key={cell.column} className="h" data-col={cell.column} />
        ) : (
          <Tooltip key={cell.column} content={cell.word} side="bottom">
            <div className="h" data-col={cell.column} data-align={cell.align}>
              {cell.labels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </Tooltip>
        ),
      )}
    </div>
  );
}

function RowMenu({
  row,
  symbol,
  gate,
  trades,
  decimals,
  hasOrders,
  hasPosition,
  breakevenWhy,
  onTrade,
  onCancelRow,
  onCancelAll,
  onFlatten,
  onBreakeven,
  onReverse,
  keys,
}: {
  row: MenuRow;
  symbol: string;
  gate: AccountGate;
  trades: MenuTrade[];
  decimals: number;
  hasOrders: boolean;
  hasPosition: boolean;
  breakevenWhy: () => string | null;
  onTrade: (t: MenuTrade) => void;
  onCancelRow: () => void;
  onCancelAll: () => void;
  onFlatten: () => void;
  onBreakeven: () => void;
  onReverse: () => void;
  keys: Partial<Record<OrderKeyAction, string>>;
}) {
  const px = (v: number) => formatPrice(v, decimals);
  const sends = gate.kind === 'open';
  const beWhy = sends && hasPosition ? breakevenWhy() : null;
  const entries = trades;
  const rowOrders = row.tags.flatMap((t) => t.orders).length;
  const facts = [
    row.bid > 0 ? `${sizeWords(row.bid)} bid` : null,
    row.ask > 0 ? `${sizeWords(row.ask)} offered` : null,
    row.volume > 0 ? `${sizeWords(row.volume)} traded this session` : null,
  ].filter((x): x is string => x !== null);
  return (
    <>
      <ContextMenuLabel>{px(row.price)}</ContextMenuLabel>
      {entries.map((e) => (
        <ContextMenuItem key={e.word} onSelect={() => onTrade(e)}>
          {e.word}
        </ContextMenuItem>
      ))}
      {sends && rowOrders > 0 ? (
        <ContextMenuItem destructive onSelect={onCancelRow} hint={String(rowOrders)}>
          Cancel orders at {px(row.price)}
        </ContextMenuItem>
      ) : null}
      {sends && hasOrders ? (
        <ContextMenuItem destructive onSelect={onCancelAll}>
          Cancel all {symbol}
        </ContextMenuItem>
      ) : null}
      {sends && hasPosition ? (
        <ContextMenuItem
          disabled={beWhy !== null}
          {...(beWhy !== null ? { hint: beWhy } : {})}
          shortcut={BREAKEVEN_KEY}
          onSelect={onBreakeven}
        >
          Breakeven
        </ContextMenuItem>
      ) : null}
      {sends && hasPosition ? (
        <ContextMenuItem onSelect={onReverse} {...(keys.reverse ? { shortcut: keys.reverse } : {})}>
          Reverse {symbol}
        </ContextMenuItem>
      ) : null}
      {sends && hasPosition ? (
        <ContextMenuItem onSelect={onFlatten} {...(keys.flatten ? { shortcut: keys.flatten } : {})}>
          Flatten {symbol}
        </ContextMenuItem>
      ) : null}
      {entries.length > 0 || (sends && (rowOrders > 0 || hasOrders || hasPosition)) ? <ContextMenuSeparator /> : null}
      <ContextMenuItem
        onSelect={() =>
          askAnalyst(
            `${symbol} at ${px(row.price)}: ${facts.length ? facts.join(', ') : 'nothing resting or traded there now'}. What does the order flow say about this price?`,
          )
        }
      >
        Ask the analyst about {px(row.price)}
      </ContextMenuItem>
    </>
  );
}

function DomSettingsForm({ panel }: TileSettingsProps) {
  const [params, set] = useTileSettings<DomParams>(panel.api, DEFAULT_DOM_PARAMS);
  const p = readDomParams(params);
  return (
    <>
      <PinnedRow instrument={p.instrument} onFollow={() => set({ instrument: undefined })} />
      <DomSettings params={p} onChange={set} />
    </>
  );
}

registerTile<Partial<DomParams>>({
  kind: 'dom',
  title: 'DOM',
  component: DomTile,
  home: 'centre',
  icon: 'dom',
  keywords: ['ladder', 'depth', 'book', 'order flow', 'scalp'],
  linkable: true,
  minWidth: LADDER_MIN_WIDTH,
  tab: flowTab('DOM'),
  scope: FlowScope,
  settings: { component: DomSettingsForm, summary: (params) => domSummary(readDomParams(params)) },
  add: addDomTile,
});
