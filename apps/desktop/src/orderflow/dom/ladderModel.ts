import type { Order, OrderStatus, ProviderHealth, Side } from '@tessera/protocol';
import { formatCount, pointOfControl } from '@tessera/chart';
import { formatMoney, formatPrice } from '@tessera/ui';
import type { Bracket } from '../../chart/brackets.ts';
import type { AccountRef } from '../../app/orders.ts';
import { healthProblems, type LinkState } from '../../shell/health.ts';
import { FEED_FAILED, screenWords } from '../../shell/deskWords.ts';
import { KIND_WORD, type EntryKind } from '../../shell/ticket.ts';
import { normalizeLink, type LinkGroup } from '../../workspace/dock/links.ts';

export const DOM_ROW_TICKS = [1, 2, 4, 5, 10] as const;
export type DomRowTicks = (typeof DOM_ROW_TICKS)[number];
export type VolumeColumn = 'session' | 'recent' | 'off';
export type TradedColumns = 'session' | 'recent' | 'off';
export const PULL_STACK_WINDOWS = [0, 5, 10, 30] as const;
export type PullStackWindow = (typeof PULL_STACK_WINDOWS)[number];

export interface DomParams {
  link: LinkGroup | null;
  instrument: string | null;
  rowTicks: DomRowTicks;
  volumeColumn: VolumeColumn;
  autoCentre: boolean;
  orders: boolean;
  traded: TradedColumns;
  pullStack: PullStackWindow;
  pnl: boolean;
  refills: boolean;
  queue: boolean;
}

export const DEFAULT_DOM_PARAMS: DomParams = {
  link: null,
  instrument: null,
  rowTicks: 1,
  volumeColumn: 'session',
  autoCentre: true,
  orders: true,
  traded: 'off',
  pullStack: 0,
  pnl: true,
  refills: true,
  queue: true,
};

export const rowWord = (n: number): string => (n === 1 ? '1 tick' : `${String(n)} ticks`);

export function domSummary(p: Pick<DomParams, 'rowTicks'>): string | null {
  return p.rowTicks > 1 ? rowWord(p.rowTicks) : null;
}

export function readDomParams(v: unknown): DomParams {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const str = (x: unknown) => (typeof x === 'string' && x.trim() !== '' ? x : null);
  const rt = Number(o.rowTicks);
  return {
    link: normalizeLink(o.link),
    instrument: str(o.instrument),
    rowTicks: (DOM_ROW_TICKS as readonly number[]).includes(rt) ? (rt as DomRowTicks) : DEFAULT_DOM_PARAMS.rowTicks,
    volumeColumn:
      o.volumeColumn === 'session' || o.volumeColumn === 'recent' || o.volumeColumn === 'off'
        ? o.volumeColumn
        : DEFAULT_DOM_PARAMS.volumeColumn,
    autoCentre: typeof o.autoCentre === 'boolean' ? o.autoCentre : DEFAULT_DOM_PARAMS.autoCentre,
    orders: typeof o.orders === 'boolean' ? o.orders : DEFAULT_DOM_PARAMS.orders,
    traded:
      o.traded === 'session' || o.traded === 'recent' || o.traded === 'off' ? o.traded : DEFAULT_DOM_PARAMS.traded,
    pullStack: (PULL_STACK_WINDOWS as readonly number[]).includes(Number(o.pullStack))
      ? (Number(o.pullStack) as PullStackWindow)
      : DEFAULT_DOM_PARAMS.pullStack,
    pnl: typeof o.pnl === 'boolean' ? o.pnl : DEFAULT_DOM_PARAMS.pnl,
    refills: typeof o.refills === 'boolean' ? o.refills : DEFAULT_DOM_PARAMS.refills,
    queue: typeof o.queue === 'boolean' ? o.queue : DEFAULT_DOM_PARAMS.queue,
  };
}

export type LadderCell = 'bid' | 'price' | 'ask' | 'vol' | 'pnl' | 'psBid' | 'psAsk' | 'sold' | 'bought';

export interface LadderColumns {
  pnl: boolean;
  pullStack: boolean;
  traded: boolean;
  volume: boolean;
  nobook: boolean;
  orders: boolean;
}

const COL_MIN = { book: 72, bareBook: 48, pnl: 34, pullStack: 28, traded: 48, volume: 42 } as const;

const FIG_CH = 7.6;

export function priceColumnWidth(chars: number): number {
  return Math.max(80, (Math.max(6, chars) + 2.5) * FIG_CH + 16);
}

export const LADDER_MIN_WIDTH = Math.ceil(2 * COL_MIN.bareBook + priceColumnWidth(10));

function shownColumns(c: LadderColumns): LadderCell[] {
  const pullStack = c.pullStack && !c.nobook;
  const cells: LadderCell[] = [];
  if (c.pnl) cells.push('pnl');
  if (pullStack) cells.push('psBid');
  if (c.traded) cells.push('sold');
  cells.push('bid', 'price', 'ask');
  if (c.traded) cells.push('bought');
  if (pullStack) cells.push('psAsk');
  if (c.volume) cells.push('vol');
  return cells;
}

