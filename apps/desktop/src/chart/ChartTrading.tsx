import {
  LEGEND_INSET,
  ORDER_TAG_H,
  ORDER_TAG_LANE_GAP,
  ORDER_TAG_MORE_W,
  layoutOrderTags,
  type AskTarget,
  type SizedOrderTag,
  type BracketsLayer,
  type ChartApi,
} from '@tessera/chart';
import { type ChartLayer, type ContractSpec, type Level, type Order, type Side } from '@tessera/protocol';
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Toast,
  Tooltip,
  cx,
  formatPrice,
} from '@tessera/ui';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { ordersElsewhere, useLiveDrafts } from '../app/orders.ts';
import { useTopicEffect } from '../app/useTopic.ts';
import { displaySymbol, withPresets } from '../market/instruments.ts';
import { useQuote } from '../market/quotes.ts';
import { pricesStale, useFeeds } from '../shell/freshness.ts';
import { useShellData } from '../shell/shellData.ts';
import {
  bracketPalette,
  bracketScene,
  bracketTags,
  draftsFor,
  elsewhereTags,
  groupBrackets,
  namedTags,
  readOnlyTags,
  restingPrice,
  type Bracket,
  type ChartMath,
  type SceneOptions,
  type TagModel,
} from './brackets.ts';
import { addDrawing, removeAllDrawings } from './drawings/actions.ts';
import { drawingsOn } from './drawings/model.ts';
import { shownDrawings } from './drawings/sources.ts';
import { orderColorsOf, useChartTheme } from './chartTheme.ts';
import { IndicatorMenuItems } from './settings/IndicatorMenu.tsx';
import type { AlertSeed } from '../alerts/form.ts';
import { openAlertForm } from '../alerts/formStore.ts';
import { chartPlotChoices, drawingChoice, levelChoice } from '../alerts/seed.ts';
import { askLabel, askQuestion, orderFlowAsks } from './orderflowAsk.ts';
import { TemplateMenuRow } from './templates/TemplateMenu.tsx';
import { isLevelShown } from './levels.ts';
import {
  GHOST_ID,
  clickAt,
  hostReference,
  legError,
  legHostOf,
  legMoveError,
  chartHint,
  placeGuide,
  placementFor,
  placementGhost,
  placementHost,
  spawnPlan,
  withGhost,
  type Ghost,
  type PlaceQuote,
} from './placement.ts';
import { menuTrade } from './menuTrade.ts';
import { runPlaceStep, usePlacementKeys } from './placementRun.ts';
import { noteOnChart } from './chartNotice.ts';
import { LEVELS, levelShown, setLevelStyle } from './levelSettings.ts';
import { useLevelSources } from './useLevelSources.ts';
import { CHART_TYPE_WORD, chartTypeOf, useStageView, layoutsStore } from '../state/layouts.ts';
import { useUi } from '../state/ui.ts';
import { endPlacement, usePlacement } from '../state/placement.ts';
import { useTradeSettings, tradeSettingsStore, setLevels } from '../state/tradeSettings.ts';
import { readSetting, useSetting } from '../state/runtimeSettings.ts';
import { splitWithSymbol } from '../workspace/addChart.ts';
import { ChartTypeItems } from './ChartTools.tsx';
import { setChartTimeframe } from '../workspace/controller.ts';
import { instrumentRoot } from '../shell/oco.ts';
import { pickTicketAccount, useTicketTrade } from './ticket/useTicketTrade.ts';
import { useBracketMode, useTicketInstrument } from './ticket/useTicketModel.ts';
import { runOrderKey } from './ticket/orderKeys.ts';
import { reverseOf, ticketSendOf } from './ticket/send.ts';
import { limitLockWords } from '../accounts/limits.ts';
import { draftEditInput, draftEditWords, type DraftPart } from './draftEdit.ts';
import { analystStore } from '../analyst/analystStore.ts';
import { revealApproval } from '../analyst/review.ts';
import { resolveOco, mathOf } from '../shell/tradeContext.ts';
import { BREAKEVEN_KEY } from '../shell/keys.ts';
import type { OrderKeyAction } from '../shell/orderHotkeys.ts';
import { useRuntimeEntry } from '../shell/orderEntry.ts';
import { dropOnSecondaryPress, isPrimaryPress } from '../shell/secondaryPress.ts';
import { breakevenOf, breakevenOffset } from './breakeven.ts';
import { bindChartKeys, useOrderKeys } from './ticket/commands.ts';
import {
  askAnalyst,
  attachLeg,
  breakeven,
  cancelOrders,
  flatten,
  moveOrders,
  openHome,
  resolveNow,
  runtimeFailureWords,
  shiftedBy,
  submitOrder,
  type ActionResult,
} from '../shell/tradeActions.ts';
import { toTick } from '../shell/ticket.ts';
import { read } from '../app/store.ts';
import { SETTLE_MS } from '../app/settle.ts';
import { chartPanels, openBesideChart } from '../workspace/chartPanels.ts';
import { failureText, ranUnread } from '../app/tools.ts';
import { TRADING_STATE_ATTR } from '../share/quiet.ts';
import { displayZone } from '../state/timeZone.ts';

const FAN_GAP = ORDER_TAG_LANE_GAP;
const NOTE_H = { oneLine: 42, air: 24 };
const EDGE_HIT = 4;
const LEGEND_BAND = LEGEND_INSET;

let measureCtx: CanvasRenderingContext2D | null = null;
function tagWidth(text: string): number {
  measureCtx ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!measureCtx) return reserve(text.length * 7 + 52);
  measureCtx.font = "500 12px 'Instrument Sans', sans-serif";
  return reserve(measureCtx.measureText(text).width + 52);
}

const reserve = (w: number) => Math.ceil(w / 8) * 8;

const tabular = (text: string) => text.replace(/\d/g, '0');

function tagGeometry(tag: Element, words: Element): string {
  const text = [...words.childNodes]
    .map((n) => (n instanceof Element && n.classList.contains('fig') ? n.textContent : tabular(n.textContent ?? '')))
    .join('');
  return `${tag.className}|${String(tag.childElementCount)}|${text}`;
}

const PRICE_RE = /(?<![$\d.,])\d{1,3}(?:,\d{3})*\.\d{2,}/g;

function figures(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PRICE_RE)) {
    const i = m.index;
    if (i > last) out.push(text.slice(last, i));
    out.push(
      <span key={i} className="fig">
        {m[0]}
      </span>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const TRADE_ROWS: readonly (readonly [Side, 'limit' | 'stop'])[] = [
  ['buy', 'limit'],
  ['buy', 'stop'],
  ['sell', 'limit'],
  ['sell', 'stop'],
];

function settledIn(d: Drag, orders: readonly Order[], brackets: readonly Bracket[], tick: number): boolean {
  const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < tick / 2;
  if (d.settleLeg) {
    const { role, price } = d.settleLeg;
    return brackets.some((b) =>
      (role === 'stop' ? b.stops : b.targets).some((l) => l.order !== null && near(l.price, price)),
    );
  }
  return (d.settle ?? []).every((t) => {
    const cur = orders.find((o) => o.id === t.id);
    return !cur || !isWorking(cur) || near(restingPrice(cur.request), t.price);
  });
}

function isWorking(o: Order): boolean {
  return o.status !== 'filled' && o.status !== 'cancelled' && o.status !== 'rejected' && o.status !== 'expired';
}

function chartMathFor(spec: ContractSpec | null, instrument: string): ChartMath {
  const m = mathOf(spec, instrument);
  return {
    decimals: m?.decimals ?? 2,
    tick: m?.tick ?? 0.01,
    multiplier: spec ? spec.multiplier : m ? m.tickValue / m.tick : null,
  };
}

function useGeometry(chart: ChartApi | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!chart) return;
    let key = '';
    const check = () => {
      const c = chart.coords();
      const k = [c.plot.x, c.plot.y, c.plot.w, c.plot.h, c.yOfPrice(0), c.yOfPrice(1), c.from, c.to, c.barSpacing]
        .map((v) => v.toFixed(2))
        .join('|');
      if (k !== key) {
        key = k;
        setVersion((v) => v + 1);
      }
    };
    check();
    const offFrame = chart.on('frame', check);
    const offView = chart.on('viewport', check);
    return () => {
      offFrame();
      offView();
    };
  }, [chart]);
  return version;
}

