import { msToNs, normalizeEpochMs, Runtime, type TradesOutput } from '@tessera/protocol';
import { Lifetime } from '../../app/lifetime.ts';
import { appClient } from '../../app/services.ts';
import { Refill, type InstrumentFlow } from '../../market/flow/hub.ts';
import type { FocusPrint } from '../../market/flow/events.ts';
import { formatPrice, MOTION } from '@tessera/ui';
import {
  highlightSize,
  historyBefore,
  ordersOf,
  pillFor,
  printsOf,
  rowsPerSecond,
  TapeClock,
  TapeList,
  TapePacer,
  type HistoryRow,
  type TapeParams,
  type TapePill,
  type TapeRow,
  type TapeSource,
} from './tapeModel.ts';
import type { TapeView } from './tapeView.ts';
import { MenuHold } from '../menuHold.ts';

export interface TapeContext {
  params: TapeParams;
  decimals: number;
  dropped: (provider: string | null) => string | null;
  closed: string | null;
}

export interface TapeActions {
  pill(p: TapePill | null): void;
  loading(on: boolean): void;
  mark(row: TapeRow | null): void;
  tip?(t: { text: string; box: DOMRect } | null): void;
}

export function rowTip(r: TapeRow, decimals: number): string | null {
  if (r.prints <= 1) return null;
  return `Average ${formatPrice(r.average, decimals)} · ${String(r.prints)} prints`;
}

const HISTORY_ROWS = 5_000;

const FLASH_MS = 4_000;
const CHECK_MS = 250;

function historyRows(out: TradesOutput): HistoryRow[] {
  return out.trades.map((t, k) => ({
    ns: Math.abs(t[0]) >= 1e17 ? t[0] : normalizeEpochMs(t[0]) * 1e6,
    price: out.aggregated ? (out.last[k] ?? t[1]) : t[1],
    average: t[1],
    size: t[2],
    side: t[3],
    prints: out.aggregated ? (out.prints[k] ?? 1) : 1,
  }));
}

type Hold = 'hover' | 'held' | null;

export class TapeController {
  private flow: InstrumentFlow | null = null;
  private offs: (() => void)[] = [];
  readonly list = new TapeList();
  private readonly blank = new TapeList();
  private readonly pacer = new TapePacer();
  private historyIn = false;
  private loadingShown: boolean | null = null;
  private readonly clock = new TapeClock();
  private hold: Hold = null;
  private focus: string | null = null;
  private marked: string | null = null;
  private flash: { text: string; until: number } | null = null;
  private raf = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pillKey = '';
  private historyKey = '';
  private readonly history = new Lifetime();
  private readonly historyAgain = new Refill(this.history);
  private disposed = false;
  private hidden = false;
  private readonly win: Window;
  private tipKey: string | null = null;
  private tipTimer: ReturnType<typeof setTimeout> | null = null;
  private tipClosedAt = 0;
  private readonly menuHold: MenuHold;

  constructor(
    private readonly view: TapeView,
    private readonly ctx: () => TapeContext,
    private readonly actions: TapeActions,
    private readonly rowHeight: () => number,
    private readonly zone: HTMLElement = view.viewport,
  ) {
    this.win = view.viewport.ownerDocument.defaultView ?? window;
    this.menuHold = new MenuHold(zone, () => {
      if (this.list.frozen) this.resume();
    });
    const vp = view.viewport;
    zone.addEventListener('pointerenter', this.onEnter);
    zone.addEventListener('pointerleave', this.onLeave);
    vp.addEventListener('scroll', this.onScroll, { passive: true });
    vp.addEventListener('click', this.onClick);
    vp.addEventListener('pointermove', this.onMove);
  }

  dispose(): void {
    this.disposed = true;
    this.menuHold.dispose();
    this.setFlow(null);
    this.stopTimer();
    if (this.tipTimer) clearTimeout(this.tipTimer);
    if (this.raf) this.win.cancelAnimationFrame(this.raf);
    this.view.dispose();
    const vp = this.view.viewport;
    this.zone.removeEventListener('pointerenter', this.onEnter);
    this.zone.removeEventListener('pointerleave', this.onLeave);
    vp.removeEventListener('scroll', this.onScroll);
    vp.removeEventListener('click', this.onClick);
    vp.removeEventListener('pointermove', this.onMove);
  }