const bookMin = (c: LadderColumns) => (c.orders ? COL_MIN.book : COL_MIN.bareBook);
const bookTrack = (c: LadderColumns) => (c.nobook ? '0' : `minmax(${String(bookMin(c))}px, 1fr)`);
const pullStackTrack = () => `minmax(${String(COL_MIN.pullStack)}px, 0.45fr)`;
const tradedTrack = () => `minmax(${String(COL_MIN.traded)}px, 0.55fr)`;

const TRACK: Record<LadderCell, (c: LadderColumns) => string> = {
  pnl: () => `${String(COL_MIN.pnl)}px`,
  psBid: pullStackTrack,
  sold: tradedTrack,
  bid: bookTrack,
  price: (c) => (c.nobook ? 'minmax(var(--lad-px), 1fr)' : 'var(--lad-px)'),
  ask: bookTrack,
  bought: tradedTrack,
  psAsk: pullStackTrack,
  vol: (c) => `minmax(${String(COL_MIN.volume)}px, ${c.nobook ? '1fr' : '0.7fr'})`,
};

export function ladderTemplate(c: LadderColumns): string {
  return shownColumns(c)
    .map((cell) => TRACK[cell](c))
    .join(' ');
}

export interface HeaderCell {
  column: LadderCell;
  labels: readonly string[];
  align: 'start' | 'center' | 'end' | 'apart';
  word: string;
}

type HeaderParams = Pick<DomParams, 'volumeColumn' | 'refills'>;

function bookWord(side: 'bid' | 'ask', c: LadderColumns, p: HeaderParams): string {
  const held = c.orders ? ' and, beside them, how many orders hold them' : '';
  const refilled = p.refills ? ' · an inner edge: refilled as it traded' : '';
  const contracts = side === 'bid' ? 'Contracts bid' : 'Contracts offered';
  return `${contracts} at each price${held}${refilled} · click to ${side === 'bid' ? 'buy' : 'sell'}`;
}

const HEADER: Record<LadderCell, (c: LadderColumns, p: HeaderParams) => Omit<HeaderCell, 'column'>> = {
  pnl: () => ({ labels: ['P&L'], align: 'center', word: 'Your position’s P&L in ticks at this price' }),
  psBid: () => ({
    labels: ['±'],
    align: 'center',
    word: 'Bids added (+) or pulled (−) over the window, fills excluded',
  }),
  sold: () => ({ labels: ['Sold'], align: 'end', word: 'Sold at the bid' }),
  bid: (c, p) => ({
    labels: c.orders ? ['Orders', 'Bid'] : ['Bid'],
    align: c.orders ? 'apart' : 'end',
    word: bookWord('bid', c, p),
  }),
  price: () => ({ labels: ['Price'], align: 'start', word: 'Price · the last trade’s size beside it' }),
  ask: (c, p) => ({
    labels: c.orders ? ['Ask', 'Orders'] : ['Ask'],
    align: c.orders ? 'apart' : 'start',
    word: bookWord('ask', c, p),
  }),
  bought: () => ({ labels: ['Bought'], align: 'start', word: 'Bought at the ask' }),
  psAsk: () => ({
    labels: ['±'],
    align: 'center',
    word: 'Asks added (+) or pulled (−) over the window, fills excluded',
  }),
  vol: (_c, p) => ({
    labels: ['Vol'],
    align: 'start',
    word: p.volumeColumn === 'recent' ? 'Volume, last minute · buys · sells' : 'Volume this session',
  }),
};

export function ladderHeader(c: LadderColumns, p: HeaderParams): HeaderCell[] {
  return shownColumns(c).map((column) => {
    const cell = { column, ...HEADER[column](c, p) };
    return c.nobook && (column === 'bid' || column === 'ask') ? { ...cell, labels: [], word: '' } : cell;
  });
}

export function fitColumns(c: LadderColumns, width: number, priceWidth: number): LadderColumns {
  const need = (k: LadderColumns) =>
    (k.nobook ? 0 : 2 * bookMin(k)) +
    priceWidth +
    (k.pnl ? COL_MIN.pnl : 0) +
    (k.pullStack && !k.nobook ? 2 * COL_MIN.pullStack : 0) +
    (k.traded ? 2 * COL_MIN.traded : 0) +
    (k.volume ? COL_MIN.volume : 0);
  const tries: LadderColumns[] = [
    c,
    { ...c, volume: c.volume && !c.traded },
    { ...c, volume: c.volume && !c.traded, pullStack: false },
    { ...c, pullStack: false, traded: false },
    { ...c, pullStack: false, traded: false, volume: false },
    { ...c, pullStack: false, traded: false, volume: false, orders: false },
  ];
  for (const k of tries) if (need(k) <= width) return k;
  return { ...c, pullStack: false, traded: false, volume: false, orders: false, pnl: false };
}

export function columnClasses(c: LadderColumns): Record<string, boolean> {
  return {
    'has-pnl': c.pnl,
    'has-ps': c.pullStack && !c.nobook,
    'has-ord': c.orders && !c.nobook,
    'has-traded': c.traded,
  };
}