interface Drag {
  tagId: string;
  from: number;
  price: number;
  orders: Order[];
  phase: 'drag' | 'keys' | 'sending' | 'settling';
  pointer: number | null;
  settle?: readonly { id: string; price: number }[];
  settleLeg?: { role: 'stop' | 'target'; price: number };
  settleUntil?: number;
  spawn?: string;
  draft?: { draftId: string; part: DraftPart };
}

function settling(sending: Drag): Drag {
  return { ...sending, phase: 'settling', settleUntil: Date.now() + SETTLE_MS };
}

interface MenuTarget {
  x: number;
  y: number;
  client: { x: number; y: number };
  price: number;
  time: number | null;
  tag: TagModel | null;
  level: Level | null;
  asks: AskTarget[];
}

export interface ChartTradingProps {
  chart: ChartApi | null;
  layer: BracketsLayer | null;
  layoutId: string;
  tileId: string;
  instrument: string;
  ids: ReadonlySet<string>;
  spec: ContractSpec | null | undefined;
  levels: readonly Level[];
  layers: readonly ChartLayer[];
  children: ReactNode;
}

export function ChartTrading(props: ChartTradingProps) {
  const { chart, layer, layoutId, tileId, instrument, ids, spec, levels, layers, children } = props;
  const { update: accountUpdate, orders, positions, env, entry, setup } = useTicketTrade(tileId);
  const runtime = useRuntimeEntry();
  const accountId = accountUpdate?.account.id ?? null;
  const exec = useTicketInstrument({ layoutId, tileId, instrument }, accountId);
  const live = useLiveDrafts();
  const drafts = useMemo(() => (live === null ? null : draftsFor(live, accountId)), [live, accountId]);
  const quote = useQuote(exec.instrument);
  const chartQuote = useQuote(instrument);
  const feeds = useFeeds();
  const stale = pricesStale(feeds, (quote ?? chartQuote)?.source?.provider ?? null)?.words ?? null;
  const mode = useBracketMode();
  const version = useGeometry(chart);
  const [fanned, setFanned] = useState<{ id: string; pinned: boolean } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [held, setDrag] = useState<Drag | null>(null);
  const playing = accountUpdate?.account.displayName ?? null;
  const setShelf = (r: ActionResult | null) => {
    if (r) noteOnChart({ layoutId, tileId }, r, { account: playing });
  };
  useTopicEffect('protection', accountId ? { accountId } : null, (n) => {
    if (exec.ids.has(n.instrument) || ids.has(n.instrument)) {
      noteOnChart(
        { layoutId, tileId },
        { tone: n.tone === 'err' ? 'err' : 'info', text: n.text },
        { account: playing },
      );
    }
  });
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const tagRefs = useRef(new Map<string, HTMLDivElement>());
  const measuredAs = useRef(new Map<string, string>());
  const [tagWidths, setTagWidths] = useState<ReadonlyMap<string, number>>(new Map());
  const [revealedTag, setRevealedTag] = useState<string | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let active = true;
    void document.fonts.ready.then(() => active && setFontsReady(true));
    return () => {
      active = false;
    };
  }, []);

  const math: ChartMath = useMemo(() => chartMathFor(exec.spec, exec.instrument), [exec.spec, exec.instrument]);
  const chartMath: ChartMath = useMemo(() => chartMathFor(spec ?? null, instrument), [spec, instrument]);
  const themed = useChartTheme((s) => s.resolved);
  const pal = useMemo(() => bracketPalette(orderColorsOf(themed)), [themed]);
  const execBrackets = useMemo(
    () => groupBrackets(orders, positions, drafts ?? [], exec.ids),
    [orders, positions, drafts, exec.ids],
  );
  const chartBrackets = useMemo(
    () => (exec.differs ? groupBrackets(orders, positions, drafts ?? [], ids) : []),
    [exec.differs, orders, positions, drafts, ids],
  );
  const brackets = useMemo(() => [...execBrackets, ...chartBrackets], [execBrackets, chartBrackets]);
  const { allOrders, accounts } = useShellData();
  const elsewhere = useMemo(
    () =>
      ordersElsewhere(allOrders, accountId, accounts).map(({ account, orders: theirs }) => ({
        account,
        brackets: groupBrackets(theirs, [], [], ids),
      })),
    [allOrders, accountId, accounts, ids],
  );
  const settled =
    held?.phase === 'settling' && settledIn(held, orders, brackets, chartMathFor(exec.spec, exec.instrument).tick);
  const drag = settled ? null : held;
  useEffect(() => {
    if (held?.phase !== 'settling') return;
    const wait = settled ? 0 : Math.max(0, (held.settleUntil ?? 0) - Date.now());
    const t = window.setTimeout(() => setDrag((cur) => (cur === held ? null : cur)), wait);
    return () => window.clearTimeout(t);
  }, [held, settled]);
  const chartOwn = useMemo(() => new Set(chartBrackets.map((b) => b.id)), [chartBrackets]);
  const execName = exec.differs ? instrumentRoot(exec.instrument, exec.spec?.root ?? null) : null;
  const tagsOf = (list: readonly Bracket[], o: SceneOptions): TagModel[] => [
    ...namedTags(
      bracketTags(
        list.filter((b) => !chartOwn.has(b.id)),
        math,
        pal,
        o,
      ),
      execName,
    ),
    ...bracketTags(
      list.filter((b) => chartOwn.has(b.id)),
      chartMath,
      pal,
      o,
    ),
  ];
  const readOnly = !runtime.open ? runtime.why : entry.open ? null : entry.why;
  const hostOf = (b: Bracket) => (readOnly === null ? legHostOf(b, accountId) : null);
  const q: PlaceQuote = { bid: quote?.bid ?? null, ask: quote?.ask ?? null, last: quote?.last ?? null };

  const placing = usePlacement((st) => st.placing);
  const place = placementFor(placing, accountId, exec.ids, { layoutId, tileId });
  const [placeHover, setPlaceHover] = useState<{ x: number; y: number; price: number } | null>(null);
  const placeFilled = place ? (placementHost(place, execBrackets)?.filled ?? false) : false;
  const placeInfo = place && placeHover ? placeGuide(place, placeHover.price, q, placeFilled) : null;

  const spawnFrom = drag?.spawn ? (brackets.find((b) => b.id === drag.spawn) ?? null) : null;
  const spawn = spawnFrom && drag ? spawnPlan(spawnFrom, drag.from, drag.price) : null;
  const spawnHost = spawnFrom ? hostOf(spawnFrom) : null;
  const spawnError =
    spawn && !spawn.move && spawnHost && drag?.phase === 'drag'
      ? legError(
          spawnHost.side,
          spawn.role,
          drag.price,
          hostReference(spawnHost, spawnFrom!.price, q.last),
          math.decimals,
        )
      : null;

  const ghost: Ghost | null =
    drag?.spawn && spawn && !spawn.move
      ? { host: { id: drag.spawn }, legs: [{ role: spawn.role, price: drag.price }] }
      : place && !drag
        ? placementGhost(place, placeHover?.price ?? null, execBrackets, q)
        : null;
  const ghostKey = ghost ? JSON.stringify(ghost) : '';
  const drawn = useMemo(() => withGhost(brackets, ghost), [brackets, ghostKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const fannedId = fanned?.id ?? null;
  const preview = !drag
    ? null
    : drag.spawn
      ? spawn?.move
        ? { tagId: spawn.move.tagId, price: drag.price }
        : null
      : { tagId: drag.tagId, price: drag.price };
  const opts = useMemo(() => ({ fanned: fannedId, preview, stale }), [fannedId, preview?.tagId, preview?.price, stale]); // eslint-disable-line react-hooks/exhaustive-deps
  const tags = useMemo(() => {
    const all = tagsOf(drawn, opts);
    return readOnly === null ? all : readOnlyTags(all);
  }, [drawn, math, chartMath, chartOwn, execName, pal, opts, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  const theirTags = useMemo(
    () => elsewhere.flatMap(({ account, brackets: b }) => elsewhereTags(bracketTags(b, chartMath, pal, opts), account)),
    [elsewhere, chartMath, pal, opts],
  );
  const shownTags = useMemo(() => [...tags, ...theirTags], [tags, theirTags]);
  const scene = useMemo(() => bracketScene(drawn, tags, pal, opts), [drawn, tags, pal, opts]);
  const movingId = drag?.spawn ? (spawn ? (spawn.move?.tagId ?? `${drag.spawn}:${spawn.role}`) : null) : drag?.tagId;
  const ghostTags = useMemo(
    () =>
      new Set(
        ghost
          ? tags
              .filter((t) =>
                'id' in ghost.host
                  ? t.bracketId === ghost.host.id && ghost.legs.some((l) => l.role === t.part)
                  : t.bracketId === GHOST_ID,
              )
              .map((t) => t.id)
          : [],
      ),
    [tags, ghostKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    layer?.setScene(scene);
  }, [layer, scene]);

  const focusTag = tags.find((t) => t.id === (movingId ?? hover)) ?? null;
  const roleColor = (role: 'entry' | 'stop' | 'target') =>
    role === 'stop' ? pal.down : role === 'target' ? pal.up : pal.mist;
  const guide = placeInfo
    ? { price: placeInfo.price, color: roleColor(placeInfo.role) }
    : focusTag
      ? { price: focusTag.price, color: focusTag.color }
      : null;
  useEffect(() => {
    if (!layer) return;
    const axis: { price: number; color: string }[] = [];
    const pos = brackets.find((b) => b.kind === 'position');
    if (pos) axis.push({ price: pos.price, color: pal.mist });
    if (guide && !(pos && !placeInfo && focusTag?.id === `${pos.id}:entry`)) axis.push(guide);
    layer.setAxisPrices(axis);
    layer.setGuide(guide);
  }, [layer, brackets, guide?.price, guide?.color, pal]); // eslint-disable-line react-hooks/exhaustive-deps

  usePlacementKeys(place !== null, execBrackets, setShelf);

  const coords = chart && version >= 0 ? chart.coords() : null;
  const environment = accountUpdate?.account.environment ?? env ?? null;
  const symbol = displaySymbol(instrument);
  const root = instrumentRoot(exec.instrument, exec.spec?.root ?? null);
  const snap = (p: number) => toTick(p, math.tick);
  const noteKey = (r: ActionResult, retry?: () => void) =>
    noteOnChart({ layoutId, tileId }, r, { account: playing, ...(retry ? { retry } : {}) });
  const keyLive = () =>
    ticketSendOf({
      account: accountUpdate,
      why: readOnly ?? exec.unavailable,
      instrument: exec.instrument,
      symbol: exec.symbol,
      math: mathOf(exec.spec ?? null, exec.instrument),
      setup,
      oco: resolveOco(read(tradeSettingsStore), accountId ?? '', root),
      quote: quote ?? chartQuote,
      brackets: execBrackets,
      mode,
      tile: { layoutId, tileId },
    });
  const execPosition = execBrackets.find((b) => b.kind === 'position') ?? null;
  const reverseView = reverseOf(execPosition);
  const orderKeys = useOrderKeys();
  const beLive = useRef({ accountId, readOnly, execBrackets, math, root, setShelf, noteKey, keyLive });
  useEffect(() => {
    beLive.current = { accountId, readOnly, execBrackets, math, root, setShelf, noteKey, keyLive };
  });
  useEffect(() => {
    const now = () => {
      const l = beLive.current;
      const position = l.execBrackets.find((b) => b.kind === 'position') ?? null;
      const offset = l.accountId ? breakevenOffset(resolveOco(read(tradeSettingsStore), l.accountId, l.root)) : null;
      return { l, position, offset, view: breakevenOf(position, l.math.tick, offset) };
    };
    return bindChartKeys(tileId, {
      canBreakeven: () => {
        const { l, view } = now();
        return l.readOnly === null && l.accountId !== null && view.why === null;
      },
      breakeven: () => {
        const { l, position, offset, view } = now();
        if (l.readOnly !== null || !l.accountId || !position || view.why !== null) return;
        const symbol = displaySymbol(position.instrument);
        void breakeven(l.accountId, position.instrument, symbol, offset, l.math.decimals).then(l.setShelf);
      },
      order: (action) => {
        const l = beLive.current;
        runOrderKey(action, l.keyLive(), l.noteKey);
      },
    });
  }, [tileId]);

  const baseTags = useMemo(() => {
    const all = tagsOf(brackets, { fanned: fannedId, preview: null, stale });
    return readOnly === null ? all : readOnlyTags(all);
  }, [brackets, math, chartMath, chartOwn, execName, pal, fannedId, readOnly, stale]); // eslint-disable-line react-hooks/exhaustive-deps
  const baseTag = (id: string) => baseTags.find((t) => t.id === id) ?? null;
  const moveRefusal = (tagId: string, price: number): string | null => {
    const tag = baseTag(tagId);
    const b = tag ? brackets.find((x) => x.id === tag.bracketId) : undefined;
    if (!tag || !b || tag.part === 'entry') return null;
    const own = chartOwn.has(b.id);
    const last = (own ? chartQuote : quote)?.last ?? null;
    return legMoveError(b, tag.part, price, last, (own ? chartMath : math).decimals);
  };
  const moveError =
    preview && (drag?.phase === 'drag' || drag?.phase === 'keys') ? moveRefusal(preview.tagId, preview.price) : null;
  const dropError = spawnError ?? moveError;

  const layout = useMemo(() => {
    if (!coords) return [];
    const sized = shownTags.map((tag): SizedOrderTag => {
      const base = baseTag(tag.id);
      const moving = tag.id === movingId || ghostTags.has(tag.id);
      return {
        ...tag,
        ...(tag.id === revealedTag ? { priority: Number.MAX_SAFE_INTEGER, fanned: false } : {}),
        width: tagWidths.get(tag.id) ?? tagWidth(tag.text),
        ...(moving ? (base ? { packPrice: base.price } : { floating: true }) : {}),
      };
    });
    return layoutOrderTags(sized, (price) => coords.yOfPrice(price), coords.plot).map((at) => ({
      ...at,
      tag: shownTags[at.index]!,
      py: at.priceY,
      moving: sized[at.index]!.packPrice !== undefined || !!sized[at.index]!.floating,
    }));
  }, [shownTags, coords, version, tagWidths, revealedTag, fontsReady, movingId, ghostTags, baseTags]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleTags = layout.filter((tag) => !tag.overflow);
  const overflowTags = layout.filter((tag) => tag.overflow);
  const visibleKey = visibleTags.map((at) => at.tag.id).join('\n');

  useLayoutEffect(() => {
    const current = new Set(shownTags.map((tag) => tag.id));
    const measured = new Map([...tagWidths].filter(([id]) => current.has(id)));
    let changed = measured.size !== tagWidths.size;
    for (const id of measuredAs.current.keys()) if (!current.has(id)) measuredAs.current.delete(id);
    for (const tag of shownTags) {
      if (tag.id === movingId || ghostTags.has(tag.id)) continue;
      const el = tagRefs.current.get(tag.id);
      const words = el?.querySelector('.txt');
      if (!el || !words) continue;
      const geometry = `${String(fontsReady)}|${tagGeometry(el, words)}`;
      if (measuredAs.current.get(tag.id) === geometry) continue;
      const range = document.createRange();
      range.selectNodeContents(words);
      if (typeof range.getBoundingClientRect !== 'function') continue;
      const textWidth = range.getBoundingClientRect().width;
      if (textWidth === 0) continue;
      const style = getComputedStyle(el);
      const value = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
      const controls = [...el.children].filter((child) => child !== words);
      const width = reserve(
        textWidth +
          controls.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) +
          controls.length * value('column-gap') +
          value('padding-left') +
          value('padding-right') +
          value('border-left-width') +
          value('border-right-width'),
      );
      measuredAs.current.set(tag.id, geometry);
      if (width > (measured.get(tag.id) ?? 0)) {
        measured.set(tag.id, width);
        changed = true;
      }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (changed) setTagWidths(measured);
  }, [shownTags, tagWidths, movingId, ghostTags, fontsReady, visibleKey]);

  const maybeCollapse = (x: number, y: number) => {
    if (!fanned || fanned.pinned || drag) return;
    const host = hostRef.current?.getBoundingClientRect();
    if (!host) return;
    let near = false;
    for (const [id, el] of tagRefs.current) {
      if (!id.startsWith(fanned.id)) continue;
      const r = el.getBoundingClientRect();
      const left = r.left - host.left - 12 - FAN_GAP;
      if (x >= left && x <= r.right - host.left + 12 && y >= r.top - host.top - 12 && y <= r.bottom - host.top + 12) {
        near = true;
        break;
      }
    }
    if (!near) setFanned(null);
  };

  const startX = (since: number | null) => {
    if (!coords) return 0;
    const right = coords.plot.x + coords.plot.w;
    const fallback = right - 160;
    if (since === null) return fallback;
    const x = coords.xOfTime(since);
    if (x === null) return fallback;
    if (x < coords.plot.x) return coords.plot.x;
    return Math.min(x, fallback);
  };

  const answered = (sending: Drag, next: Drag | null) => {
    setDrag((cur) => (cur === sending ? next : cur));
  };

  const commit = async (d: Drag) => {
    if (!environment) return;
    const delta = d.price - d.from;
    if (delta === 0 || d.orders.length === 0) {
      setDrag(null);
      return;
    }
    const refused = moveRefusal(d.tagId, snap(d.price));
    if (refused) {
      setDrag(null);
      setShelf({ tone: 'err', text: `${refused}. Nothing sent.` });
      return;
    }
    const moves = shiftedBy(d.orders, delta, math.tick);
    const sending: Drag = { ...d, phase: 'sending', settle: moves.map((m) => ({ id: m.order.id, price: m.price })) };
    setDrag(sending);
    const result = await moveOrders(environment, moves);
    if (result.tone !== 'ok') {
      answered(sending, null);
      setShelf(result);
      return;
    }
    answered(sending, settling(sending));
  };

  const release = (d: Drag) => {
    if (d.price === d.from) {
      setDrag(null);
      return;
    }
    if (d.draft) void editDraft(d, d.draft);
    else if (d.spawn) void spawnLeg(d);
    else void commit(d);
  };

  const editDraft = async (d: Drag, at: NonNullable<Drag['draft']>) => {
    const info = (drafts ?? []).find((x) => x.draftId === at.draftId);
    const approval = info ? (read(analystStore).approvals ?? []).find((a) => a.id === info.approvalId) : null;
    const price = snap(d.price);
    const input = approval ? draftEditInput(approval.input, at.part, price) : null;
    if (!approval || input === null) {
      setDrag(null);
      setShelf({ tone: 'err', text: 'This draft cannot be moved here; review it on its card.' });
      return;
    }
    const sending: Drag = { ...d, phase: 'sending' };
    setDrag(sending);
    try {
      await resolveNow({ approvalId: approval.id, decision: 'edit', previewHash: approval.previewHash, input });
      setShelf({ tone: 'ok', text: draftEditWords(at.part, formatPrice(price, math.decimals)) });
    } catch (err) {
      if (ranUnread(err)) setShelf({ tone: 'ok', text: draftEditWords(at.part, formatPrice(price, math.decimals)) });
      else setShelf({ tone: 'err', text: runtimeFailureWords(err) ?? `${failureText(err)}. The draft is as it was.` });
    }
    answered(sending, null);
  };

  const spawnLeg = async (d: Drag) => {
    const b = brackets.find((x) => x.id === d.spawn);
    const plan = b ? spawnPlan(b, d.from, d.price) : null;
    const host = b ? legHostOf(b, accountId) : null;
    if (!b || !plan || !host || !environment) {
      setDrag(null);
      return;
    }
    if (plan.move) {
      void commit({ ...d, tagId: plan.move.tagId, from: plan.move.from, orders: plan.move.orders, spawn: undefined });
      return;
    }
    const price = snap(d.price);
    const err = legError(host.side, plan.role, price, hostReference(host, b.price, q.last), math.decimals);
    if (err) {
      setDrag(null);
      setShelf({ tone: 'err', text: `${err}. Nothing sent.` });
      return;
    }
    const sending: Drag = { ...d, phase: 'sending', settleLeg: { role: plan.role, price } };
    setDrag(sending);
    const what = `${plan.role === 'stop' ? 'Stop' : 'Target'} ${formatPrice(price, math.decimals)} on ${symbol}`;
    const r = await attachLeg(environment, host, plan.role, price, what, math.decimals);
    setShelf(r);
    answered(sending, r.tone === 'err' ? null : settling(sending));
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setDrag(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag]);

  const inHand = held?.phase === 'drag' || held?.phase === 'keys';
  useEffect(() => {
    if (!inHand) return;
    return dropOnSecondaryPress(window, () => {
      flushSync(() => setDrag(null));
      return true;
    });
  }, [inHand]);

  const placingHere = place !== null;
  useEffect(() => {
    if (!placingHere) return;
    return dropOnSecondaryPress(window, (e) => {
      if (!(e.target instanceof Node) || !hostRef.current?.contains(e.target)) return false;
      endPlacement();
      return true;
    });
  }, [placingHere]);

  const priceAt = (clientY: number): number | null => {
    const host = hostRef.current;
    if (!host || !coords) return null;
    return snap(coords.priceOfY(clientY - host.getBoundingClientRect().top));
  };

  const startDrag = (tag: TagModel, e: ReactPointerEvent<HTMLElement>) => {
    const draft = draftOf(tag);
    if (!isPrimaryPress(e) || (tag.drag.length === 0 && !draft) || drag?.phase === 'sending') return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const base = baseTag(tag.id) ?? tag;
    setDrag({
      tagId: tag.id,
      from: base.price,
      price: base.price,
      orders: tag.drag,
      phase: 'drag',
      pointer: e.pointerId,
      ...(draft ? { draft } : {}),
    });
  };
  const draftOf = (tag: TagModel): Drag['draft'] | null => {
    if (!tag.draft || readOnly !== null) return null;
    const b = brackets.find((x) => x.id === tag.bracketId);
    if (!b?.draftId || (tag.part === 'entry' && b.type === 'market')) return null;
    return { draftId: b.draftId, part: tag.part };
  };
  const startSpawn = (b: Bracket, tagId: string, e: ReactPointerEvent<HTMLElement>) => {
    if (!isPrimaryPress(e) || drag?.phase === 'sending') return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ tagId, from: b.price, price: b.price, orders: [], phase: 'drag', pointer: e.pointerId, spawn: b.id });
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag?.phase !== 'drag' || drag.pointer !== e.pointerId) return;
    const p = priceAt(e.clientY);
    if (p !== null && p !== drag.price) setDrag({ ...drag, price: p });
  };
  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag?.phase !== 'drag' || drag.pointer !== e.pointerId) return;
    release(drag);
  };

  const keyOnTag = (tag: TagModel, e: ReactKeyboardEvent<HTMLElement>) => {
    if (tag.account && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      pickTicketAccount(tileId, tag.account.id, accounts);
      return;
    }
    if (tag.drag.length === 0) return;
    const base = baseTag(tag.id) ?? tag;
    const d = drag?.tagId === tag.id ? drag : null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const n = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 4 : 1);
      const cur = d?.price ?? base.price;
      setDrag({
        tagId: tag.id,
        from: base.price,
        price: snap(cur + n * math.tick),
        orders: tag.drag,
        phase: 'keys',
        pointer: null,
      });
    } else if (e.key === 'Enter' && d?.phase === 'keys') {
      e.preventDefault();
      release(d);
    }
  };

  const close = async (tag: TagModel) => {
    if (!tag.close || !accountId) return;
    if (tag.close.kind === 'flatten') {
      const pos = brackets.find((b) => b.id === tag.bracketId);
      const held = pos && pos.instrument !== '' ? pos.instrument : exec.instrument;
      setShelf(await flatten(accountId, held, displaySymbol(held)));
      return;
    }
    const r = await cancelOrders(tag.close.orders);
    if (r.tone === 'err') setShelf(r);
  };

  const levelSettings = useSetting(LEVELS);
  const levelDefs = useLevelSources().defs;
  const shownLevels = levels.filter(
    (l) => l.price !== null && isLevelShown(layers, l) && levelShown(levelSettings, l.key, levelDefs),
  );
  const findTag = (x: number, y: number): TagModel | null => {
    const box = visibleTags.find(
      (tag) => x >= tag.right - tag.width && x <= tag.right && Math.abs(y - tag.y) <= ORDER_TAG_H / 2,
    );
    if (box) return box.tag;
    if (!coords) return null;
    let best: { t: TagModel; d: number } | null = null;
    for (const { tag, y: ty, py } of layout) {
      const d = Math.min(Math.abs(ty - y), Math.abs(py - y));
      if (d <= 6 && (!best || d < best.d)) best = { t: tag, d };
    }
    return best?.t ?? null;
  };
  const findLevel = (y: number): Level | null => {
    if (!coords) return null;
    let best: { l: Level; d: number } | null = null;
    for (const l of shownLevels) {
      if (l.price === null) continue;
      const d = Math.abs(coords.yOfPrice(l.price) - y);
      if (d <= 5 && (!best || d < best.d)) best = { l, d };
    }
    return best?.l ?? null;
  };

  const openMenuAt = (clientX: number, clientY: number) => {
    const host = hostRef.current;
    if (!host || !coords) return;
    const r = host.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    const { plot } = coords;
    if (x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) return false;
    setMenu({
      x,
      y,
      client: { x: clientX, y: clientY },
      price: snap(coords.priceOfY(y)),
      time: coords.timeOfX(x),
      tag: findTag(x, y),
      level: findLevel(y),
      asks: chart ? orderFlowAsks(chart, x, y) : [],
    });
    return true;
  };

  const placeHoverAt = (clientX: number, clientY: number) => {
    const r = hostRef.current?.getBoundingClientRect();
    if (!r || !coords) return null;
    const x = clientX - r.left;
    const y = clientY - r.top;
    const { plot } = coords;
    if (x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) return null;
    return { x, y, price: coords.priceOfY(y) };
  };
  const placeClick = (e: ReactPointerEvent<HTMLElement>) => {
    // React bubbles a portal's events through its React parents, so the menu's rows reach this handler.
    if (!place || !isPrimaryPress(e) || !hostRef.current?.contains(e.target as Node)) return;
    if (e.target instanceof Element && e.target.closest('[data-order-overflow]')) return;
    const at = placeHoverAt(e.clientX, e.clientY);
    if (!at) return;
    e.preventDefault();
    e.stopPropagation();
    const click = clickAt(place, null, at.price, q, placeFilled);
    if (click) void runPlaceStep(click.placement, click.step, execBrackets, setShelf);
  };

  return (
    <div
      ref={hostRef}
      className={cx('chart-trade', place && 'is-placing')}
      tabIndex={-1}
      onPointerDownCapture={placeClick}
      data-levels={
        coords
          ? JSON.stringify(
              shownLevels.map((l) => ({ key: l.key, label: l.label, y: Math.round(coords.yOfPrice(l.price!)) })),
            )
          : undefined
      }
      onPointerMove={(e) => {
        const r = hostRef.current?.getBoundingClientRect();
        if (!r) return;
        pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top };
        maybeCollapse(pointer.current.x, pointer.current.y);
        if (place) setPlaceHover(placeHoverAt(e.clientX, e.clientY));
      }}
      onPointerLeave={() => {
        if (fanned && !fanned.pinned && !drag) setFanned(null);
        setPlaceHover(null);
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('input, textarea')) return;
        if (openMenuAt(e.clientX, e.clientY) !== false) e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.target === hostRef.current && drag?.phase === 'keys') {
          const tag = tags.find((tag) => tag.id === drag.tagId);
          if (tag) keyOnTag(tag, e);
          if (e.defaultPrevented) return;
        }
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = hostRef.current?.getBoundingClientRect();
          if (!r || !coords) return;
          const p = pointer.current ?? { x: coords.plot.x + coords.plot.w / 2, y: coords.plot.y + coords.plot.h / 2 };
          openMenuAt(r.left + p.x, r.top + p.y);
        }
      }}
    >
      {children}
      {coords ? (
        <div className="ct-layer" aria-label="Orders on the chart" {...{ [TRADING_STATE_ATTR]: '' }}>
          {scene.lines.map((l) => {
            const tagId = l.id.split(':line:')[0]!;
            const tag = tags.find((t) => t.id === tagId);
            const b = tag?.part === 'entry' ? brackets.find((x) => x.id === tag.bracketId) : undefined;
            const spawns = b?.kind === 'position' && hostOf(b) ? b : null;
            if (!tag || (tag.drag.length === 0 && !spawns)) return null;
            const x = startX(l.since);
            const y = coords.yOfPrice(l.price);
            return (
              <div
                key={l.id}
                className="ct-edge"
                data-part={tag.part}
                style={{ left: x, top: y - EDGE_HIT, width: coords.plot.x + coords.plot.w - x, height: EDGE_HIT * 2 }}
                onPointerEnter={() => setHover(tag.id)}
                onPointerLeave={() => setHover((h) => (h === tag.id ? null : h))}
                onPointerDown={(e) => (spawns ? startSpawn(spawns, tag.id, e) : startDrag(tag, e))}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={() => setDrag(null)}
              />
            );
          })}
          {visibleTags.some((l) => l.lane > 0 || l.y !== l.py) ? (
            <svg className="ct-leaders" width={coords.plot.x + coords.plot.w} height={coords.plot.y + coords.plot.h}>
              {visibleTags
                .filter((l) => l.lane > 0 || l.y !== l.py)
                .map(({ tag, y, py: at, right }) => {
                  const py = Math.min(coords.plot.y + coords.plot.h, Math.max(coords.plot.y, at));
                  const b = brackets.find((x) => x.id === tag.bracketId);
                  const lineStart = Math.max(right + FAN_GAP, startX(b?.since ?? null));
                  return (
                    <g key={tag.id}>
                      <polyline
                        points={`${String(right)},${String(y)} ${String(right + FAN_GAP / 2)},${String(y)} ${String(right + FAN_GAP)},${String(py)}`}
                        stroke={tag.color}
                        strokeOpacity={0.6}
                        fill="none"
                      />
                      {lineStart > right + FAN_GAP ? (
                        <line
                          x1={right + FAN_GAP}
                          x2={lineStart}
                          y1={py}
                          y2={py}
                          stroke={tag.color}
                          strokeOpacity={0.3}
                          strokeDasharray="2 3"
                        />
                      ) : null}
                    </g>
                  );
                })}
            </svg>
          ) : null}
          {overflowTags.length > 0 ? (
            <Menu>
              <MenuTrigger asChild>
                <Button
                  size="s"
                  data-order-overflow
                  aria-label={`${String(overflowTags.length)} more orders on this chart`}
                  style={{
                    position: 'absolute',
                    pointerEvents: 'auto',
                    left: coords.plot.x + 6,
                    top: coords.plot.y + LEGEND_BAND + 6,
                    width: Math.min(ORDER_TAG_MORE_W, Math.max(0, coords.plot.w - 12)),
                  }}
                >
                  +{overflowTags.length} orders
                </Button>
              </MenuTrigger>
              <MenuContent aria-label="More orders" align="start">
                {overflowTags.map(({ tag, y }) => (
                  <MenuItem
                    key={tag.id}
                    onSelect={() => {
                      const host = hostRef.current?.getBoundingClientRect();
                      if (!host) return;
                      setRevealedTag(tag.id);
                      const x = coords.plot.x + 6;
                      setMenu({
                        x,
                        y,
                        client: { x: host.left + x, y: host.top + y },
                        price: tag.price,
                        time: null,
                        tag,
                        level: null,
                        asks: [],
                      });
                    }}
                  >
                    {tag.text}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          ) : null}
          {visibleTags.map(({ tag, y, right, width, clipped, moving }) => {
            const b = brackets.find((x) => x.id === tag.bracketId);
            const spawns = tag.part === 'entry' && b?.kind === 'position' && hostOf(b) ? b : null;
            return (
              <Tag
                key={tag.id}
                tag={tag}
                y={y}
                right={right}
                width={width}
                moving={moving}
                clipped={clipped && !moving}
                drag={movingId === tag.id ? drag : null}
                ghost={ghostTags.has(tag.id)}
                refused={
                  (ghostTags.has(tag.id) && !!placeInfo?.error && tag.part === placeInfo.role) ||
                  (tag.id === movingId && dropError !== null)
                }
                spawns={spawns !== null}
                draftDrag={draftOf(tag) !== null}
                refCb={(el) => {
                  if (el) tagRefs.current.set(tag.id, el);
                  else tagRefs.current.delete(tag.id);
                }}
                onEnter={() => {
                  setHover(tag.id);
                  const b = brackets.find((x) => x.id === tag.bracketId);
                  if (b && b.stops.length + b.targets.length > 2 && !fanned?.pinned)
                    setFanned({ id: b.id, pinned: false });
                }}
                onLeave={() => setHover((h) => (h === tag.id ? null : h))}
                onClick={() => {
                  if (tag.account) {
                    pickTicketAccount(tileId, tag.account.id, accounts);
                    return;
                  }
                  const b = brackets.find((x) => x.id === tag.bracketId);
                  if (b && b.stops.length + b.targets.length > 2)
                    setFanned(fanned?.id === b.id && fanned.pinned ? null : { id: b.id, pinned: true });
                }}
                onPointerDown={(e) => (spawns ? startSpawn(spawns, tag.id, e) : startDrag(tag, e))}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onKeyDown={(e) => keyOnTag(tag, e)}
                onClose={() => void close(tag)}
              />
            );
          })}
          {(() => {
            const hint = chartHint(place, placeInfo?.error ?? place?.error ?? null, dropError, placeInfo?.note ?? null);
            if (!hint) return null;
            const high = NOTE_H.oneLine;
            const band = coords.plot.y + coords.plot.h - (high > 0 ? high + NOTE_H.air : 0);
            const low = visibleTags.filter((l) => l.y + ORDER_TAG_H / 2 >= band);
            const tagsW = Math.max(0, ...low.map((l) => coords.plot.x + coords.plot.w - (l.right - l.width)));
            const clear = tagsW > 0 ? tagsW + FAN_GAP : 0;
            return (
              <div
                className="ct-note-lane"
                style={{
                  left: coords.plot.x,
                  width: Math.max(0, coords.plot.w - clear),
                  top: coords.plot.y + coords.plot.h,
                }}
              >
                <Toast className="ct-hint" tone={hint.tone === 'err' ? 'err' : 'hint'} title={hint.text} />
              </div>
            );
          })()}
        </div>
      ) : null}
      <ChartMenu
        target={menu}
        onClose={() => setMenu(null)}
        brackets={brackets}
        math={math}
        instrument={exec.instrument}
        execSymbol={exec.differs ? exec.symbol : null}
        modelInstrument={instrument}
        symbol={symbol}
        root={root}
        layoutId={layoutId}
        tileId={tileId}
        layers={layers}
        readOnly={readOnly ?? exec.unavailable}
        menuQuote={q}
        onResult={setShelf}
        reversal={{
          positionId: execPosition?.id ?? null,
          why: reverseView.why ?? limitLockWords(accountUpdate),
          to:
            reverseView.why === null
              ? `${reverseView.side === 'buy' ? 'long' : 'short'} ${String(reverseView.qty)}`
              : '',
        }}
        onReverse={() => runOrderKey('reverse', keyLive(), noteKey)}
        orderKeys={orderKeys}
        onResetScale={() => chart?.setViewport({ price: 'auto', lastBars: 150 })}
        onReview={(draftId) => revealApproval((drafts ?? []).find((d) => d.draftId === draftId)?.approvalId ?? null)}
        onModify={(tag) => {
          const el = tagRefs.current.get(tag.id);
          (el ?? hostRef.current)?.focus();
          const base = baseTag(tag.id) ?? tag;
          setDrag({
            tagId: tag.id,
            from: base.price,
            price: base.price,
            orders: tag.drag,
            phase: 'keys',
            pointer: null,
          });
        }}
      />
    </div>
  );
}

function Tag({
  tag,
  y,
  right,
  width,
  moving,
  clipped,
  drag,
  ghost,
  refused,
  spawns,
  draftDrag,
  refCb,
  onEnter,
  onLeave,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
  onClose,
}: {
  tag: TagModel;
  y: number;
  right: number;
  width: number;
  moving: boolean;
  clipped: boolean;
  drag: Drag | null;
  ghost: boolean;
  refused: boolean;
  spawns: boolean;
  draftDrag: boolean;
  refCb: (el: HTMLDivElement | null) => void;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onClose: () => void;
}) {
  const draggable = tag.drag.length > 0 || spawns || draftDrag;
  const style = {
    top: y - ORDER_TAG_H / 2,
    right: `calc(100% - ${String(right)}px)`,
    width: moving ? undefined : width,
    minWidth: moving ? width : undefined,
    '--c': tag.color,
  } as CSSProperties;
  return (
    <div
      ref={refCb}
      className={cx(
        'ct-tag',
        draggable && 'is-drag',
        tag.draft && 'is-draft',
        (drag ?? ghost) && 'is-moving',
        (drag?.phase === 'sending' || drag?.phase === 'settling') && 'is-pending',
        refused && 'is-refused',
        tag.part === 'entry' && 'is-entry',
        tag.account && 'is-elsewhere',
      )}
      data-part={tag.part}
      data-testid={`tag-${tag.part}`}
      style={style}
      role={tag.account ? 'button' : 'group'}
      aria-label={tag.account ? `${tag.text}: trade on ${tag.account.name}` : tag.text}
      title={tag.account ? `Trade on ${tag.account.name}` : undefined}
      tabIndex={tag.drag.length > 0 || tag.account ? 0 : -1}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onClick={onClick}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        onPointerDown(e);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {draggable ? (
        <span
          className="grip"
          aria-hidden="true"
          title={
            draftDrag ? 'Drag to edit the draft' : spawns && tag.drag.length > 0 ? 'Drag to move the order' : undefined
          }
        >
          ⋮⋮
        </span>
      ) : null}
      {clipped ? (
        <Tooltip content={tag.text}>
          <span className="txt">{figures(tag.text)}</span>
        </Tooltip>
      ) : (
        <span className="txt">{figures(tag.text)}</span>
      )}
      {tag.close ? (
        <button
          type="button"
          className="x"
          aria-label={tag.close.label}
          title={tag.close.label}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

function SendItem({
  disabled,
  reason,
  onSend,
  children,
}: {
  disabled?: boolean;
  reason?: string | null;
  onSend: () => void;
  children: ReactNode;
}) {
  if (disabled) {
    return (
      <MenuItem disabled hint={reason ?? undefined}>
        {children}
      </MenuItem>
    );
  }
  return <MenuItem onSelect={onSend}>{children}</MenuItem>;
}

interface ChartMenuProps {
  target: MenuTarget | null;
  onClose: () => void;
  brackets: readonly Bracket[];
  math: ChartMath;
  instrument: string;
  execSymbol: string | null;
  modelInstrument: string;
  symbol: string;
  root: string;
  layoutId: string;
  tileId: string;
  layers: readonly ChartLayer[];
  readOnly: string | null;
  menuQuote: PlaceQuote;
  onResult: (r: ActionResult) => void;
  reversal: { positionId: string | null; why: string | null; to: string };
  onReverse: () => void;
  orderKeys: Partial<Record<OrderKeyAction, string>>;
  onModify: (tag: TagModel) => void;
  onReview: (draftId: string | null) => void;
  onResetScale: () => void;
}

function ChartMenu(props: ChartMenuProps) {
  const { target, onClose } = props;
  return (
    <Menu open={target !== null} onOpenChange={(o) => !o && onClose()} modal>
      <MenuTrigger asChild>
        <span
          className="ct-menu-anchor"
          style={{ left: target?.x ?? 0, top: target?.y ?? 0 }}
          aria-hidden="true"
          tabIndex={-1}
        />
      </MenuTrigger>
      {target ? <ChartMenuItems {...props} target={target} /> : null}
    </Menu>
  );
}

function ChartMenuItems({
  target,
  onClose,
  brackets,
  math,
  instrument,
  execSymbol,
  modelInstrument,
  symbol,
  root,
  layoutId,
  tileId,
  layers,
  readOnly,
  menuQuote,
  onResult,
  reversal,
  onReverse,
  orderKeys,
  onModify,
  onReview,
  onResetScale,
}: ChartMenuProps & { target: MenuTarget }) {
  const { update: accountUpdate, orders, setup } = useTicketTrade(tileId);
  const settings = useTradeSettings((s) => s);
  const levelDefs = useLevelSources().defs;
  const view = useStageView(layoutId);
  const model = read(layoutsStore).layouts[layoutId]?.charts[tileId] ?? null;
  const chartType = chartTypeOf(
    view,
    tileId,
    useUi((s) => s.defaultChartType),
    model,
  );
  const px = (p: number) => formatPrice(p, math.decimals);

  const accountId = accountUpdate?.account.id ?? null;
  const rowAt = (side: Side, kind: 'limit' | 'stop', price: number) =>
    menuTrade({
      side,
      kind,
      price,
      quote: menuQuote,
      account: accountUpdate,
      ticket: setup,
      math,
      instrument,
    });

  const tagOrders = (t: TagModel | null) => (t?.close?.kind === 'cancel' ? t.close.orders : t ? t.drag : []);
  const tag = target.tag;
  const tagBracket = tag ? (brackets.find((b) => b.id === tag.bracketId) ?? null) : null;
  const tagPrice = tag ? tag.price : null;
  const tagInstrument = tagBracket?.instrument ?? instrument;
  const samePrice =
    tagPrice !== null
      ? orders.filter((o) => {
          const p = restingPrice(o.request);
          return p !== null && Math.abs(p - tagPrice) < math.tick / 2 && o.request.instrument === tagInstrument;
        })
      : [];
  const position = tagBracket?.kind === 'position' ? tagBracket : (brackets.find((b) => b.kind === 'position') ?? null);

  const beOffset = accountUpdate ? breakevenOffset(resolveOco(settings, accountUpdate.account.id, root)) : null;
  const be = breakevenOf(position, math.tick, beOffset);

  const drawingCount = drawingsOn(model?.drawings, modelInstrument).length;
  const alertSeed = (price: number | null): AlertSeed => ({
    instrument: modelInstrument,
    symbol,
    interval: model?.timeframe ?? '1m',
    decimals: math.decimals,
    tick: math.tick,
    price,
    more: [
      ...shownDrawings(read(layoutsStore).layouts[layoutId]?.charts ?? {}, tileId).flatMap(
        (d) => drawingChoice(d) ?? [],
      ),
      ...chartPlotChoices(layers, root),
    ],
  });

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => onResult({ tone: 'ok', text: `Copied ${text}` }),
      () => onResult({ tone: 'err', text: 'Copy failed' }),
    );
  };

  const timeWord = (t: number | null) => {
    if (t === null) return 'this bar';
    const d = new Date(t);
    return `the ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: displayZone() })} bar`;
  };

  return (
    <MenuContent className="ct-menu" align="start" side="bottom" sideOffset={2} aria-label="Chart menu">
      {tag && tagBracket ? (
        <>
          <MenuLabel>{tag.text}</MenuLabel>
          {readOnly === null && tag.drag.length > 0 ? (
            <MenuItem onSelect={() => onModify(tag)} shortcut="↑↓">
              Modify price…
            </MenuItem>
          ) : null}
          {tagBracket.kind === 'draft' ? (
            <MenuItem
              onSelect={() => {
                onClose();
                onReview(tagBracket.draftId);
              }}
            >
              Review draft
            </MenuItem>
          ) : null}
          {readOnly === null && tagOrders(tag).length > 0 ? (
            <MenuItem
              destructive
              onSelect={() => {
                onClose();
                void cancelOrders(tagOrders(tag)).then((r) => r.tone === 'err' && onResult(r));
              }}
            >
              Cancel{tagOrders(tag).length > 1 ? ` ${String(tagOrders(tag).length)} legs` : ''}
            </MenuItem>
          ) : null}
          {readOnly === null && samePrice.length > 1 ? (
            <MenuItem
              destructive
              onSelect={() => {
                onClose();
                void cancelOrders(samePrice).then((r) => r.tone === 'err' && onResult(r));
              }}
              hint={String(samePrice.length)}
            >
              Cancel all at {px(tagPrice!)}
            </MenuItem>
          ) : null}
          {readOnly === null && tagBracket.kind === 'position' && accountId ? (
            <MenuItem
              {...(orderKeys.flatten && tagBracket.id === reversal.positionId ? { shortcut: orderKeys.flatten } : {})}
              onSelect={() => {
                onClose();
                void flatten(accountId, tagInstrument, displaySymbol(tagInstrument)).then(onResult);
              }}
            >
              Flatten {tagBracket.side === 'buy' ? 'long' : 'short'} {String(tagBracket.qty)}
            </MenuItem>
          ) : null}
          {readOnly === null && tagBracket.kind === 'position' && tagBracket.id === reversal.positionId ? (
            <MenuItem
              disabled={reversal.why !== null}
              {...(reversal.why !== null ? { hint: reversal.why } : {})}
              {...(orderKeys.reverse ? { shortcut: orderKeys.reverse } : {})}
              onSelect={() => {
                onClose();
                onReverse();
              }}
            >
              Reverse to {reversal.to}
            </MenuItem>
          ) : null}
          {readOnly === null && tagBracket.kind === 'position' ? (
            <MenuItem
              disabled={be.why !== null}
              hint={be.why ?? px(be.price!)}
              shortcut={BREAKEVEN_KEY}
              onSelect={() => {
                onClose();
                if (!accountId || !position) return;
                void breakeven(
                  accountId,
                  position.instrument,
                  displaySymbol(position.instrument),
                  beOffset,
                  math.decimals,
                ).then(onResult);
              }}
            >
              Breakeven
            </MenuItem>
          ) : null}
          <MenuSeparator />
        </>
      ) : null}

      <MenuLabel>
        {readOnly === null ? `Trade ${execSymbol ? `${execSymbol} ` : ''}at ${px(target.price)}` : px(target.price)}
        {accountUpdate ? ` · ${accountUpdate.account.displayName}` : ''}
      </MenuLabel>
      {readOnly !== null ? (
        <MenuItem disabled className="ct-menu-why">
          {readOnly}
        </MenuItem>
      ) : null}
      {(readOnly === null ? TRADE_ROWS : []).map(([side, kind]) => {
        const row = rowAt(side, kind, target.price);
        if (!row) return null;
        const input = row.input;
        return (
          <SendItem
            key={`${side}-${kind}`}
            disabled={input === null}
            reason={row.reason}
            onSend={() => {
              if (!input || !accountUpdate) return;
              onClose();
              void submitOrder(
                accountUpdate.account.environment,
                input,
                `${row.word} ${execSymbol ?? symbol}`,
                math.decimals,
              ).then(onResult);
            }}
          >
            {row.word}
            {input ? <span className="r">{row.hint}</span> : null}
          </SendItem>
        );
      })}
      <MenuSeparator />

      <MenuItem onSelect={() => openAlertForm(alertSeed(target.price), target.client)}>
        Alert at {px(target.price)}…
      </MenuItem>
      {target.level && target.level.price !== null ? (
        <MenuItem
          onSelect={() =>
            openAlertForm({ ...alertSeed(target.level!.price), target: levelChoice(target.level!) }, target.client)
          }
        >
          Alert on {target.level.label}…
        </MenuItem>
      ) : null}
      <MenuSeparator />

      <MenuItem
        onSelect={() =>
          addDrawing(
            { layoutId, tileId },
            'horizontal_line',
            [{ t: target.time ?? Number.NaN, price: target.price }],
            modelInstrument,
          )
        }
      >
        Horizontal line at {px(target.price)}
      </MenuItem>
      <MenuItem
        destructive
        disabled={drawingCount === 0}
        hint={drawingCount ? String(drawingCount) : undefined}
        onSelect={() => removeAllDrawings({ layoutId, tileId }, modelInstrument)}
      >
        Remove all drawings
      </MenuItem>
      <MenuSeparator />

      <MenuItem onSelect={() => openHome('levels')}>Edit levels…</MenuItem>
      {target.level && target.level.price !== null ? (
        <>
          <MenuItem
            onSelect={() => {
              setLevels(setLevelStyle(readSetting(LEVELS), target.level!.key, { on: false }, levelDefs));
            }}
          >
            Hide {target.level.label}
          </MenuItem>
          <MenuItem onSelect={() => copy(px(target.level!.price!))}>
            Copy {target.level.label} {px(target.level.price)}
          </MenuItem>
        </>
      ) : null}
      <MenuSeparator />

      {target.asks.map((a) => (
        <MenuItem key={a.kind} onSelect={() => askAnalyst(askQuestion(a, symbol, model?.timeframe ?? '', px))}>
          {askLabel(a)}
        </MenuItem>
      ))}
      <MenuItem onSelect={() => askAnalyst(`What happens around ${px(target.price)} on ${symbol}?`)}>
        Ask about {px(target.price)}
      </MenuItem>
      {target.asks.some((a) => a.kind === 'bar') ? null : (
        <MenuItem onSelect={() => askAnalyst(`What happened in ${timeWord(target.time)} on ${symbol}?`)}>
          Ask about {timeWord(target.time)}
        </MenuItem>
      )}
      <MenuSeparator />

      {chartPanels().map(({ kind, label }) => (
        <MenuItem key={kind} onSelect={() => void openBesideChart(kind, { layoutId, tileId })}>
          {label}
        </MenuItem>
      ))}
      <MenuSeparator />

      <MenuSub>
        <MenuSubTrigger hint={CHART_TYPE_WORD[chartType]}>Chart type</MenuSubTrigger>
        <MenuSubContent className="ct-menu">
          <ChartTypeItems chart={{ layoutId, tileId }} type={chartType} layers={layers} open />
        </MenuSubContent>
      </MenuSub>
      <MenuSub>
        <MenuSubTrigger hint={model?.timeframe}>Interval</MenuSubTrigger>
        <MenuSubContent className="ct-menu">
          <MenuRadioGroup value={model?.timeframe ?? ''} onValueChange={(v) => void setChartTimeframe(v as never)}>
            {withPresets([model?.timeframe]).map((t) => (
              <MenuRadioItem key={t} value={t}>
                {t}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubContent>
      </MenuSub>
      <MenuSub>
        <MenuSubTrigger>Layers</MenuSubTrigger>
        <MenuSubContent className="ct-menu">
          <IndicatorMenuItems
            chart={{ layoutId, tileId }}
            layers={layers}
            templates={<TemplateMenuRow chart={{ layoutId, tileId }} />}
          />
          <MenuSeparator />
          <MenuItem onSelect={() => openHome('levels')}>Level settings…</MenuItem>
        </MenuSubContent>
      </MenuSub>
      <MenuItem onSelect={onResetScale}>Reset scale</MenuItem>
      <MenuItem onSelect={() => void splitWithSymbol(modelInstrument)}>Open in new chart</MenuItem>
      <MenuItem onSelect={() => copy(px(target.price))}>Copy price {px(target.price)}</MenuItem>
    </MenuContent>
  );
}
