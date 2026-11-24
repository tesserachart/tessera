import type { Side } from '@tessera/protocol';
import { formatPrice } from '@tessera/ui';
import type { InstrumentFlow } from '../../market/flow/hub.ts';
import type { ProfileFeed } from '../../market/flow/profiles.ts';
import type { SessionProfileData } from '@tessera/chart';
import type { PlaceQuote, Placement } from '../../chart/placement.ts';
import type { Bracket } from '../../chart/brackets.ts';
import { SETTLE_MS } from '../../app/settle.ts';
import {
  autoCentred,
  centredOn,
  edgeMarks,
  entriesOpen,
  feedState,
  ladderRows,
  outsideMiddle,
  PressGate,
  PriceLabels,
  RecentVolume,
  rowFloor,
  rowIndex,
  rowLow,
  scrolled,
  sessionVolume,
  stepRowTicks,
  stripFor,
  tradeTick,
  withRows,
  withRowTicks,
  type AccountGate,
  type DomParams,
  type FeedState,
  type HoverTrade,
  type LadderRow,
  type EdgeMark,
  type LadderTag,
  type LadderWindow,
  type Strip,
  type VolumeView,
  columnClasses,
  fitColumns,
  ladderTemplate,
  priceColumnWidth,
  type LadderColumns,
} from './ladderModel.ts';
import type { LadderHit, LadderView } from './ladderView.ts';
import { DEFAULT_WINDOW_MS, LevelFlow, QueueEstimate, type QueuedOrder } from './ladderFlow.ts';
import { MenuHold } from '../menuHold.ts';
import { dropOnSecondaryPress, isPrimaryPress } from '../../shell/secondaryPress.ts';

function entriesClosedWhy(feed: FeedState): string {
  if (feed.kind === 'closed') return 'Market closed';
  return feed.kind === 'stale' ? 'Book stale' : 'No live book';
}

export interface DomContext {
  params: DomParams;
  gate: AccountGate;
  tags: readonly LadderTag[];
  position: { side: Side; qty: number; average: number; bracket: Bracket } | null;
  placing: Placement | null;
  quote: PlaceQuote;
  dropped: (provider: string | null) => string | null;
  closed: string | null;
  placingLine: (p: Placement, price: number | null, q: PlaceQuote) => { hint: string; error: string | null };
  hoverTrade: (side: Side, price: number, q: PlaceQuote) => HoverTrade;
  decimals: number;
  who: string | null;
}

export interface DomActions {
  trade(side: Side, price: number): Promise<string | null>;
  close(tag: LadderTag): void;
  endPlacement(): void;
  move(tag: LadderTag, fromPrice: number, toPrice: number): Promise<boolean>;
  spawn(price: number): void;
  showDraft(tag: LadderTag): void;
  pickAccount(accountId: string): void;
  setRowTicks(rt: DomParams['rowTicks']): void;
  cancelAll(): void;
  flatten(): void;
  strip(s: Strip | null): void;
  edge(marks: readonly EdgeMark[]): void;
  columns(c: LadderColumns): void;
  loading(on: boolean): void;
}

export interface MenuRow {
  row: number;
  low: number;
  buy: number;
  sell: number;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  tags: LadderTag[];
}

const FLASH_MS = 4000;
const STALE_CHECK_MS = 250;

export class DomController {
  private flow: InstrumentFlow | null = null;
  private profiles: ProfileFeed | null = null;
  private offs: (() => void)[] = [];
  private window: LadderWindow | null = null;
  private paused = false;
  private pointerOver = false;
  private hover: LadderHit | null = null;
  private readonly press = new PressGate();
  private pressId = 0;
  private drag: { tag: LadderTag; row: number; fromRow: number; pointer: number; moved: boolean } | null = null;
  private settling: { tag: LadderTag; tick: number; until: number } | null = null;
  private flash: { text: string; tone: 'err' | 'info'; until: number } | null = null;
  private readonly recent = new RecentVolume();
  private levelFlow: LevelFlow | null = null;
  private readonly queue = new QueueEstimate();
  private cols = '';
  private rows: LadderRow[] = [];
  private readonly labels = new PriceLabels();
  private pxCol = '';
  private sessionVol: { of: SessionProfileData | null; view: VolumeView | null } | null = null;
  private feed: FeedState = { kind: 'reading' };
  private loadingShown: boolean | null = null;
  private raf = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stripKey = '';
  private edgeKey = '';
  private wheelRows = 0;
  private lastRowTicks = 0;
  private disposed = false;
  private hidden = false;
  private readonly win: Window;
  private height: number;
  private width: number;
  private readonly menuHold: MenuHold;
  private readonly offSecondary: () => void;