export function stepRowTicks(rt: number, dir: 1 | -1): DomRowTicks {
  const i = DOM_ROW_TICKS.indexOf(rt as DomRowTicks);
  const at = i < 0 ? 0 : i;
  return DOM_ROW_TICKS[Math.max(0, Math.min(DOM_ROW_TICKS.length - 1, at + dir))]!;
}

export interface LadderWindow {
  top: number;
  rowTicks: number;
  rows: number;
  gen: number;
}

export function rowFloor(tick: number, rowTicks: number): number {
  return rowTicks <= 1 ? tick : Math.floor(tick / rowTicks) * rowTicks;
}

export function rowLow(w: LadderWindow, i: number): number {
  return w.top - i * w.rowTicks;
}

export function rowIndex(w: LadderWindow, tick: number): number {
  return (w.top - rowFloor(tick, w.rowTicks)) / w.rowTicks;
}

export function centredOn(tick: number, rowTicks: number, rows: number, gen: number): LadderWindow {
  const n = Math.max(1, rows);
  return { top: rowFloor(tick, rowTicks) + Math.floor((n - 1) / 2) * rowTicks, rowTicks, rows: n, gen };
}

export function outsideMiddle(w: LadderWindow, tick: number): boolean {
  const i = rowIndex(w, tick);
  const lo = Math.floor(w.rows * 0.25);
  const hi = Math.ceil(w.rows * 0.75) - 1;
  return i < lo || i > Math.max(lo, hi);
}

export function scrolled(w: LadderWindow, n: number): LadderWindow {
  if (n === 0) return w;
  return { ...w, top: w.top + Math.round(n) * w.rowTicks, gen: w.gen + 1 };
}

export function withRowTicks(w: LadderWindow, rowTicks: number, anchor: number | null): LadderWindow {
  if (rowTicks === w.rowTicks) return w;
  const mid = anchor ?? rowLow(w, Math.floor((w.rows - 1) / 2));
  return centredOn(mid, rowTicks, w.rows, w.gen + 1);
}

export function withRows(w: LadderWindow, rows: number): LadderWindow {
  const n = Math.max(1, rows);
  if (n === w.rows) return w;
  const mid = rowLow(w, Math.floor((w.rows - 1) / 2));
  return centredOn(mid, w.rowTicks, n, w.gen + 1);
}

export function edgeOf(w: LadderWindow, tick: number | null): 'above' | 'below' | null {
  if (tick === null) return null;
  const i = rowIndex(w, tick);
  return i < 0 ? 'above' : i >= w.rows ? 'below' : null;
}

export function autoCentred(
  w: LadderWindow,
  last: number | null,
  o: { paused: boolean; pointerOver: boolean; enabled: boolean },
): LadderWindow {
  if (last === null || !o.enabled || o.paused || o.pointerOver) return w;
  return outsideMiddle(w, last) ? centredOn(last, w.rowTicks, w.rows, w.gen + 1) : w;
}

export interface BookView {
  readonly bestBid: number;
  readonly bestAsk: number;
  rowSize(side: 'bid' | 'ask', rowLow: number, rowTicks: number): number;
  rowOrders?(side: 'bid' | 'ask', rowLow: number, rowTicks: number): number;
  wallSize(multiple?: number, depth?: number): number;
}

export interface LevelView {
  change(side: 'bid' | 'ask', low: number, rowTicks: number): number;
  refilled(side: 'bid' | 'ask', low: number, rowTicks: number): number;
}

export interface VolumeAt {
  total: number;
  buy: number;
  sell: number;
}

export interface VolumeView {
  at(low: number, rowTicks: number, out?: VolumeAt): VolumeAt;
  readonly poc: number | null;
}

type TagRole = 'entry' | 'stop' | 'target' | 'position';
type TagState = 'working' | 'sent' | 'held' | 'draft';

export interface LadderTag {
  key: string;
  tick: number;
  side: Side;
  qty: number;
  role: TagRole;
  state: TagState;
  orders: Order[];
  bracketId: string;
  draftId: string | null;
  ahead?: number | null;
  account?: AccountRef;
}

const SENT: ReadonlySet<OrderStatus> = new Set(['pending_submit', 'pending_cancel']);

function stateOf(o: Order | null, held: boolean): TagState {
  if (!o) return 'draft';
  if (SENT.has(o.status)) return 'sent';
  return held || o.status === 'held' ? 'held' : 'working';
}

const opposite = (s: Side): Side => (s === 'buy' ? 'sell' : 'buy');

export function ladderTags(brackets: readonly Bracket[], tick: number): LadderTag[] {
  const t = (price: number) => Math.round(price / tick);
  const out: LadderTag[] = [];
  for (const b of brackets) {
    const draft = b.kind === 'draft';
    if (b.kind === 'position') {
      out.push({
        key: `pos:${b.id}`,
        tick: t(b.price),
        side: b.side,
        qty: b.qty,
        role: 'position',
        state: 'working',
        orders: [],
        bracketId: b.id,
        draftId: null,
      });
    } else {
      out.push({
        key: draft ? `draft:${b.draftId ?? b.id}` : `entry:${b.entry?.id ?? b.id}`,
        tick: t(b.price),
        side: b.side,
        qty: b.qty,
        role: 'entry',
        state: draft ? 'draft' : stateOf(b.entry, false),
        orders: !draft && b.entry ? [b.entry] : [],
        bracketId: b.id,
        draftId: b.draftId,
      });
    }
    for (const leg of [...b.stops, ...b.targets]) {
      out.push({
        key: draft ? `draft:${b.draftId ?? b.id}:${leg.role}` : `leg:${leg.order?.id ?? `${b.id}:${leg.role}`}`,
        tick: t(leg.price),
        side: opposite(b.side),
        qty: leg.qty,
        role: leg.role,
        state: draft ? 'draft' : stateOf(leg.order, leg.held),
        orders: !draft && leg.order ? [leg.order] : [],
        bracketId: b.id,
        draftId: b.draftId,
      });
    }
  }
  return out;
}