  onResized(): void {
    this.view.measureAfterResize();
    this.frame();
  }

  setFlow(flow: InstrumentFlow | null): void {
    if (flow === this.flow) return;
    for (const off of this.offs.splice(0)) off();
    this.flow = flow;
    this.historyKey = '';
    this.historyIn = false;
    this.history.end();
    this.list.dropLive();
    this.focus = null;
    this.marked = null;
    this.hold = null;
    this.list.resume();
    this.pacer.reset();
    if (flow) {
      this.offs.push(flow.tradesChanged.on(this.invalidate));
      this.offs.push(flow.statusChanged.on(this.invalidate));
    }
    this.hideTip();
    this.view.scrollTo(0);
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

  private sources: { flow: InstrumentFlow; prints: TapeSource; orders: TapeSource } | null = null;

  private source(flow: InstrumentFlow, p: TapeParams): TapeSource {
    if (this.sources?.flow !== flow) {
      const big = (seq: number) => (flow.bigs.get(seq) ?? flow.bigs.containing(seq)) !== undefined;
      this.sources = { flow, prints: printsOf(flow.tape, big), orders: ordersOf(flow.agg, big) };
    }
    return p.aggregate ? this.sources.orders : this.sources.prints;
  }

  frame(): void {
    if (this.disposed) return;
    const flow = this.flow;
    const c = this.ctx();
    const p = c.params;
    if (this.flash && Date.now() >= this.flash.until) this.flash = null;
    if (flow) {
      if (p.highlight === 'auto') flow.loadThreshold();
      const src = this.syncList(flow, p);
      this.readHistory(flow, p, src);
      if (!this.list.frozen && this.hold) this.hold = null;
    }
    if (!this.list.frozen && this.view.scroll !== 0) this.view.scrollTo(0);
    const loading = flow !== null && !flow.tradesError && !this.historyIn;
    this.view.render(loading ? this.blank : this.list, Math.max(1, this.rowHeight()), this.clock, {
      highlight: flow ? highlightSize(p, flow.threshold?.size ?? null) : null,
      byRule: p.highlight === 'auto',
      focus: this.focus,
      marked: this.marked,
      millis: p.millis,
      aggregate: p.aggregate,
      decimals: c.decimals,
    });
    if (loading !== this.loadingShown) {
      this.loadingShown = loading;
      this.actions.loading(loading);
    }
    const dropped = flow ? (c.dropped(flow.info.source?.provider ?? null) ?? flow.tradesError) : null;
    const pill = pillFor({
      frozen: this.list.frozen,
      fresh: this.list.fresh,
      held: this.hold === 'held',
      dropped,
      flash: this.flash?.text ?? null,
      closed: this.list.length === 0 ? c.closed : null,
    });
    if (this.flash || dropped) this.startTimer();
    else this.stopTimer();
    const key = pill ? `${pill.kind}|${pill.text}` : '';
    if (key !== this.pillKey) {
      this.pillKey = key;
      this.actions.pill(pill);
    }
  }

  private syncList(flow: InstrumentFlow, p: TapeParams): TapeSource {
    this.list.setFilter({ minSize: p.minSize, side: p.side });
    const src = this.source(flow, p);
    this.list.sync(src);
    this.pace(p);
    return src;
  }

  private pace(p: TapeParams): void {
    const perSecond = rowsPerSecond(p.speed);
    this.list.setPaced(perSecond !== null);
    if (perSecond === null || this.list.frozen) {
      this.pacer.reset();
      return;
    }
    this.pacer.step(this.list, this.win.performance.now(), perSecond);
    if (this.list.waiting > 0) this.invalidate();
  }

  private freeze(hold: 'hover' | 'held'): void {
    if (this.flow) this.syncList(this.flow, this.ctx().params);
    this.list.freeze();
    this.hold = hold;
    this.invalidate();
  }

  private startTimer(): void {
    this.timer ??= setInterval(() => this.invalidate(), CHECK_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private readHistory(flow: InstrumentFlow, p: TapeParams, src: TapeSource): void {
    if (flow.tape.seq === null) return;
    const key = `${String(flow.tape.epoch)}|${String(p.aggregate)}|${String(p.minSize)}`;
    if (key === this.historyKey) return;
    const first = TapeList.firstLiveNs(src);
    this.historyKey = key;
    this.historyIn = false;
    this.history.end();
    this.list.setHistory([]);
    const question = () =>
      Runtime.invoke(appClient(), 'market.get_trades', {
        instrument: flow.instrument,
        ...(first !== null ? { to: Math.floor(first) } : { to: msToNs(flow.clock.now()) }),
        limit: HISTORY_ROWS,
        aggregate: p.aggregate,
        ...(p.minSize > 0 ? { minSize: p.minSize } : {}),
      });
    const take = (out: TradesOutput) => {
      this.list.setHistory(historyBefore(historyRows(out), first));
      this.historyIn = true;
      this.invalidate();
    };
    this.history.run(
      question,
      (out) => {
        take(out);
        if (out.filling) this.historyAgain.ask(key, question, take);
      },
      () => {
        this.historyIn = true;
        this.invalidate();
      },
    );
  }

  toggle(): void {
    if (this.list.frozen) this.resume();
    else this.freeze('held');
  }

  resume(): boolean {
    const was = this.list.frozen;
    this.list.resume();
    this.hold = null;
    this.focus = null;
    this.view.scrollTo(0);
    this.invalidate();
    return was;
  }

  get paused(): boolean {
    return this.list.frozen;
  }

  private readonly onEnter = (): void => {
    if (!this.list.frozen) this.freeze('hover');
  };

  private readonly onLeave = (): void => {
    this.hideTip();
    if (this.menuHold.active) return;
    if (this.list.frozen) this.resume();
  };

  menuOpened(): void {
    this.hideTip();
    this.menuHold.opened();
    if (!this.list.frozen) this.freeze('hover');
  }

  menuClosed(): void {
    this.menuHold.closed();
  }

  private readonly onScroll = (): void => {
    this.hideTip();
    if (!this.list.frozen && this.view.scroll > 0) this.freeze('held');
    else this.invalidate();
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.actions.tip) return;
    const pos = this.view.posAt(e.target);
    const row = pos === null ? null : this.list.row(pos);
    const text = row ? rowTip(row, this.ctx().decimals) : null;
    const key = row && text ? row.key : null;
    if (key === this.tipKey) return;
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.tipTimer = null;
    if (key === null || pos === null || text === null) {
      this.hideTip();
      return;
    }
    const show = () => {
      this.tipTimer = null;
      const el = this.view.rowEl(pos);
      if (!el) return;
      this.tipKey = key;
      this.actions.tip?.({ text, box: el.getBoundingClientRect() });
    };
    if (this.tipKey !== null || Date.now() - this.tipClosedAt < MOTION.tooltipSkipMs) show();
    else this.tipTimer = setTimeout(show, MOTION.tooltipDelayMs);
  };

  private hideTip(): void {
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.tipTimer = null;
    if (this.tipKey === null) return;
    this.tipKey = null;
    this.tipClosedAt = Date.now();
    this.actions.tip?.(null);
  }

  private readonly onClick = (e: MouseEvent): void => {
    const pos = this.view.posAt(e.target);
    const row = pos === null ? null : this.list.row(pos);
    if (!row) return;
    this.marked = row.key;
    this.actions.mark(row);
    this.invalidate();
  };

  clearMark(): void {
    if (this.marked === null) return;
    this.marked = null;
    this.invalidate();
  }

  focusPrint(f: FocusPrint): boolean {
    const flow = this.flow;
    if (!flow) return false;
    this.list.resume();
    this.frame();
    const pos = this.list.find(f.ref, f.t, f.size);
    if (pos === null) {
      const p = this.ctx().params;
      const side = f.side ?? 0;
      const filtered = f.size < p.minSize || (p.side === 'buy' && side < 0) || (p.side === 'sell' && side > 0);
      this.say(filtered ? 'The filter hides that print' : 'That print is older than this list');
      return false;
    }
    const row = this.list.row(pos)!;
    this.freeze('held');
    this.focus = row.key;
    const rowH = Math.max(1, this.rowHeight());
    const h = this.view.viewHeight;
    this.view.scrollTo(Math.max(0, pos * rowH - Math.max(0, (h - rowH) / 2)));
    this.invalidate();
    return true;
  }

  say(text: string): void {
    this.flash = { text, until: Date.now() + FLASH_MS };
    this.invalidate();
  }

  get focused(): string | null {
    return this.focus;
  }
}