  constructor(
    private readonly view: LadderView,
    private readonly ctx: () => DomContext,
    private readonly actions: DomActions,
    private readonly rowHeight: () => number,
  ) {
    this.win = view.root.ownerDocument.defaultView ?? window;
    this.height = view.root.clientHeight;
    this.width = view.root.clientWidth;
    this.menuHold = new MenuHold(view.root, () => {
      this.pointerOver = false;
      this.invalidate();
    });
    this.timer = setInterval(() => this.check(), STALE_CHECK_MS);
    const root = view.root;
    root.addEventListener('pointermove', this.onMove);
    root.addEventListener('pointerleave', this.onLeave);
    root.addEventListener('pointerdown', this.onDown);
    root.addEventListener('pointerup', this.onUp);
    root.addEventListener('pointercancel', this.onCancel);
    root.addEventListener('click', this.onClick);
    root.addEventListener('wheel', this.onWheel, { passive: false });
    this.win.addEventListener('keydown', this.onEscape, true);
    this.offSecondary = dropOnSecondaryPress(this.win, this.onSecondary);
  }

  private readonly onEscape = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || (!this.drag && !this.press.current)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.escape();
  };

  private readonly onSecondary = (e: MouseEvent): boolean => {
    if (this.escape()) return true;
    if (!this.ctx().placing || !(e.target instanceof Node) || !this.view.root.contains(e.target)) return false;
    this.actions.endPlacement();
    return true;
  };

  dispose(): void {
    this.disposed = true;
    this.menuHold.dispose();
    this.setFlow(null, null);
    if (this.timer) clearInterval(this.timer);
    if (this.raf) this.win.cancelAnimationFrame(this.raf);
    const root = this.view.root;
    root.removeEventListener('pointermove', this.onMove);
    root.removeEventListener('pointerleave', this.onLeave);
    root.removeEventListener('pointerdown', this.onDown);
    root.removeEventListener('pointerup', this.onUp);
    root.removeEventListener('pointercancel', this.onCancel);
    root.removeEventListener('click', this.onClick);
    root.removeEventListener('wheel', this.onWheel);
    this.win.removeEventListener('keydown', this.onEscape, true);
    this.offSecondary();
  }

  setFlow(flow: InstrumentFlow | null, profiles: ProfileFeed | null): void {
    if (flow === this.flow && profiles === this.profiles) return;
    for (const off of this.offs.splice(0)) off();
    if (flow !== this.flow) {
      this.window = null;
      this.paused = false;
      this.press.cancel();
      this.drag = null;
      this.levelFlow = null;
    }
    this.flow = flow;
    this.profiles = profiles;
    if (flow) {
      this.offs.push(flow.bookChanged.on(this.invalidate));
      this.offs.push(flow.tradesChanged.on(this.invalidate));
      this.offs.push(flow.statusChanged.on(this.invalidate));
    }
    if (profiles) this.offs.push(profiles.changed.on(this.invalidate));
    this.invalidate();
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (!hidden) this.invalidate();
  }

  readonly invalidate = (): void => {
    if (this.raf || this.disposed || this.hidden) return;
    this.raf = this.win.requestAnimationFrame(() => {
      this.raf = 0;
      this.frame();
    });
  };

  onResized(): void {
    this.height = this.view.root.clientHeight;
    this.width = this.view.root.clientWidth;
    this.frame();
  }

  frame(): void {
    if (this.disposed) return;
    const flow = this.flow;
    const c = this.ctx();
    const now = flow ? flow.clock.now() : Date.now();
    const h = this.height;
    const rowH = Math.max(1, this.rowHeight());
    const whole = Math.max(1, Math.floor(h / rowH));
    const count = Math.max(1, Math.ceil(h / rowH));
    this.view.setCount(count);
    this.view.closable = c.gate.kind === 'open';
    if (this.flash && Date.now() >= this.flash.until) this.flash = null;

    const book = flow?.book ?? null;
    const last = this.lastTick(c);
    const rt = c.params.rowTicks;
    if (!this.window) {
      const anchor = last ?? (book && Number.isFinite(book.bestBid) ? book.bestBid : null);
      if (anchor !== null) this.window = centredOn(anchor, rt, whole, 1);
    }
    if (this.window) {
      if (rt !== this.window.rowTicks) this.window = withRowTicks(this.window, rt, last);
      this.window = withRows(this.window, whole);
      this.window = autoCentred(this.window, last, {
        paused: this.paused,
        pointerOver: this.pointerOver,
        enabled: c.params.autoCentre,
      });
    }
    this.lastRowTicks = rt;

    const p = c.params;
    const sessionView = (): VolumeView | null => {
      if (!this.profiles) return null;
      const list = this.profiles.periods('session');
      const session = list[list.length - 1] ?? null;
      if (this.sessionVol?.of !== session) this.sessionVol = { of: session, view: sessionVolume(session) };
      return this.sessionVol.view;
    };
    if (flow && (p.volumeColumn === 'recent' || p.traded === 'recent')) this.recent.sync(flow.tape, now);
    const volume: VolumeView | null =
      p.volumeColumn === 'recent' && flow ? this.recent : p.volumeColumn === 'session' ? sessionView() : null;
    const traded: VolumeView | null =
      p.traded === 'recent' && flow ? this.recent : p.traded === 'session' ? sessionView() : null;
    const windowMs = p.pullStack > 0 ? p.pullStack * 1000 : DEFAULT_WINDOW_MS;
    const measure = flow && (p.pullStack > 0 || p.refills || p.queue);
    if (measure) {
      if (this.levelFlow?.windowMs !== windowMs) this.levelFlow = new LevelFlow(windowMs);
      this.levelFlow.syncTape(flow.tape);
      if (book && !book.isStale(now)) this.levelFlow.sample(book, now);
    } else this.levelFlow = null;
    const levels = this.levelFlow && (p.pullStack > 0 || p.refills) ? this.levelFlow : null;
    const tags = p.queue && flow && this.levelFlow && book ? this.queued(c.tags, flow, book) : c.tags;

    this.feed = flow
      ? feedState(book!, now, {
          error: flow.depthError,
          dropped: c.dropped(flow.info.source?.provider ?? null),
          closed: c.closed,
        })
      : { kind: 'reading' };
    if ((this.feed.kind === 'reading') !== this.loadingShown) {
      this.loadingShown = this.feed.kind === 'reading';
      this.actions.loading(this.loadingShown);
    }
    const w = this.window;
    this.rows = w
      ? ladderRows(
          {
            window: w,
            count,
            book: book && book.seq !== null ? book : null,
            last,
            volume,
            tags,
            average: c.position ? Math.round(c.position.average / (flow?.grid.tick ?? 1)) : null,
            pnlSide: p.pnl && c.position ? c.position.side : null,
            traded,
            levels: levels
              ? {
                  change: (side, low, rt) => (p.pullStack > 0 ? levels.change(side, low, rt) : 0),
                  refilled: (side, low, rt) => (p.refills ? levels.refilled(side, low, rt) : 0),
                }
              : null,
            orderCounts: p.orders,
            lastTrade: this.lastTrade(),
            toPrice: (t) => flow!.grid.toPrice(t),
            decimals: c.decimals,
            tick: flow?.grid.tick ?? 1,
          },
          this.rows,
          this.labels,
        )
      : [];
    const root = this.view.root;
    const chars = this.rows.reduce((m, r) => Math.max(m, r.price.length), 0);
    const pxCol = `${String(Math.max(6, chars))}ch`;
    if (this.pxCol !== pxCol) {
      this.pxCol = pxCol;
      this.view.frame.style.setProperty('--lad-px-ch', pxCol);
    }
    const stale = this.feed.kind !== 'live';
    if (root.classList.contains('is-stale') !== stale) root.classList.toggle('is-stale', stale);
    const inert = c.gate.kind !== 'open' || stale;
    if (root.classList.contains('is-inert') !== inert) root.classList.toggle('is-inert', inert);
    const nobook = this.feed.kind === 'nobook';
    if (root.classList.contains('is-nobook') !== nobook) root.classList.toggle('is-nobook', nobook);
    const volShown = c.params.volumeColumn;
    if (root.dataset.vol !== volShown) root.dataset.vol = volShown;
    const asked: LadderColumns = {
      pnl: p.pnl && c.position !== null,
      pullStack: p.pullStack > 0,
      traded: p.traded !== 'off',
      volume: p.volumeColumn !== 'off',
      nobook,
      orders: p.orders,
    };
    const priceWidth = priceColumnWidth(chars);
    const columns = this.width > 0 ? fitColumns(asked, this.width, priceWidth) : asked;
    const template = ladderTemplate(columns);
    if (this.cols !== template) {
      this.cols = template;
      this.view.frame.style.setProperty('--lad-cols', template);
      for (const [cls, on] of Object.entries(columnClasses(columns))) root.classList.toggle(cls, on);
      root.classList.toggle('no-vol', asked.volume && !columns.volume);
      this.actions.columns(columns);
    }

    const hover =
      this.hover && (this.hover.cell === 'bid' || this.hover.cell === 'ask') && !this.hover.tag && !this.drag
        ? { row: this.hover.row, cell: this.hover.cell }
        : null;
    const press = this.press.current;
    const held = this.held();
    const dragged = this.drag
      ? new Map([[this.drag.tag.key, this.drag.tag]])
      : held
        ? new Map([[held.tag.key, held.tag]])
        : null;
    this.view.render(
      this.rows,
      {
        hover: inert ? null : hover,
        press: press && !inert ? { row: press.row, cell: press.cell } : null,
        drag: this.drag?.moved
          ? { key: this.drag.tag.key, row: this.drag.row }
          : held && this.window
            ? { key: held.tag.key, row: rowIndex(this.window, held.tick) }
            : null,
        volume: c.params.volumeColumn,
      },
      dragged,
    );
    this.writeStrip(c, now, hover);
    this.writeEdge(last, flow, tags);
  }

  private lastTrade(): { size: number; side: number } | null {
    const tape = this.flow?.tape;
    if (!tape || tape.end <= tape.start) return null;
    const i = tape.end - 1;
    return { size: tape.sizeAt(i), side: tape.sideAt(i) };
  }

  private queued(
    tags: readonly LadderTag[],
    flow: InstrumentFlow,
    book: NonNullable<InstrumentFlow['book']>,
  ): readonly LadderTag[] {
    const resting: QueuedOrder[] = [];
    for (const t of tags) {
      const o = t.orders[0];
      if (!o || t.state !== 'working' || (t.role !== 'entry' && t.role !== 'target')) continue;
      if (o.request.orderType !== 'limit') continue;
      resting.push({ id: o.id, side: t.side, tick: t.tick, qty: t.qty, brokerAhead: o.queueAhead });
    }
    if (resting.length === 0) return tags;
    this.queue.update(resting, book, this.levelFlow!);
    return tags.map((t) => {
      const o = t.orders[0];
      if (!o || !resting.some((r) => r.id === o.id)) return t;
      return { ...t, ahead: this.queue.ahead({ id: o.id, brokerAhead: o.queueAhead }) };
    });
  }

  private lastTick(c: DomContext): number | null {
    const flow = this.flow;
    if (!flow) return null;
    const tape = flow.tape;
    if (tape.end > tape.start) return tape.tickAt(tape.end - 1);
    return c.quote.last !== null ? flow.grid.toTick(c.quote.last) : null;
  }

  quote(): PlaceQuote {
    const c = this.ctx();
    const flow = this.flow;
    const book = flow?.book;
    if (!flow || !book || this.feed.kind !== 'live') return c.quote;
    const last = this.lastTick(c);
    return {
      bid: Number.isFinite(book.bestBid) ? flow.grid.toPrice(book.bestBid) : c.quote.bid,
      ask: Number.isFinite(book.bestAsk) ? flow.grid.toPrice(book.bestAsk) : c.quote.ask,
      last: last !== null ? flow.grid.toPrice(last) : c.quote.last,
    };
  }

  private priceAt(row: number, side: Side): number | null {
    const flow = this.flow;
    const w = this.window;
    if (!flow || !w) return null;
    const book = flow.book.seq !== null ? flow.book : null;
    return flow.grid.toPrice(tradeTick(side, rowLow(w, row), w.rowTicks, book));
  }

  private writeStrip(c: DomContext, now: number, hover: { row: number; cell: 'bid' | 'ask' } | null): void {
    const q = c.placing || hover ? this.quote() : c.quote;
    const side: Side | null = hover ? (hover.cell === 'bid' ? 'buy' : 'sell') : null;
    const price = hover && side ? this.priceAt(hover.row, side) : null;
    const strip = stripFor({
      now,
      placing: c.placing ? c.placingLine(c.placing, this.hover ? this.priceAtAny(this.hover.row) : null, q) : null,
      flash: this.flash,
      feed: this.feed,
      account: c.gate,
      hover: side && price !== null ? c.hoverTrade(side, price, q) : null,
      decimals: c.decimals,
      who: c.who,
    });
    const key = JSON.stringify(strip);
    if (key === this.stripKey) return;
    this.stripKey = key;
    this.actions.strip(strip);
  }

  private priceAtAny(row: number): number | null {
    const flow = this.flow;
    const w = this.window;
    return flow && w ? flow.grid.toPrice(rowLow(w, row)) : null;
  }

  private writeEdge(last: number | null, flow: InstrumentFlow | null, tags: readonly LadderTag[]): void {
    const w = this.window;
    const decimals = this.ctx().decimals;
    const marks = w && flow ? edgeMarks(w, last, tags, (tick) => formatPrice(flow.grid.toPrice(tick), decimals)) : [];
    const key = marks.map((m) => `${m.where}|${m.key}|${m.text}`).join(',');
    if (key === this.edgeKey) return;
    this.edgeKey = key;
    this.actions.edge(marks);
  }

  private check(): void {
    const flow = this.flow;
    if (!flow) return;
    const now = flow.clock.now();
    const was = this.feed;
    const c = this.ctx();
    const next = feedState(flow.book, now, {
      error: flow.depthError,
      dropped: c.dropped(flow.info.source?.provider ?? null),
      closed: c.closed,
    });
    if (next.kind !== was.kind || next.kind === 'stale' || this.flash) this.invalidate();
  }

  centre(): void {
    const last = this.lastTick(this.ctx());
    const w = this.window;
    this.paused = false;
    if (w && last !== null) this.window = centredOn(last, w.rowTicks, w.rows, w.gen + 1);
    this.invalidate();
  }

  show(tick: number): void {
    const w = this.window;
    if (!w) return;
    this.window = centredOn(tick, w.rowTicks, w.rows, w.gen + 1);
    this.paused = true;
    this.invalidate();
  }

  scroll(rows: number): void {
    if (!this.window || rows === 0) return;
    this.window = scrolled(this.window, rows);
    this.paused = true;
    this.invalidate();
  }

  get page(): number {
    return Math.max(1, (this.window?.rows ?? 2) - 1);
  }

  private held(): { tag: LadderTag; tick: number } | null {
    const s = this.settling;
    if (!s) return null;
    const w = this.window;
    const now = this.rows.flatMap((r) => [...r.bidTags, ...r.askTags]).find((t) => t.key === s.tag.key);
    const there = !now || (w ? rowFloor(now.tick, w.rowTicks) === rowFloor(s.tick, w.rowTicks) : now.tick === s.tick);
    if (there || Date.now() > s.until) {
      this.settling = null;
      return null;
    }
    return s;
  }

  get holding(): boolean {
    return this.drag !== null || this.press.current !== null;
  }

  escape(): boolean {
    const had = this.drag !== null || this.press.current !== null;
    this.drag = null;
    this.press.cancel();
    if (had) this.invalidate();
    return had;
  }

  menuRow(clientX: number, clientY: number, target: EventTarget | null): MenuRow | null {
    const hit = this.view.hit(clientX, clientY, target);
    const flow = this.flow;
    const w = this.window;
    if (!hit || !flow || !w) return null;
    const r = this.rows[hit.row];
    if (!r) return null;
    return {
      row: hit.row,
      low: r.low,
      buy: this.priceAt(hit.row, 'buy') ?? flow.grid.toPrice(r.low),
      sell: this.priceAt(hit.row, 'sell') ?? flow.grid.toPrice(r.low),
      price: flow.grid.toPrice(r.low),
      bid: r.bid,
      ask: r.ask,
      volume: r.volume,
      tags: [...r.bidTags, ...r.askTags],
    };
  }

  say(text: string, tone: 'err' | 'info' = 'err'): void {
    this.flash = { text, tone, until: Date.now() + FLASH_MS };
    setTimeout(() => this.invalidate(), FLASH_MS + 20);
    this.invalidate();
  }

  entriesOpen(): { ok: true } | { ok: false; why: string } {
    const c = this.ctx();
    if (c.gate.kind === 'none') return { ok: false, why: 'No account' };
    if (c.gate.kind === 'readonly') return { ok: false, why: 'Tessera only reads this account' };
    if (c.gate.kind === 'refused') return { ok: false, why: c.gate.why };
    if (!entriesOpen(this.feed)) return { ok: false, why: entriesClosedWhy(this.feed) };
    return { ok: true };
  }

  private tagOf(key: string | null): LadderTag | null {
    if (!key) return null;
    for (const r of this.rows) for (const t of [...r.bidTags, ...r.askTags]) if (t.key === key) return t;
    return null;
  }

  private readonly onMove = (e: PointerEvent): void => {
    this.pointerOver = true;
    const hit = this.view.hit(e.clientX, e.clientY, e.target);
    if (this.drag?.pointer === e.pointerId) {
      if (hit && hit.row !== this.drag.row) {
        this.drag.row = hit.row;
        this.drag.moved = this.drag.moved || hit.row !== this.drag.fromRow;
      }
      this.invalidate();
      return;
    }
    const k = (h: LadderHit | null) => (h ? `${String(h.row)}|${h.cell}|${h.tag ?? ''}|${String(h.close)}` : '');
    if (k(hit) !== k(this.hover)) {
      this.hover = hit;
      this.invalidate();
    }
  };

  menuOpened(): void {
    this.menuHold.opened();
    this.pointerOver = true;
  }

  menuClosed(): void {
    this.menuHold.closed();
  }

  private readonly onLeave = (): void => {
    this.hover = null;
    if (this.menuHold.active) {
      this.invalidate();
      return;
    }
    this.pointerOver = false;
    this.invalidate();
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (!isPrimaryPress(e)) return;
    const hit = this.view.hit(e.clientX, e.clientY, e.target);
    if (!hit || hit.close) return;
    const c = this.ctx();
    const tag = this.tagOf(hit.tag);
    if (tag) {
      e.preventDefault();
      if (tag.account) {
        this.actions.pickAccount(tag.account.id);
        return;
      }
      if (tag.state === 'draft') {
        this.actions.showDraft(tag);
        return;
      }
      const movable = c.gate.kind === 'open' && (tag.role === 'position' || tag.orders.length > 0);
      if (movable) {
        this.view.root.setPointerCapture(e.pointerId);
        this.drag = { tag, row: hit.row, fromRow: hit.row, pointer: e.pointerId, moved: false };
      }
      return;
    }
    if ((hit.cell !== 'bid' && hit.cell !== 'ask') || c.gate.kind !== 'open' || !this.window) return;
    const side: Side = hit.cell === 'bid' ? 'buy' : 'sell';
    const price = this.priceAt(hit.row, side);
    if (price === null) return;
    e.preventDefault();
    this.view.root.setPointerCapture(e.pointerId);
    this.pressId = this.press.down({
      row: hit.row,
      cell: hit.cell,
      tick: this.flow!.grid.toTick(price),
      gen: this.window.gen,
    });
    this.invalidate();
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const hit = this.view.hit(e.clientX, e.clientY, e.target);
    const drag = this.drag;
    if (drag?.pointer === e.pointerId) {
      this.drag = null;
      this.invalidate();
      const flow = this.flow;
      const w = this.window;
      if (!flow || !w) return;
      if (!drag.moved || drag.row === drag.fromRow) return;
      if (drag.tag.role === 'position') {
        const closing: Side = drag.tag.side === 'buy' ? 'sell' : 'buy';
        const p = this.priceAt(drag.row, closing);
        if (p !== null) this.actions.spawn(p);
        return;
      }
      const from = flow.grid.toPrice(drag.tag.tick);
      const shift = (rowLow(w, drag.row) - rowFloor(drag.tag.tick, w.rowTicks)) * flow.grid.tick;
      const to = flow.grid.toPrice(flow.grid.toTick(from + shift));
      const settling = { tag: drag.tag, tick: flow.grid.toTick(to), until: Date.now() + SETTLE_MS };
      this.settling = settling;
      this.invalidate();
      void this.actions.move(drag.tag, from, to).then((sent) => {
        if (this.settling !== settling) return;
        if (!sent) this.settling = null;
        else this.settling = { ...settling, until: Date.now() + SETTLE_MS };
        this.invalidate();
        setTimeout(() => this.invalidate(), SETTLE_MS + 50);
      });
      return;
    }
    const pressed = this.press.current;
    if (!pressed) return;
    const w = this.window;
    const cell = hit && (hit.cell === 'bid' || hit.cell === 'ask') && !hit.tag ? hit.cell : null;
    const side: Side | null = cell === 'bid' ? 'buy' : cell === 'ask' ? 'sell' : null;
    const price = hit && side ? this.priceAt(hit.row, side) : null;
    const at =
      hit && cell && w && price !== null
        ? { row: hit.row, cell, tick: this.flow!.grid.toTick(price), gen: w.gen }
        : null;
    const out = this.press.up(this.pressId, at, this.entriesOpen());
    this.invalidate();
    if (!out) return;
    if (!out.send) {
      this.say(out.why);
      return;
    }
    void this.actions.trade(side!, price!).then((why) => {
      if (why) this.say(why);
    });
  };

  private readonly onCancel = (): void => {
    this.drag = null;
    this.press.cancel();
    this.invalidate();
  };

  private readonly onClick = (e: MouseEvent): void => {
    const hit = this.view.hit(e.clientX, e.clientY, e.target);
    if (!hit?.close) return;
    const tag = this.tagOf(hit.tag);
    if (tag && this.ctx().gate.kind === 'open') this.actions.close(tag);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.window) return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) {
      if (Math.abs(e.deltaY) < 1) return;
      const next = stepRowTicks(this.lastRowTicks || this.window.rowTicks, e.deltaY < 0 ? 1 : -1);
      if (next !== this.window.rowTicks) this.actions.setRowTicks(next);
      return;
    }
    const rowH = Math.max(1, this.rowHeight());
    const unit = e.deltaMode === 1 ? rowH : e.deltaMode === 2 ? rowH * this.page : 1;
    this.wheelRows += (-e.deltaY * unit) / Math.max(rowH, 40);
    const n = Math.trunc(this.wheelRows);
    if (n === 0) return;
    this.wheelRows -= n;
    this.scroll(n);
  };

  get windowNow(): LadderWindow | null {
    return this.window;
  }

  wouldRecentre(): boolean {
    const w = this.window;
    const last = this.lastTick(this.ctx());
    return !!w && last !== null && outsideMiddle(w, last);
  }

  rowOf(tick: number): number | null {
    return this.window ? rowIndex(this.window, tick) : null;
  }
}