export function joinTags(tags: readonly LadderTag[]): LadderTag[] {
  const by = new Map<string, LadderTag>();
  for (const tag of tags) {
    if (tag.role === 'position') {
      by.set(tag.key, tag);
      continue;
    }
    const k = `${tag.role}|${tag.state}|${tag.side}`;
    const held = by.get(k);
    if (!held) by.set(k, { ...tag, orders: [...tag.orders] });
    else
      by.set(k, {
        ...held,
        key: `${held.key}+${tag.key}`,
        qty: held.qty + tag.qty,
        orders: [...held.orders, ...tag.orders],
      });
  }
  const order: Record<TagRole, number> = { position: 0, entry: 1, stop: 2, target: 3 };
  return [...by.values()].sort((a, b) => order[a.role] - order[b.role]);
}

export function tagWords(tag: LadderTag): string {
  if (tag.role !== 'position') return String(tag.qty);
  return tag.side === 'buy' ? `+${String(tag.qty)}` : `−${String(tag.qty)}`;
}

function entryKind(tag: LadderTag): string {
  const kinds = new Set(tag.orders.map((o) => o.request.orderType));
  const [kind] = kinds;
  return kinds.size === 1 && kind ? KIND_WORD[kind] : 'order';
}

export function tagTitle(tag: LadderTag): string {
  const qty = String(tag.qty);
  const what =
    tag.role === 'position'
      ? `Your ${tag.side === 'buy' ? 'long' : 'short'} ${qty}, its average price`
      : tag.role === 'stop'
        ? `Your stop · ${qty}`
        : tag.role === 'target'
          ? `Your target · ${qty}`
          : `Your ${tag.side} ${entryKind(tag)} ${qty}`;
  const ahead =
    tag.ahead === undefined || tag.ahead === null
      ? ''
      : tag.ahead > 0
        ? ` · ${sizeWords(tag.ahead)} ahead of it`
        : ' · first in the queue';
  const state =
    tag.state === 'draft'
      ? ' · a draft, not sent'
      : tag.state === 'held' && tag.role !== 'entry'
        ? ' · placed once the entry fills'
        : '';
  return `${what}${ahead}${state}`;
}

function tagShort(tag: LadderTag): string {
  const qty = String(tag.qty);
  if (tag.role === 'stop') return 'SL';
  if (tag.role === 'target') return 'TP';
  if (tag.role === 'position') return `${tag.side === 'buy' ? 'Long' : 'Short'} ${qty}`;
  return `${tag.side === 'buy' ? 'Buy' : 'Sell'} ${qty}`;
}

export interface EdgeMark {
  key: string;
  where: 'above' | 'below';
  role: TagRole | 'last';
  text: string;
  label: string;
  tick: number;
}

export function edgeMarks(
  w: LadderWindow,
  last: number | null,
  tags: readonly LadderTag[],
  price: (tick: number) => string,
): EdgeMark[] {
  const out: EdgeMark[] = [];
  const lastWhere = edgeOf(w, last);
  if (lastWhere && last !== null) {
    const px = price(last);
    out.push({ key: 'last', where: lastWhere, role: 'last', text: px, label: `Last price ${px}: centre`, tick: last });
  }
  const off = tags
    .filter((t) => t.state !== 'draft' && !t.account)
    .map((t) => ({ t, where: edgeOf(w, t.tick) }))
    .filter((x): x is { t: LadderTag; where: 'above' | 'below' } => x.where !== null)
    .sort((a, b) => Math.abs(rowIndex(w, a.t.tick)) - Math.abs(rowIndex(w, b.t.tick)));
  for (const { t, where } of off) {
    const px = price(t.tick);
    out.push({
      key: t.key,
      where,
      role: t.role,
      text: `${tagShort(t)} ${px}`,
      label: `${tagTitle(t)}, at ${px}: show it`,
      tick: t.tick,
    });
  }
  return out;
}

export interface LadderRow {
  low: number;
  price: string;
  round: boolean;
  bid: number;
  ask: number;
  bidBar: number;
  askBar: number;
  bidWall: boolean;
  askWall: boolean;
  bestBid: boolean;
  bestAsk: boolean;
  last: boolean;
  average: boolean;
  volume: number;
  buy: number;
  sell: number;
  volBar: number;
  poc: boolean;
  bidTags: readonly LadderTag[];
  askTags: readonly LadderTag[];
  bidOrders: number;
  askOrders: number;
  sold: number;
  bought: number;
  bidChange: number;
  askChange: number;
  bidRefills: number;
  askRefills: number;
  pnl: number | null;
  lastSize: number;
  lastSide: number;
}

export interface LadderFrameInput {
  window: LadderWindow;
  count: number;
  book: BookView | null;
  last: number | null;
  volume: VolumeView | null;
  tags: readonly LadderTag[];
  average: number | null;
  pnlSide?: Side | null;
  traded?: VolumeView | null;
  levels?: LevelView | null;
  orderCounts?: boolean;
  lastTrade?: { size: number; side: number } | null;
  toPrice: (tick: number) => number;
  decimals: number;
  tick: number;
}

const WALL_MULTIPLE = 4;

export function roundStep(tick: number, rowTicks: number): number {
  const want = tick * rowTicks * 4;
  const p = 10 ** Math.floor(Math.log10(want));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= want - 1e-12) return m * p;
  return 10 * p;
}

const NO_TAGS: readonly LadderTag[] = Object.freeze([]);

export class PriceLabels {
  private readonly held = new Map<number, string>();
  private decimals = -1;
  private key = '';
  private sizeMax = 0;
  private volMax = 0;

  barMax(kind: 'size' | 'vol', max: number): number {
    const held = kind === 'size' ? this.sizeMax : this.volMax;
    const next = max > held || max < held * 0.6 ? max : held;
    if (kind === 'size') this.sizeMax = next;
    else this.volMax = next;
    return next;
  }

  same(rowTicks: number, tick: number, decimals: number): boolean {
    const key = `${String(rowTicks)}|${String(tick)}|${String(decimals)}`;
    if (key === this.key) return true;
    this.key = key;
    return false;
  }

  label(low: number, decimals: number, toPrice: (tick: number) => number): string {
    if (decimals !== this.decimals || this.held.size > 2048) {
      this.held.clear();
      this.decimals = decimals;
    }
    let s = this.held.get(low);
    if (s === undefined) {
      s = formatPrice(toPrice(low), decimals);
      this.held.set(low, s);
    }
    return s;
  }
}

function blankRow(): LadderRow {
  return {
    low: 0,
    price: '',
    round: false,
    bid: 0,
    ask: 0,
    bidBar: 0,
    askBar: 0,
    bidWall: false,
    askWall: false,
    bestBid: false,
    bestAsk: false,
    last: false,
    average: false,
    volume: 0,
    buy: 0,
    sell: 0,
    volBar: 0,
    poc: false,
    bidTags: NO_TAGS,
    askTags: NO_TAGS,
    bidOrders: -1,
    askOrders: -1,
    sold: 0,
    bought: 0,
    bidChange: 0,
    askChange: 0,
    bidRefills: 0,
    askRefills: 0,
    pnl: null,
    lastSize: 0,
    lastSide: 0,
  };
}

export function ladderRows(f: LadderFrameInput, out?: LadderRow[], labels?: PriceLabels): LadderRow[] {
  const { window: w, book, volume } = f;
  const rt = w.rowTicks;
  const wall = book ? book.wallSize(WALL_MULTIPLE) * rt : Infinity;
  const step = roundStep(f.tick, rt);
  const lastRow = f.last === null ? null : rowFloor(f.last, rt);
  const avgRow = f.average === null ? null : rowFloor(f.average, rt);
  const bidRow = book && Number.isFinite(book.bestBid) ? rowFloor(book.bestBid, rt) : null;
  const askRow = book && Number.isFinite(book.bestAsk) ? rowFloor(book.bestAsk, rt) : null;
  const pocRow = volume && volume.poc !== null ? rowFloor(volume.poc, rt) : null;

  const byRow = f.tags.length > 0 ? new Map<number, { bid: LadderTag[]; ask: LadderTag[] }>() : null;
  if (byRow)
    for (const tag of f.tags) {
      const low = rowFloor(tag.tick, rt);
      let at = byRow.get(low);
      if (!at) {
        at = { bid: [], ask: [] };
        byRow.set(low, at);
      }
      (tag.side === 'buy' ? at.bid : at.ask).push(tag);
    }

  const rows: LadderRow[] = out ?? [];
  if (rows.length > f.count) rows.length = f.count;
  while (rows.length < f.count) rows.push(blankRow());
  const v: VolumeAt = { total: 0, buy: 0, sell: 0 };
  const tv: VolumeAt = { total: 0, buy: 0, sell: 0 };
  const traded = f.traded ?? null;
  const levels = f.levels ?? null;
  const counts = f.orderCounts === true;
  const pnlSign = f.pnlSide === 'buy' ? 1 : f.pnlSide === 'sell' ? -1 : 0;
  const kept = labels ? labels.same(rt, f.tick, f.decimals) : false;
  let maxSize = 0;
  let maxVol = 0;
  for (let i = 0; i < f.count; i++) {
    const r = rows[i]!;
    const low = rowLow(w, i);
    const bid = book ? book.rowSize('bid', low, rt) : 0;
    const ask = book ? book.rowSize('ask', low, rt) : 0;
    if (volume) volume.at(low, rt, v);
    else v.total = v.buy = v.sell = 0;
    maxSize = Math.max(maxSize, bid, ask);
    maxVol = Math.max(maxVol, v.total);
    if (!kept || r.low !== low || r.price === '') {
      const price = f.toPrice(low);
      r.price = labels ? labels.label(low, f.decimals, f.toPrice) : formatPrice(price, f.decimals);
      r.round = Math.abs(price / step - Math.round(price / step)) < 1e-6;
    }
    r.low = low;
    r.bid = bid;
    r.ask = ask;
    r.bidWall = bid > 0 && bid >= wall;
    r.askWall = ask > 0 && ask >= wall;
    r.bestBid = low === bidRow;
    r.bestAsk = low === askRow;
    r.last = low === lastRow;
    r.average = low === avgRow;
    r.volume = v.total;
    r.buy = v.buy;
    r.sell = v.sell;
    r.poc = low === pocRow && v.total > 0;
    const tags = byRow?.get(low);
    r.bidTags = tags?.bid.length ? joinTags(tags.bid) : NO_TAGS;
    r.askTags = tags?.ask.length ? joinTags(tags.ask) : NO_TAGS;
    r.bidOrders = counts && bid > 0 ? (book?.rowOrders?.('bid', low, rt) ?? -1) : -1;
    r.askOrders = counts && ask > 0 ? (book?.rowOrders?.('ask', low, rt) ?? -1) : -1;
    if (traded) {
      traded.at(low, rt, tv);
      r.sold = tv.sell;
      r.bought = tv.buy;
    } else r.sold = r.bought = 0;
    r.bidChange = levels ? levels.change('bid', low, rt) : 0;
    r.askChange = levels ? levels.change('ask', low, rt) : 0;
    r.bidRefills = levels && bid > 0 ? levels.refilled('bid', low, rt) : 0;
    r.askRefills = levels && ask > 0 ? levels.refilled('ask', low, rt) : 0;
    r.pnl = pnlSign !== 0 && f.average !== null ? (low - f.average) * pnlSign : null;
    const lt = r.last ? (f.lastTrade ?? null) : null;
    r.lastSize = lt ? lt.size : 0;
    r.lastSide = lt ? lt.side : 0;
  }
  if (labels) {
    maxSize = labels.barMax('size', maxSize);
    maxVol = labels.barMax('vol', maxVol);
  }
  for (const r of rows) {
    r.bidBar = maxSize > 0 ? r.bid / maxSize : 0;
    r.askBar = maxSize > 0 ? r.ask / maxSize : 0;
    r.volBar = maxVol > 0 ? r.volume / maxVol : 0;
  }
  return rows;
}

export function tradeTick(side: Side, low: number, rowTicks: number, book: BookView | null): number {
  if (rowTicks <= 1) return low;
  const high = low + rowTicks - 1;
  const inside = book ? (side === 'buy' ? book.bestBid : book.bestAsk) : Number.NaN;
  if (!Number.isFinite(inside)) return side === 'buy' ? high : low;
  return Math.max(low, Math.min(high, inside));
}

export interface SessionVolume {
  lowTick: number;
  rowTicks: number;
  rows: number;
  volume: ArrayLike<number>;
  buy: ArrayLike<number>;
  sell: ArrayLike<number>;
}

export function sessionVolume(s: SessionVolume | null): VolumeView | null {
  if (!s || s.rows <= 0) return null;
  const rows = s.volume.length === s.rows ? s.volume : Array.prototype.slice.call(s.volume, 0, s.rows);
  const poc = pointOfControl(rows);
  const traded = (rows[poc] ?? 0) > 0;
  return {
    poc: traded ? s.lowTick + poc * s.rowTicks : null,
    at(low, rowTicks, out) {
      let total = 0;
      let buy = 0;
      let sell = 0;
      for (let t = low; t < low + rowTicks; t++) {
        const off = t - s.lowTick;
        if (off < 0 || off % s.rowTicks !== 0) continue;
        const i = off / s.rowTicks;
        if (i >= s.rows) break;
        total += s.volume[i]!;
        buy += s.buy[i]!;
        sell += s.sell[i]!;
      }
      const o = out ?? { total: 0, buy: 0, sell: 0 };
      o.total = total;
      o.buy = buy;
      o.sell = sell;
      return o;
    },
  };
}

export interface TapeView {
  readonly start: number;
  readonly end: number;
  readonly epoch: number;
  nsAt(i: number): number;
  tickAt(i: number): number;
  sizeAt(i: number): number;
  sideAt(i: number): number;
  lowerBound(ns: number): number;
}

function addAt(m: Map<number, number>, tick: number, size: number): void {
  const v = (m.get(tick) ?? 0) + size;
  if (Math.abs(v) < 1e-9) m.delete(tick);
  else m.set(tick, v);
}

export class RecentVolume implements VolumeView {
  readonly poc = null;
  private readonly buys = new Map<number, number>();
  private readonly sells = new Map<number, number>();
  private readonly totals = new Map<number, number>();
  private head = 0;
  private tail = 0;
  private epoch = -1;

  constructor(readonly windowMs = 60_000) {}

  sync(tape: TapeView, nowMs: number): boolean {
    const cutoff = (nowMs - this.windowMs) * 1e6;
    let changed = false;
    if (tape.epoch !== this.epoch || this.head < tape.start) {
      this.buys.clear();
      this.sells.clear();
      this.totals.clear();
      this.epoch = tape.epoch;
      this.head = Math.max(tape.start, tape.lowerBound(cutoff));
      this.tail = this.head;
      changed = true;
    }
    for (; this.tail < tape.end; this.tail++) {
      this.put(tape, this.tail, 1);
      changed = true;
    }
    for (; this.head < this.tail && tape.nsAt(this.head) < cutoff; this.head++) {
      this.put(tape, this.head, -1);
      changed = true;
    }
    return changed;
  }

  private put(tape: TapeView, i: number, sign: 1 | -1): void {
    const tick = tape.tickAt(i);
    const size = tape.sizeAt(i) * sign;
    const side = tape.sideAt(i);
    addAt(this.totals, tick, size);
    if (side > 0) addAt(this.buys, tick, size);
    else if (side < 0) addAt(this.sells, tick, size);
  }

  at(low: number, rowTicks: number, out?: VolumeAt): VolumeAt {
    let total = 0;
    let buy = 0;
    let sell = 0;
    for (let t = low; t < low + rowTicks; t++) {
      total += this.totals.get(t) ?? 0;
      buy += this.buys.get(t) ?? 0;
      sell += this.sells.get(t) ?? 0;
    }
    const o = out ?? { total: 0, buy: 0, sell: 0 };
    o.total = total;
    o.buy = buy;
    o.sell = sell;
    return o;
  }
}

export type FeedState =
  | { kind: 'live' }
  | { kind: 'reading' }
  | { kind: 'stale'; behindMs: number; resyncing: boolean }
  | { kind: 'dropped'; words: string }
  | { kind: 'closed'; words: string }
  | { kind: 'nobook' };

export interface BookClock {
  readonly seq: number | null;
  readonly gapPending: boolean;
  readonly heard: number;
}

const STALE_MS = 2000;

export function feedState(
  book: BookClock,
  now: number,
  o: { error: string | null; dropped: string | null; closed?: string | null },
): FeedState {
  if (o.error && /offers no depth|no order book/i.test(o.error)) return { kind: 'nobook' };
  if (o.dropped) return { kind: 'dropped', words: o.dropped };
  if (o.closed) return { kind: 'closed', words: o.closed };
  if (o.error) return { kind: 'dropped', words: screenWords(o.error, FEED_FAILED) };
  if (book.gapPending) return { kind: 'stale', behindMs: book.heard ? now - book.heard : 0, resyncing: true };
  if (book.seq === null) return { kind: 'reading' };
  const behind = now - book.heard;
  return behind > STALE_MS ? { kind: 'stale', behindMs: behind, resyncing: false } : { kind: 'live' };
}

export function entriesOpen(f: FeedState): boolean {
  return f.kind === 'live';
}

export interface PressAt {
  row: number;
  cell: 'bid' | 'ask';
  tick: number;
  gen: number;
}

export type PressOutcome = { send: true } | { send: false; why: string };

export class PressGate {
  private pending: { id: number; at: PressAt } | null = null;
  private next = 1;

  down(at: PressAt): number {
    const id = this.next++;
    this.pending = { id, at };
    return id;
  }

  get current(): PressAt | null {
    return this.pending?.at ?? null;
  }

  cancel(): void {
    this.pending = null;
  }

  up(id: number, at: PressAt | null, open: { ok: true } | { ok: false; why: string }): PressOutcome | null {
    const p = this.pending;
    if (p?.id !== id) return null;
    this.pending = null;
    if (at?.row !== p.at.row || at.cell !== p.at.cell)
      return { send: false, why: 'Released off the row; nothing sent' };
    if (at.gen !== p.at.gen || at.tick !== p.at.tick) return { send: false, why: 'Price moved; nothing sent' };
    if (!open.ok) return { send: false, why: `${open.why}; nothing sent` };
    return { send: true };
  }
}

export function pnlAt(
  position: { side: Side; qty: number; average: number } | null,
  price: number,
  multiplier: number | null,
): number | null {
  if (!position || multiplier === null) return null;
  const dir = position.side === 'buy' ? 1 : -1;
  return (price - position.average) * position.qty * multiplier * dir;
}

export function verbWords(side: Side, kind: EntryKind, qty: number | null, price: number, decimals: number): string {
  const verb = `${side === 'buy' ? 'Buy' : 'Sell'} ${KIND_WORD[kind]}`;
  return `${qty === null ? verb : `${verb} ${String(qty)}`} · ${formatPrice(price, decimals)}`;
}

export function ocoWords(
  stopTicks: number | null,
  targetTicks: number | null,
  tickValue: number,
  qty: number,
  short = false,
): string | null {
  const money = (v: number) => formatMoney(v, { signed: true });
  const parts = [
    stopTicks !== null ? `${money(-stopTicks * tickValue * qty)}${short ? '' : ' stop'}` : null,
    targetTicks !== null ? `${money(targetTicks * tickValue * qty)}${short ? '' : ' target'}` : null,
  ].filter((x): x is string => x !== null);
  return parts.length ? parts.join(' · ') : null;
}

export type AccountGate =
  | { kind: 'none' }
  | { kind: 'readonly'; why: string }
  | { kind: 'refused'; why: string }
  | { kind: 'open'; offPaper: boolean };

export function unsizedWords(symbol: string): string {
  return symbol ? `Open a ${symbol} chart to size orders here` : 'Open a chart of this instrument to size orders here';
}

export function readOnlyWords(why: string): string {
  const first = why.split(/[;.]/)[0]?.trim() ?? '';
  return first === '' ? why : first;
}

export interface HoverTrade {
  side: Side;
  price: number;
  kind: EntryKind;
  qty: number | null;
  risk: number | null;
  refusal: string | null;
  pnl: number | null;
  oco: string | null;
  ocoShort?: string | null;
}

export interface Strip {
  left: string;
  who: string | null;
  right: string | null;
  rightShort: string | null;
  tone: 'plain' | 'risk' | 'err';
  rightTone: 'plain' | 'up' | 'down' | 'err';
  action: { label: string; section: 'accounts' | 'connections' } | null;
}

export interface StripInput {
  now: number;
  placing: { hint: string; error: string | null } | null;
  flash: { text: string; tone: 'err' | 'info' } | null;
  feed: FeedState;
  account: AccountGate;
  hover: HoverTrade | null;
  decimals: number;
  who?: string | null;
}

function money(v: number): string {
  return formatMoney(v, { signed: true });
}

export function stripFor(s: StripInput): Strip | null {
  const plain = (left: string, extra: Partial<Strip> = {}): Strip => ({
    left,
    who: null,
    right: null,
    rightShort: null,
    tone: 'plain',
    rightTone: 'plain',
    action: null,
    ...extra,
  });
  if (s.flash) return plain(s.flash.text, { tone: s.flash.tone === 'err' ? 'err' : 'plain' });
  if (s.placing) {
    return s.placing.error
      ? plain(s.placing.hint, { right: s.placing.error, rightTone: 'err' })
      : plain(s.placing.hint);
  }
  const f = s.feed;
  if (f.kind === 'nobook')
    return plain('This connection has no order book', { action: { label: 'Connections', section: 'connections' } });
  if (f.kind === 'dropped' || f.kind === 'closed') return plain(f.words);
  if (f.kind === 'stale')
    return plain(
      f.resyncing && f.behindMs < 1000 ? 'Book resyncing' : `Book ${(f.behindMs / 1000).toFixed(1)} s behind`,
    );
  if (f.kind === 'reading') return null;
  if (s.account.kind === 'refused') return plain(s.account.why);
  const h = s.hover;
  if (!h) return null;
  const pnl = h.pnl !== null ? money(h.pnl) : null;
  const pnlTone: Strip['rightTone'] = h.pnl === null ? 'plain' : h.pnl > 0 ? 'up' : h.pnl < 0 ? 'down' : 'plain';
  if (s.account.kind === 'none')
    return plain('Choose an account', { action: { label: 'Accounts', section: 'accounts' } });
  if (s.account.kind === 'readonly') return plain(readOnlyWords(s.account.why), { right: pnl, rightTone: pnlTone });
  const verb = verbWords(h.side, h.kind, h.qty, h.price, s.decimals);
  const tone: Strip['tone'] = 'plain';
  const who = s.who ?? null;
  if (h.refusal) return plain(verb, { tone, who, right: h.refusal, rightTone: 'err' });
  if (pnl !== null) return plain(verb, { tone, who, right: pnl, rightTone: pnlTone });
  if (h.qty === null && h.risk !== null) return plain(verb, { tone, who, right: `${formatMoney(h.risk)} risk` });
  return plain(verb, { tone, who, right: h.oco, rightShort: h.oco ? (h.ocoShort ?? null) : null });
}

export function refusalWords(kind: EntryKind, error: string | null): string | null {
  if (!error) return null;
  return kind === 'stop' || kind === 'stop_limit' ? 'triggers at once' : 'fills at once';
}

export function sizeWords(v: number): string {
  if (!(v > 0)) return '';
  if (v >= 10_000) {
    const k = v / 1000;
    return `${k >= 100 ? String(Math.round(k)) : (Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  }
  const n = Math.round(v * 100) / 100;
  return Number.isInteger(n) ? formatCount(n) : String(n);
}

export function droppedReader(
  link: LinkState,
  providers: readonly ProviderHealth[],
): (p: string | null) => string | null {
  const held = new Map<string | null, string | null>();
  return (provider) => {
    let w = held.get(provider);
    if (w === undefined) {
      w = droppedWords(link, providers, provider);
      held.set(provider, w);
    }
    return w;
  };
}

export function droppedWords(
  link: LinkState,
  providers: readonly ProviderHealth[],
  provider: string | null,
): string | null {
  const problems = healthProblems(link, providers);
  const runtime = problems.find((p) => p.key === 'runtime' && p.severity === 'down');
  if (runtime && link.everConnected && link.status !== 'open') return runtime.text;
  if (!provider) return null;
  return problems.find((p) => p.key === provider && p.severity === 'down')?.text ?? null;
}
