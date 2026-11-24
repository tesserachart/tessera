import { MINUS, PriceFormatter, timeLabel } from './format.ts';
import { GPU_PIXEL_RATIO, GpuController, type GpuHost, type WebGlSurface } from './gpu/surface.ts';
import { CandlesLayer } from './layers/candles.ts';
import { GridLayer } from './layers/grid.ts';
import { CrosshairLayer, LastPriceLayer, LegendLayer } from './layers/overlays.ts';
import { barsMissingPrints, drawMissingPrints, runAt, type DrawnRun } from './layers/missingPrints.ts';
import { LayerRegistry } from './layers/registry.ts';
import type {
  AxisTag,
  ChartLayout,
  CrosshairState,
  Ctx2D,
  GpuRenderContext,
  FigureColumn,
  LabelClaim,
  Layer,
  LayerClass,
  LayerPointerEvent,
  PriceView,
  RenderContext,
  TimeView,
} from './layers/types.ts';
import { VolumeLayer } from './layers/volume.ts';
import { formatVolumeShort } from './format.ts';
import { PixelColumns } from './render/columns.ts';
import { deOverlap, drawAxisTag, font, isLight, TextMeasurer, crisp } from './render/draw.ts';
import { PriceScale } from './scale/price.ts';
import { clamp, TimeScale } from './scale/time.ts';
import { DEFAULT_SESSIONS, SessionModel, Weight, WEIGHT_MS } from './session.ts';
import { SeriesStore, type DataChange } from './store.ts';
import { mergeTheme, TESSERA_THEME } from './theme.ts';
import type {
  BarInput,
  BarSnapshot,
  ChartCoords,
  ChartEventMap,
  ChartEventName,
  ChartOptions,
  ChartTheme,
  GpuState,
  LayerHit,
  LayerInfo,
  PaneId,
  PointerMods,
  Rect,
  SessionOptions,
  Surface2D,
  SurfaceKind,
  TimeAsk,
  ViewportState,
  ViewportUpdate,
} from './types.ts';

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
}

export interface SurfaceHost {
  readonly canvases: Readonly<Record<Surface2D, CanvasLike>>;
  resize(width: number, height: number, dpr: number): void;
  readonly gpu?: GpuHost;
  setBackground?(color: string): void;
}

export interface EngineTimers {
  now(): number;
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: EngineTimers = {
  now: () => performanceNow(),
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface FrameScheduler {
  request(cb: () => void): number;
  cancel(handle: number): void;
}

export interface SetDataOptions {
  keepView?: boolean;
}

export interface EngineOptions extends ChartOptions {
  width: number;
  height: number;
  dpr: number;
  scheduler: FrameScheduler;
  liveClock?: boolean;
  timers?: EngineTimers;
}

const PRIMARY = 'main';
const SURFACES: readonly SurfaceKind[] = ['gpu', 'underlay', 'main', 'overlay'];
const DEFAULT_MAX_SPACING = 80;
const SHOWN_EPSILON = 1e-6;
export const SETTLE_MS = 150;
export const DATA_FRAME_MS = 1000 / 30;
export const GPU_DATA_FRAME_MS = 100;
export const TIME_AXIS_H = 22;
export const MIN_AXIS_W = 48;
const LABEL_GAP_PX = 64;
const MIN_PRICE_TICK_GAP_PX = 46;
const PRICE_TICK_GAP_EM = 3.3;
const PANE_MIN_H = 36;
export const PANE_LEGEND_INSET = 26;
const PANE_LEGEND_MAX_PAD = 0.4;
const MAIN_MIN_SHARE = 0.3;
const DEFAULT_PANE_SHARE = 0.16;
const SEPARATOR_GRAB = 4;

type Listener<K extends ChartEventName> = (payload: ChartEventMap[K]) => void;

type DragMode =
  | { kind: 'pan'; x: number; y: number; right: number; pmin: number; pmax: number; moved: boolean; pane: PaneId }
  | { kind: 'price'; y: number; pmin: number; pmax: number }
  | { kind: 'time'; x: number; spacing: number; right: number }
  | { kind: 'pane'; id: PaneId; above: PaneId; y: number; share: number; aboveShare: number; moved: boolean }
  | { kind: 'layer'; layer: Layer };

interface SubPane {
  id: PaneId;
  share: number;
  layers: Layer[];
}

interface PreparedFrame {
  layout: ChartLayout;
  time: TimeView;
  columns: PixelColumns | null;
  main: PriceView;
  volume: PriceView;
  panes: ReadonlyMap<PaneId, PriceView>;
  ticks: number[];
  step: number;
  legendInset: number;
}

function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class ChartEngine {
  private readonly host: SurfaceHost;
  private readonly scheduler: FrameScheduler;
  private theme: ChartTheme;
  private format: PriceFormatter;
  private sessionOptions: SessionOptions;
  private timeframeMs: number;
  private volumeFraction: number;
  private rightPad: number;
  private initialBars: number;
  private clearLeft = 0;
  private cut = 0;
  private replaced = false;
  private gutters = new Map<string, Rect>();
  private guttersKey = '';
  private figures: readonly FigureColumn[] = [];
  private readonly nowFn: () => number;

  private width: number;
  private height: number;
  private dpr: number;
  private axisWidth = MIN_AXIS_W;
  private layoutCache: ChartLayout | null = null;
  private subPanes: SubPane[] = [];
  private readonly paneScales = new Map<PaneId, PriceScale>();
  private readonly draggedShares = new Map<PaneId, number>();

  private readonly store = new SeriesStore();
  private readonly extraSeries = new Map<string, SeriesStore>();
  private session: SessionModel;
  private readonly registry = new LayerRegistry();
  private readonly time = new TimeScale();
  private readonly price = new PriceScale();
  private following = true;
  private asked: TimeAsk | null = null;
  private askedRoom = 0;
  private viewInitialised = false;
  private fitPending = false;

  private readonly grid = new GridLayer();
  private readonly lastPrice = new LastPriceLayer();
  private readonly legend: LegendLayer;
  private readonly measurer = new TextMeasurer();
  private readonly pixelColumns = new PixelColumns();

  private readonly dirty = new Set<SurfaceKind>();
  private readonly timers: EngineTimers;
  private readonly pendingData = new Set<SurfaceKind>();
  private dataTimer: unknown = null;
  private readonly drawnAt = new Map<SurfaceKind, number>();
  private settleTimer: unknown = null;
  private readonly gpu: GpuController;
  private gpuWasOn2d = false;
  private readonly clearSurfaces = new Set<SurfaceKind>();
  private tagBands: { top: number; bottom: number }[] = [];
  private tagBandsKey = '';
  private underlayTags: AxisTag[] = [];
  private underlayTagsKey = '';
  private frameHandle: number | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private crosshair: CrosshairState | null = null;
  private gapRuns: DrawnRun[] = [];
  private gapHovered: DrawnRun | null = null;
  private drag: DragMode | null = null;
  private destroyed = false;
  private suspended = false;
  private settleOwed = false;
  private readonly listeners = new Map<ChartEventName, Set<Listener<ChartEventName>>>();

  constructor(host: SurfaceHost, options: EngineOptions) {
    this.host = host;
    this.scheduler = options.scheduler;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.gpu = new GpuController(host.gpu, () => {
      this.invalidate('all');
    });
    this.theme = mergeTheme(TESSERA_THEME, options.theme);
    this.format = new PriceFormatter(options.priceFormat ?? { precision: 2, minMove: 0.01 });
    this.sessionOptions = options.sessions ?? DEFAULT_SESSIONS;
    this.timeframeMs = options.timeframeMs ?? 300_000;
    this.volumeFraction = options.volumePane ?? 0.18;
    this.rightPad = options.rightPadBars ?? 8;
    this.initialBars = options.initialBars ?? 150;
    this.nowFn = options.now ?? Date.now;
    this.width = options.width;
    this.height = options.height;
    this.dpr = options.dpr;
    this.session = new SessionModel(this.sessionOptions, this.timeframeMs);
    const legend = options.legend ?? { title: '' };
    this.legend = new LegendLayer(
      legend ? legend.title : '',
      legend ? (legend.subtitle ?? null) : null,
      legend ? (legend.hover ?? false) : false,
    );

    this.addBuiltIn(this.grid);
    this.addBuiltIn(new CandlesLayer());
    this.addBuiltIn(new VolumeLayer());
    this.addBuiltIn(this.lastPrice);
    this.addBuiltIn(this.legend);
    this.addBuiltIn(new CrosshairLayer());
    if (!legend) this.registry.setVisible('legend', false);

    this.host.resize(this.width, this.height, this.dpr);
    this.host.setBackground?.(this.theme.background);
    if (options.liveClock ?? true) {
      this.clockTimer = setInterval(() => {
        if (
          this.registry.isVisible('last-price') &&
          this.lastPrice.isLive({ store: this.store, timeframeMs: this.timeframeMs, now: this.nowFn() })
        ) {
          this.invalidate('overlay');
        }
      }, 1000);
    }
    this.invalidate('all');
  }

  private addBuiltIn(layer: Layer): void {
    this.registry.add(layer);
    layer.attach?.(this.hostFor(layer));
  }

  private surfacesOf(layer: Layer): SurfaceKind[] {
    return layer.missingPrints && layer.surface !== 'main' ? [layer.surface, 'main'] : [layer.surface];
  }

  private hostFor(layer: Layer) {
    return {
      invalidate: (kind?: 'data') => {
        for (const s of this.surfacesOf(layer)) {
          if (kind === 'data') this.invalidateData(s);
          else this.invalidate(s);
        }
      },
      relayout: () => {
        this.draggedShares.delete(layer.pane ?? 'main');
        this.relayout();
      },
    };
  }

  private relayout(): void {
    this.layoutCache = null;
    this.invalidate('all');
  }

  private inSubPane(layer: Layer | null): boolean {
    return (layer?.pane ?? 'main') !== 'main';
  }

  on<K extends ChartEventName>(event: K, cb: (payload: ChartEventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as Listener<ChartEventName>);
    return () => {
      set.delete(cb as Listener<ChartEventName>);
    };
  }

  private emit<K extends ChartEventName>(event: K, payload: ChartEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[chart] ${event} listener failed`, err);
      }
    }
  }

  setData(seriesId: string, bars: readonly BarInput[] | SeriesStore, options: SetDataOptions = {}): void {
    const fill = (s: SeriesStore) => (bars instanceof SeriesStore ? s.copyFrom(bars) : s.setData(bars));
    if (seriesId !== PRIMARY) {
      let s = this.extraSeries.get(seriesId);
      if (!s) {
        s = new SeriesStore(bars.length);
        this.extraSeries.set(seriesId, s);
      }
      fill(s);
      this.invalidate('all');
      return;
    }
    if (!options.keepView && this.store.length > 0) this.asked = null;
    const keep = options.keepView && this.viewInitialised && this.store.length > 0 ? this.viewAnchor() : null;
    const change = fill(this.store);
    this.applyChange(change);
    if (this.placeAsked()) return this.viewPlaced();
    if (keep && this.store.length > 0) this.restoreAnchor(keep);
    else this.resetView();
    this.invalidate('all');
    this.emit('viewport', this.getViewport());
    this.viewMoved();
  }

  prepend(seriesId: string, bars: readonly BarInput[]): number {
    if (seriesId !== PRIMARY) {
      const s = this.extraSeries.get(seriesId);
      if (!s) {
        this.setData(seriesId, bars);
        return this.extraSeries.get(seriesId)?.length ?? 0;
      }
      const added = s.prepend(bars);
      if (added > 0) this.invalidate('all');
      return added;
    }
    if (this.store.length === 0) {
      this.setData(seriesId, bars);
      return this.store.length;
    }
    const keep = this.viewInitialised ? this.viewAnchor() : null;
    const added = this.store.prepend(bars);
    if (added === 0) return 0;
    this.applyChange({ kind: 'set', from: 0 });
    if (this.placeAsked()) {
      this.viewPlaced();
      return added;
    }
    if (keep) this.restoreAnchor(keep);
    else this.resetView();
    this.invalidate('all');
    this.emit('viewport', this.getViewport());
    return added;
  }

  update(seriesId: string, bar: BarInput): void {
    if (seriesId !== PRIMARY) {
      this.extraSeries.get(seriesId)?.upsert(bar);
      this.invalidateData('all');
      return;
    }
    const lastSlotBefore = this.session.lastSlot;
    const change = this.store.upsert(bar);
    if (!change) return;
    this.applyChange(change);
    if (change.kind === 'append') {
      if (!this.viewInitialised) this.placeView();
      else if (this.following) this.time.rightEdgeSlot += this.session.lastSlot - lastSlotBefore;
    }
    this.invalidateData('main');
    this.invalidateData('overlay');
  }

  private viewAnchor(): { following: boolean; time: number; offset: number; spacing: number } {
    const { to } = this.visibleIndexRange();
    const i = Math.max(0, Math.min(to, this.store.length - 1));
    return {
      following: this.following,
      time: this.store.time[i]!,
      offset: this.time.rightEdgeSlot - this.session.slot[i]!,
      spacing: this.time.barSpacing,
    };
  }

  private restoreAnchor(a: { following: boolean; time: number; offset: number; spacing: number }): void {
    this.time.setWidth(this.plotWidth());
    this.updateSpacingLimits();
    this.time.barSpacing = clamp(a.spacing, this.time.minSpacing, this.time.maxSpacing);
    if (a.following) {
      this.time.rightEdgeSlot = this.session.lastSlot + this.rightPad;
    } else {
      const i = Math.max(0, this.store.indexAtOrBefore(a.time));
      this.time.rightEdgeSlot = this.session.slot[i]! + a.offset;
    }
    this.following = a.following;
    this.viewInitialised = true;
  }

  getSeries(seriesId: string = PRIMARY): SeriesStore | null {
    return seriesId === PRIMARY ? this.store : (this.extraSeries.get(seriesId) ?? null);
  }

  private applyChange(change: DataChange): void {
    this.session.apply(this.store, change);
    for (const layer of this.registry.all()) layer.onData?.(change, this.store, this.session);
  }

  addLayer(layer: Layer): LayerInfo {
    const info = this.registry.add(layer);
    layer.attach?.(this.hostFor(layer));
    if (this.store.length > 0) layer.onData?.({ kind: 'set', from: 0 }, this.store, this.session);
    if (this.inSubPane(layer)) this.relayout();
    for (const s of this.surfacesOf(layer)) this.invalidate(s);
    this.emit('layers', this.registry.list());
    return info;
  }

  removeLayer(id: string): boolean {
    const layer = this.registry.remove(id);
    if (!layer) return false;
    layer.detach?.();
    if (this.inSubPane(layer)) this.relayout();
    for (const s of this.surfacesOf(layer)) this.invalidate(s);
    this.emit('layers', this.registry.list());
    return true;
  }

  setLayerVisible(id: string, visible: boolean): void {
    if (!this.registry.setVisible(id, visible)) return;
    const layer = this.registry.get(id);
    if (this.inSubPane(layer)) this.relayout();
    if (layer) for (const s of this.surfacesOf(layer)) this.invalidate(s);
    this.emit('layers', this.registry.list());
  }

  setLayerZ(id: string, z: number): void {
    if (!this.registry.setZ(id, z)) return;
    const s = this.registry.surfaceOf(id);
    if (s) this.invalidate(s);
    this.emit('layers', this.registry.list());
  }

  getLayer(id: string): Layer | null;
  getLayer<T extends Layer>(id: string, kind: LayerClass<T>): T | null;
  getLayer(id: string, kind?: LayerClass<Layer>): Layer | null {
    const layer = this.registry.get(id);
    return !kind || layer instanceof kind ? layer : null;
  }

  layers(): LayerInfo[] {
    return this.registry.list();
  }

  setOptions(options: Partial<ChartOptions>): void {
    if (options.theme) {
      this.theme = mergeTheme(TESSERA_THEME, options.theme);
      this.measurer.clear();
      this.host.setBackground?.(this.theme.background);
    }
    if (options.priceFormat) this.format = new PriceFormatter(options.priceFormat);
    let sessionsChanged = false;
    if (options.sessions && !sameSessions(options.sessions, this.sessionOptions)) {
      this.sessionOptions = options.sessions;
      sessionsChanged = true;
    }
    if (options.timeframeMs !== undefined && options.timeframeMs !== this.timeframeMs) {
      this.timeframeMs = options.timeframeMs;
      sessionsChanged = true;
    }
    if (sessionsChanged) {
      const anchor = this.viewInitialised && this.store.length > 0 ? this.viewAnchor() : null;
      this.session = new SessionModel(this.sessionOptions, this.timeframeMs);
      this.applyChange({ kind: 'set', from: 0 });
      if (this.placeAsked()) this.following = this.isFollowing();
      else if (anchor) this.restoreAnchor(anchor);
      else this.resetView();
      this.emit('viewport', this.getViewport());
    }
    if (options.volumePane !== undefined) {
      this.volumeFraction = options.volumePane;
      this.layoutCache = null;
    }
    if (options.lastPrice !== undefined) this.lastPrice.stale = options.lastPrice === 'stale';
    if (options.countdown !== undefined) this.lastPrice.countdown = options.countdown;
    if (options.rightPadBars !== undefined) this.rightPad = options.rightPadBars;
    if (options.initialBars !== undefined) this.initialBars = options.initialBars;
    if (options.clearLeft !== undefined) this.clearLeft = Math.max(0, options.clearLeft);
    if (options.legend !== undefined) {
      if (options.legend) {
        this.legend.title = options.legend.title;
        this.legend.subtitle = options.legend.subtitle ?? null;
        this.legend.hoverOnly = options.legend.hover ?? false;
      }
      this.registry.setVisible('legend', Boolean(options.legend));
    }
    this.invalidate('all');
  }

  get priceFormatter(): PriceFormatter {
    return this.format;
  }

  get currentTheme(): ChartTheme {
    return this.theme;
  }

  get gpuState(): GpuState {
    return this.gpu.state;
  }

  private contentOf(rect: Rect): Rect {
    const cut = Math.min(this.cut, rect.w);
    return cut > 0 ? { x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h } : rect;
  }

  private plotWidth(): number {
    return Math.max(1, this.width - this.axisWidth);
  }

  private updateSpacingLimits(): void {
    const slots = this.session.length > 0 ? this.session.lastSlot + 1 : 1;
    this.time.minSpacing = Math.min(1, this.openWidth() / Math.max(10, slots * 1.1 + this.rightPad));
    this.time.maxSpacing = this.maxSpacing();
    if (this.time.barSpacing > this.time.maxSpacing) this.time.barSpacing = this.time.maxSpacing;
  }

  private maxSpacing(): number {
    let max = DEFAULT_MAX_SPACING;
    for (const layer of this.registry.all()) {
      if (!layer.viewHints || !this.registry.isVisible(layer.id)) continue;
      const hint = layer.viewHints().maxBarSpacing;
      if (hint !== undefined && Number.isFinite(hint) && hint > max) max = hint;
    }
    return max;
  }

  private resetView(): void {
    this.time.setWidth(this.plotWidth());
    this.updateSpacingLimits();
    const n = this.store.length;
    if (n === 0 || this.width <= 1) {
      this.viewInitialised = false;
      this.price.hasRange = false;
      for (const scale of this.paneScales.values()) scale.hasRange = false;
      return;
    }
    const lastSlot = this.session.lastSlot;
    const firstSlot = this.session.slot[Math.max(0, n - this.initialBars)]!;
    const slots = lastSlot - firstSlot + 1 + this.rightPad;
    this.time.barSpacing = clamp(this.plotWidth() / slots, this.time.minSpacing, this.time.maxSpacing);
    this.time.rightEdgeSlot = lastSlot + this.rightPad;
    this.price.mode = 'auto';
    this.following = true;
    this.viewInitialised = true;
    this.fitPending = true;
  }

  setViewport(update: ViewportUpdate): void {
    this.time.setWidth(this.plotWidth());
    this.updateSpacingLimits();
    const ask = askOf(update);
    if (ask) this.asked = ask;
    else if (update.barSpacing !== undefined || update.rightEdgeSlot !== undefined) this.asked = null;
    if (ask && !this.placeAsked()) this.viewInitialised = false;
    if (update.barSpacing !== undefined)
      this.time.barSpacing = clamp(update.barSpacing, this.time.minSpacing, this.time.maxSpacing);
    if (update.rightEdgeSlot !== undefined) this.time.rightEdgeSlot = update.rightEdgeSlot;
    if (update.price === 'auto') this.price.mode = 'auto';
    else if (update.price) this.price.setRange(update.price.min, update.price.max);
    this.afterViewChange();
  }

  private placeView(): void {
    if (!this.placeAsked()) this.resetView();
  }

  private placeAsked(): boolean {
    const ask = this.asked;
    const n = this.store.length;
    if (!ask || n === 0 || this.width <= 1) return false;
    this.time.setWidth(this.plotWidth());
    this.updateSpacingLimits();
    const lastSlot = this.session.lastSlot;
    const room = this.openWidth();
    this.askedRoom = room;
    const fit = (first: number, last: number, slots: number, right: number) => {
      this.time.barSpacing = clamp(room / (last - first + slots), this.time.minSpacing, this.time.maxSpacing);
      this.time.rightEdgeSlot = last + right;
    };
    if ('fitAll' in ask) fit(0, lastSlot, 1 + this.rightPad, this.rightPad);
    else if ('lastBars' in ask)
      fit(this.session.slot[Math.max(0, n - ask.lastBars)]!, lastSlot, 1 + this.rightPad, this.rightPad);
    else {
      const { first, last } = this.rangeIndices(ask.range.from, ask.range.to);
      fit(this.session.slot[first]!, this.session.slot[last]!, 1, 0.5);
    }
    this.viewInitialised = true;
    this.fitPending = false;
    return true;
  }

  private openWidth(): number {
    return Math.max(1, this.plotWidth() - this.cut);
  }

  private rangeIndices(from: number, to: number): { first: number; last: number } {
    const n = this.store.length;
    const at = this.store.indexAtOrBefore(from);
    const first = at < 0 ? 0 : this.barEnd(at) > from ? at : Math.min(n - 1, at + 1);
    return { first, last: Math.max(first, this.store.indexAtOrBefore(to)) };
  }

  private barEnd(i: number): number {
    const next = i + 1 < this.store.length ? this.store.time[i + 1]! : Infinity;
    return this.timeframeMs > 0 ? Math.min(next, this.store.time[i]! + this.timeframeMs) : next;
  }

  private viewPlaced(): void {
    this.following = this.isFollowing();
    this.invalidate('all');
    this.emit('viewport', this.getViewport());
    this.viewMoved();
  }

  private isFollowing(): boolean {
    return this.time.rightEdgeSlot >= this.session.lastSlot + this.rightPad - 0.5;
  }

  private userMoved(): void {
    this.asked = null;
  }

  private afterViewChange(): void {
    this.fitPending = false;
    this.time.clampTo(0, this.session.lastSlot, 2);
    this.following = this.isFollowing();
    this.invalidate('main');
    this.invalidate('overlay');
    if (this.registry.drawList('underlay').length > 0) this.invalidate('underlay');
    if (this.registry.drawList('gpu').length > 0) this.invalidate('gpu');
    this.emit('viewport', this.getViewport());
    this.viewMoved();
  }

  private viewMoved(): void {
    if (this.destroyed) return;
    if (this.settleTimer !== null) this.timers.clear(this.settleTimer);
    this.settleTimer = this.timers.set(() => {
      this.settleTimer = null;
      if (this.drag && this.drag.kind !== 'layer') {
        this.viewMoved();
        return;
      }
      this.settle();
    }, SETTLE_MS);
  }

  private settle(): void {
    if (this.suspended) {
      this.settleOwed = true;
      return;
    }
    for (const layer of this.registry.all()) {
      if (!layer.onViewSettled) continue;
      try {
        layer.onViewSettled();
      } catch (err) {
        console.error(`[chart] layer ${layer.id} failed to settle`, err);
      }
      if (this.registry.isVisible(layer.id)) this.invalidate(layer.surface);
    }
    this.emit('settled', this.getViewport());
  }

  get interacting(): boolean {
    return this.settleTimer !== null || (this.drag !== null && this.drag.kind !== 'layer');
  }

  getViewport(): ViewportState {
    const { from, to } = this.visibleIndexRange();
    const empty = to < from;
    return {
      barSpacing: this.time.barSpacing,
      rightEdgeSlot: this.time.rightEdgeSlot,
      from: empty ? -1 : from,
      to: empty ? -1 : to,
      fromTime: empty ? null : this.store.time[from]!,
      toTime: empty ? null : this.store.time[to]!,
      priceMin: this.price.min,
      priceMax: this.price.max,
      priceMode: this.price.mode,
      following: this.following,
      asked: this.asked,
      shown: empty ? null : this.shownIndexRange(),
    };
  }

  private shownIndexRange(): { from: number; to: number } | null {
    const left = this.cut > 0 ? this.time.slotOfX(this.cut) : this.time.leftEdgeSlot;
    const from = this.session.firstIndexFrom(left + SHOWN_EPSILON);
    const to = Math.min(this.store.length - 1, this.session.lastIndexTo(this.time.rightEdgeSlot));
    return to >= from ? { from, to } : null;
  }

  private visibleIndexRange(): { from: number; to: number } {
    const n = this.store.length;
    if (n === 0) return { from: 0, to: -1 };
    this.time.setWidth(this.plotWidth());
    const firstShown = this.cut > 0 ? this.time.slotOfX(this.cut) - 1e-6 : this.time.leftEdgeSlot - 1;
    const from = clamp(this.session.firstIndexFrom(firstShown), 0, n - 1);
    const to = clamp(this.session.lastIndexTo(this.time.rightEdgeSlot + 1), -1, n - 1);
    return { from, to };
  }

  private wantedSubPanes(): SubPane[] {
    const panes = new Map<PaneId, SubPane>();
    for (const layer of this.registry.all()) {
      const id = layer.pane ?? 'main';
      if (id === 'main' || !this.registry.isVisible(layer.id)) continue;
      if (id === 'volume' && !(this.volumeFraction > 0)) continue;
      let pane = panes.get(id);
      if (!pane) {
        const own = id === 'volume' ? this.volumeFraction : (layer.paneHeight ?? DEFAULT_PANE_SHARE);
        pane = { id, share: this.draggedShares.get(id) ?? own, layers: [] };
        panes.set(id, pane);
      }
      pane.layers.push(layer);
    }
    const order = (p: SubPane) => Math.min(...p.layers.map((l) => l.paneOrder ?? Infinity));
    return [...panes.values()].sort((a, b) => {
      const oa = order(a);
      const ob = order(b);
      return oa === ob ? 0 : oa < ob ? -1 : 1;
    });
  }

  private computeLayout(): ChartLayout {
    const w = this.width;
    const h = this.height;
    const axisW = this.axisWidth;
    const plotW = Math.max(1, w - axisW);
    const plotH = Math.max(1, h - TIME_AXIS_H);
    const mainMin = Math.max(80, plotH * MAIN_MIN_SHARE);
    let panes = this.wantedSubPanes();
    while (panes.length > 0 && plotH - panes.length * PANE_MIN_H < mainMin) panes = panes.slice(0, -1);
    const room = plotH - mainMin;
    let heights = panes.map((p) => Math.max(PANE_MIN_H, Math.round(p.share * plotH)));
    const total = heights.reduce((a, b) => a + b, 0);
    if (total > room) {
      const flexible = total - PANE_MIN_H * panes.length;
      const k = flexible > 0 ? Math.max(0, room - PANE_MIN_H * panes.length) / flexible : 0;
      heights = heights.map((x) => Math.floor(PANE_MIN_H + (x - PANE_MIN_H) * k));
    }
    const used = heights.reduce((a, b) => a + b, 0);
    const main: Rect = { x: 0, y: 0, w: plotW, h: plotH - used };
    let y = main.h;
    const rects = panes.map((p, k) => {
      const rect: Rect = { x: 0, y, w: plotW, h: heights[k]! };
      y += heights[k]!;
      return { id: p.id, rect };
    });
    this.subPanes = panes;
    for (const id of this.paneScales.keys()) if (!panes.some((p) => p.id === id)) this.paneScales.delete(id);
    for (const id of this.draggedShares.keys()) {
      if (!this.registry.all().some((l) => (l.pane ?? 'main') === id)) this.draggedShares.delete(id);
    }
    return {
      width: w,
      height: h,
      main,
      volume: rects.find((r) => r.id === 'volume')?.rect ?? null,
      panes: rects,
      priceAxis: { x: plotW, y: 0, w: axisW, h: plotH },
      timeAxis: { x: 0, y: plotH, w: plotW, h: TIME_AXIS_H },
    };
  }

  private paneScale(id: PaneId): PriceScale {
    let s = this.paneScales.get(id);
    if (!s) {
      s = new PriceScale();
      this.paneScales.set(id, s);
    }
    return s;
  }

  private fitPanes(layout: ChartLayout, time: TimeView): Map<PaneId, PriceView> {
    const views = new Map<PaneId, PriceView>();
    for (const { id, rect } of layout.panes) {
      if (id === 'volume') continue;
      const scale = this.paneScale(id);
      scale.setPane(rect.y, rect.h);
      const layers = this.subPanes.find((p) => p.id === id)?.layers ?? [];
      let lo = Infinity;
      let hi = -Infinity;
      let margins: { top: number; bottom: number } | undefined;
      let reserve = 0;
      if (time.to >= time.from) {
        for (const layer of layers) {
          const r = layer.autoscaleRange?.(time.from, time.to);
          if (!r) continue;
          lo = Math.min(lo, r[0]);
          hi = Math.max(hi, r[1]);
          margins ??= layer.autoscaleMargins;
          reserve = Math.max(reserve, layer.autoscaleReserve?.(time.barSpacing, rect.h) ?? 0);
        }
      }
      const legendPad = Math.min(PANE_LEGEND_MAX_PAD, PANE_LEGEND_INSET / Math.max(1, rect.h));
      scale.padTop = Math.max(margins?.top ?? 0.1, legendPad);
      scale.padBottom = Math.min(0.6, (margins?.bottom ?? 0.1) + reserve / Math.max(1, rect.h));
      if (hi >= lo) scale.autoFit(lo, hi, Math.max(1e-9, Math.abs(hi) * 1e-6));
      views.set(id, {
        get min() {
          return scale.min;
        },
        get max() {
          return scale.max;
        },
        yOf: (v: number) => scale.yOf(v),
        priceOf: (y: number) => scale.priceOf(y),
      });
    }
    return views;
  }

  private formatPaneValue(pane: PaneId, value: number): string {
    if (pane === 'main') return this.format.grouped(value);
    if (pane === 'volume') return formatVolumeShort(value);
    const layer = this.subPanes.find((p) => p.id === pane)?.layers.find((l) => l.formatValue !== undefined);
    return layer?.formatValue ? layer.formatValue(value, this.format) : this.format.grouped(value);
  }

  private layout(): ChartLayout {
    this.layoutCache ??= this.computeLayout();
    return this.layoutCache;
  }

  private makeTimeView(): TimeView {
    const { from, to } = this.visibleIndexRange();
    const t = this.time;
    const slots = this.session.slot;
    return {
      from,
      to,
      barSpacing: t.barSpacing,
      xOfIndex: (i: number) => t.xOfSlot(slots[i] ?? i),
      indexOfX: (x: number) => this.session.indexOfSlot(t.slotOfX(x)),
      xOfTime: (ms: number) => this.xOfTime(ms),
    };
  }

  private xOfTime(ms: number): number {
    const i = this.store.indexAtOrBefore(ms);
    if (i < 0) return Number.NaN;
    const frac = clamp((ms - this.store.time[i]!) / Math.max(1, this.timeframeMs), 0, 1);
    return this.time.xOfSlot(this.session.slot[i]!) + (frac - 0.5) * this.time.barSpacing;
  }

  private fitPrice(time: TimeView): void {
    if (this.price.mode !== 'auto' || time.to < time.from) return;
    const r = this.store.range(time.from, time.to);
    if (!r) return;
    let [lo, hi] = r;
    for (const layer of this.registry.drawList('overlay').concat(this.registry.drawList('main'))) {
      if (this.inSubPane(layer)) continue;
      const extra = layer.autoscaleRange?.(time.from, time.to);
      if (extra) {
        lo = Math.min(lo, extra[0]);
        hi = Math.max(hi, extra[1]);
      }
    }
    this.price.autoFit(lo, hi, this.format.minMove * 10);
  }

  private requiredAxisWidth(ctx: Ctx2D, ticks: readonly number[], step: number): number {
    const f = font(this.theme.priceFontSize, this.theme.fontFig);
    let w = 0;
    const consider = (s: string) => {
      w = Math.max(w, this.measurer.measure(ctx, f, s));
    };
    for (const p of ticks) consider(this.format.axis(p, step));
    consider(this.format.grouped(this.price.max));
    consider(this.format.grouped(this.price.min));
    if (this.store.length) consider(this.format.grouped(this.store.close[this.store.length - 1]!));
    return Math.max(MIN_AXIS_W, Math.ceil(w + 16));
  }

  private prepare(ctx: Ctx2D): PreparedFrame {
    let prepared: PreparedFrame | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const layout = this.layout();
      this.time.setWidth(layout.main.w);
      this.updateSpacingLimits();
      if (this.store.length > 0 && (!this.viewInitialised || this.fitPending)) this.placeView();
      else if (pass > 0 || (this.asked && this.askedRoom !== this.openWidth())) this.placeAsked();
      if (this.store.length > 0) this.time.clampTo(0, this.session.lastSlot, 2);
      const time = this.makeTimeView();
      this.price.setPane(layout.main.y, layout.main.h);
      const inset = !this.registry.isVisible('legend') || this.legend.hoverOnly ? 0 : this.legend.height();
      this.price.padTop = Math.max(0.08, inset / Math.max(1, layout.main.h));
      this.fitPrice(time);
      const step = this.price.tickStep(
        Math.max(MIN_PRICE_TICK_GAP_PX, this.theme.priceFontSize * PRICE_TICK_GAP_EM),
        this.format.minMove,
      );
      const ticks = this.price.ticks(step, this.format.precision);
      const vmax = time.to >= time.from ? this.store.maxVolume(time.from, time.to) : 0;
      const vol = layout.volume;
      const volume: PriceView = {
        min: 0,
        max: vmax,
        yOf: (v: number) => (vol ? vol.y + vol.h - (vmax > 0 ? (v / vmax) * (vol.h - 4) : 0) : 0),
        priceOf: (y: number) => (vol && vmax > 0 ? ((vol.y + vol.h - y) / (vol.h - 4)) * vmax : 0),
      };
      const price = this.price;
      const main: PriceView = {
        get min() {
          return price.min;
        },
        get max() {
          return price.max;
        },
        yOf: (p: number) => price.yOf(p),
        priceOf: (y: number) => price.priceOf(y),
      };
      prepared = {
        layout,
        time,
        columns: null,
        main,
        volume,
        panes: this.fitPanes(layout, time),
        ticks,
        step,
        legendInset: inset,
      };
      const need = this.requiredAxisWidth(ctx, ticks, step);
      const grow = need > this.axisWidth;
      const shrink = need < this.axisWidth - 8;
      if (!grow && !shrink) break;
      this.axisWidth = need;
      this.layoutCache = null;
    }
    if (!prepared) throw new Error('unreachable');
    this.fitPending = false;
    prepared.columns = this.pixelColumns.measure(prepared.time, this.dpr);
    return prepared;
  }

  setSuspended(on: boolean): void {
    if (this.destroyed || on === this.suspended) return;
    this.suspended = on;
    if (on) {
      if (this.frameHandle !== null) this.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
      if (this.dataTimer !== null) this.timers.clear(this.dataTimer);
      this.dataTimer = null;
      return;
    }
    this.pendingData.clear();
    this.invalidate('all');
    if (this.settleOwed && this.settleTimer === null) {
      this.settleOwed = false;
      this.settle();
    }
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  invalidate(surface: SurfaceKind | 'all'): void {
    if (this.destroyed) return;
    if (surface === 'all') for (const s of SURFACES) this.dirty.add(s);
    else this.dirty.add(surface);
    if (this.suspended) return;
    this.frameHandle ??= this.scheduler.request(() => {
      this.frameHandle = null;
      this.renderFrame();
    });
  }

  invalidateData(surface: SurfaceKind | 'all'): void {
    if (this.destroyed) return;
    if (this.suspended) {
      for (const s of surface === 'all' ? SURFACES : [surface]) this.dirty.add(s);
      return;
    }
    const now = this.timers.now();
    let wait = Infinity;
    for (const s of surface === 'all' ? SURFACES : [surface]) {
      if (this.dirty.has(s)) continue;
      const due = this.dataDue(s);
      if (due <= now) {
        this.pendingData.delete(s);
        this.invalidate(s);
      } else {
        this.pendingData.add(s);
        wait = Math.min(wait, due - now);
      }
    }
    if (wait < Infinity) this.armDataTimer(wait);
  }

  private dataDue(s: SurfaceKind): number {
    const at = this.drawnAt.get(s);
    return at === undefined ? -Infinity : at + (s === 'gpu' ? GPU_DATA_FRAME_MS : DATA_FRAME_MS);
  }

  private armDataTimer(wait: number): void {
    if (this.dataTimer !== null) return;
    this.dataTimer = this.timers.set(
      () => {
        this.dataTimer = null;
        this.flushData(false);
      },
      Math.max(0, wait),
    );
  }

  private flushData(all: boolean): void {
    if (this.pendingData.size === 0) return;
    const now = this.timers.now();
    let wait = Infinity;
    for (const s of [...this.pendingData]) {
      const due = this.dataDue(s);
      if (all || due <= now) {
        this.pendingData.delete(s);
        if (all) this.dirty.add(s);
        else this.invalidate(s);
      } else wait = Math.min(wait, due - now);
    }
    if (wait < Infinity) this.armDataTimer(wait);
  }

  render(force = false): void {
    if (force) for (const s of SURFACES) this.dirty.add(s);
    if (this.suspended) return;
    this.flushData(true);
    if (this.frameHandle !== null) {
      this.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
    this.renderFrame();
  }

  private context(surface: Surface2D): Ctx2D {
    const ctx = this.host.canvases[surface].getContext('2d') as Ctx2D | null;
    if (!ctx) throw new Error(`no 2d context for ${surface}`);
    return ctx;
  }

  private renderFrame(): void {
    if (this.destroyed || this.dirty.size === 0) return;
    const t0 = performanceNow();
    const mainCtx = this.context('main');
    const widthBefore = this.axisWidth;
    let frame = this.prepare(mainCtx);
    if (this.axisWidth !== widthBefore) for (const s of SURFACES) this.dirty.add(s);
    const now = this.nowFn();
    const interacting = this.interacting;
    const contentDirty = this.dirty.has('main') || this.dirty.has('underlay');
    const cutBefore = this.cut;
    if (contentDirty && this.layOutFrame(frame, mainCtx, now, interacting)) {
      for (const s of SURFACES) this.dirty.add(s);
      if (this.cut !== cutBefore) frame = this.prepare(mainCtx);
    }
    this.grid.ticks = frame.ticks;
    if (this.dirty.has('main')) this.grid.timeTicks = this.placeTimeLabels(frame.layout, frame.time);
    const gpuLayers = this.registry.drawList('gpu');
    const gpuSurface = this.gpu.surfaceFor(gpuLayers.length > 0);
    const gpuOn2d = gpuLayers.length > 0 && gpuSurface === null;
    if (gpuOn2d && this.dirty.has('gpu')) this.dirty.add('underlay');
    if (gpuOn2d !== this.gpuWasOn2d) this.dirty.add('underlay');
    this.gpuWasOn2d = gpuOn2d;
    const surfaces = SURFACES.filter((s) => this.dirty.has(s));
    this.dirty.clear();
    const drawnAt = this.timers.now();
    for (const s of surfaces) {
      this.drawnAt.set(s, drawnAt);
      this.pendingData.delete(s);
    }
    const timings: Partial<Record<SurfaceKind, number>> = {};
    let bandsMoved = false;
    let underlayTagsMoved = false;
    for (const surface of surfaces) {
      const ts = performanceNow();
      if (surface === 'gpu') {
        if (gpuSurface) this.renderGpu(gpuSurface, gpuLayers, frame, now, interacting);
        timings.gpu = performanceNow() - ts;
        continue;
      }
      const drawList =
        surface === 'underlay' && gpuOn2d
          ? [...gpuLayers, ...this.registry.drawList(surface)]
          : this.registry.drawList(surface);
      if (drawList.length === 0 && surface !== 'main' && this.clearSurfaces.has(surface)) {
        timings[surface] = 0;
        continue;
      }
      const ctx = surface === 'main' ? mainCtx : this.context(surface);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      const tags: AxisTag[] = [];
      const base = this.frameBase(ctx, frame, now, interacting, tags);
      const rcOf = (layer: Layer) => this.contextFor(layer, base, frame);
      const claimers = SURFACES.flatMap((k) =>
        k === 'gpu' ? [] : k === surface ? drawList : this.registry.drawList(k),
      );
      for (const layer of claimers) {
        const rc = layer.labelClaims ? rcOf(layer) : null;
        if (!rc) continue;
        try {
          base.labelClaims.push(...layer.labelClaims!(rc));
        } catch (err) {
          console.error(`[chart] layer ${layer.id} failed to lay out its labels`, err);
        }
      }
      const replaced = surface === 'main' && this.replaced;
      for (const layer of drawList) {
        if (replaced && layer instanceof CandlesLayer) continue;
        const rc = rcOf(layer);
        if (!rc) continue;
        ctx.save();
        try {
          layer.draw(rc);
        } catch (err) {
          console.error(`[chart] layer ${layer.id} failed to draw`, err);
        }
        ctx.restore();
      }
      if (surface === 'underlay') {
        const key = tags
          .map(
            (t) =>
              `${String(t.price)}|${t.text}|${t.sub ?? ''}|${t.style}|${t.color}|${String(t.priority)}|${t.pane ?? ''}`,
          )
          .join(';');
        if (key !== this.underlayTagsKey) {
          this.underlayTagsKey = key;
          this.underlayTags = [...tags];
          if (!surfaces.includes('main')) underlayTagsMoved = true;
        }
        tags.length = 0;
      }
      if (surface === 'main') tags.push(...this.underlayTags);
      const bands = tags.length ? this.drawTags(ctx, frame, tags) : [];
      if (surface === 'main') this.drawAxes(ctx, frame, bands);
      if (surface === 'overlay' && this.setTagBands(bands)) bandsMoved = true;
      if (drawList.length === 0 && tags.length === 0) this.clearSurfaces.add(surface);
      else this.clearSurfaces.delete(surface);
      timings[surface] = performanceNow() - ts;
    }
    this.emit('frame', { durationMs: performanceNow() - t0, surfaces, timings });
    if (bandsMoved || underlayTagsMoved) {
      this.dirty.add('main');
      this.renderFrame();
    }
  }

  private frameBase(ctx: Ctx2D, frame: PreparedFrame, now: number, interacting: boolean, tags: AxisTag[]) {
    return {
      ctx,
      dpr: this.dpr,
      theme: this.theme,
      layout: frame.layout,
      store: this.store,
      session: this.session,
      time: frame.time,
      mainPrice: frame.main,
      format: this.format,
      timeframeMs: this.timeframeMs,
      now,
      crosshair: this.crosshair,
      addAxisTag: (tag: AxisTag) => {
        tags.push(tag);
      },
      formatPaneValue: (pane: PaneId, value: number) => this.formatPaneValue(pane, value),
      labelClaims: [] as LabelClaim[],
      interacting,
      seriesReplaced: this.replaced,
      figures: this.figures,
      columns: frame.columns,
    };
  }

  private contextFor(
    layer: Layer,
    base: ReturnType<ChartEngine['frameBase']>,
    frame: PreparedFrame,
  ): RenderContext | null {
    const paneId: PaneId = layer.pane ?? 'main';
    const gutter = this.gutters.get(layer.id) ?? null;
    if (paneId === 'main') return { ...base, pane: this.contentOf(frame.layout.main), price: frame.main, gutter };
    const rect = frame.layout.panes.find((p) => p.id === paneId)?.rect;
    if (!rect) return null;
    const price = paneId === 'volume' ? frame.volume : frame.panes.get(paneId);
    return price ? { ...base, pane: this.contentOf(rect), price, gutter } : null;
  }

  private layOutFrame(frame: PreparedFrame, ctx: Ctx2D, now: number, interacting: boolean): boolean {
    const base = this.frameBase(ctx, frame, now, interacting, []);
    this.replaced = this.seriesReplaced((layer) => this.contextFor(layer, base, frame));
    const main = frame.layout.main;
    const top = Math.min(main.h, frame.legendInset);
    const gutters = new Map<string, Rect>();
    let cut = this.clearLeft;
    for (const surface of SURFACES) {
      if (surface === 'gpu') continue;
      for (const layer of this.registry.drawList(surface)) {
        if (!layer.gutter || (layer.pane ?? 'main') !== 'main') continue;
        const pane = { x: main.x + cut, y: main.y, w: Math.max(0, main.w - cut), h: main.h };
        let w = 0;
        try {
          w = layer.gutter({ ...base, seriesReplaced: this.replaced, pane, price: frame.main, gutter: null });
        } catch (err) {
          console.error(`[chart] layer ${layer.id} failed to size its gutter`, err);
        }
        if (!(w > 0)) continue;
        gutters.set(layer.id, { x: main.x + cut, y: main.y + top, w, h: main.h - top });
        cut += w;
      }
    }
    const key = `${String(this.replaced)}|${String(cut)}|${[...gutters].map(([id, r]) => `${id}:${String(r.x)},${String(r.y)},${String(r.w)},${String(r.h)}`).join(';')}`;
    this.gutters = gutters;
    this.cut = cut;
    this.figures = this.figureColumns({ ...base, seriesReplaced: this.replaced }, frame);
    const moved = key !== this.guttersKey;
    this.guttersKey = key;
    return moved;
  }

  private figureColumns(base: ReturnType<ChartEngine['frameBase']>, frame: PreparedFrame): FigureColumn[] {
    const out: FigureColumn[] = [];
    for (const surface of SURFACES) {
      if (surface === 'gpu') continue;
      for (const layer of this.registry.drawList(surface)) {
        if (!layer.figureColumns || (layer.pane ?? 'main') !== 'main') continue;
        const rc = this.contextFor(layer, base, frame);
        if (!rc) continue;
        try {
          out.push(...layer.figureColumns(rc));
        } catch (err) {
          console.error(`[chart] layer ${layer.id} failed to say where its figures are`, err);
        }
      }
    }
    return out;
  }

  private seriesReplaced(rcOf: (layer: Layer) => RenderContext | null): boolean {
    for (const surface of SURFACES) {
      for (const layer of this.registry.drawList(surface)) {
        if (!layer.replacesSeries || (layer.pane ?? 'main') !== 'main') continue;
        const rc = rcOf(layer);
        try {
          if (rc && layer.replacesSeries(rc)) return true;
        } catch (err) {
          console.error(`[chart] layer ${layer.id} failed to say whether it draws the series`, err);
        }
      }
    }
    return false;
  }

  private renderGpu(
    surface: WebGlSurface,
    layers: readonly Layer[],
    frame: PreparedFrame,
    now: number,
    interacting: boolean,
  ): void {
    surface.beginFrame(this.width * GPU_PIXEL_RATIO, this.height * GPU_PIXEL_RATIO, this.theme.background);
    for (const layer of layers) {
      if (!layer.drawGpu) continue;
      const paneId: PaneId = layer.pane ?? 'main';
      const rect = paneId === 'main' ? frame.layout.main : frame.layout.panes.find((p) => p.id === paneId)?.rect;
      const price = paneId === 'main' ? frame.main : paneId === 'volume' ? frame.volume : frame.panes.get(paneId);
      if (!rect || !price) continue;
      const rc: GpuRenderContext = {
        gpu: surface,
        dpr: GPU_PIXEL_RATIO,
        theme: this.theme,
        layout: frame.layout,
        pane: this.contentOf(rect),
        price,
        mainPrice: frame.main,
        store: this.store,
        session: this.session,
        time: frame.time,
        format: this.format,
        timeframeMs: this.timeframeMs,
        now,
        crosshair: this.crosshair,
        formatPaneValue: (pane: PaneId, value: number) => this.formatPaneValue(pane, value),
        interacting,
        seriesReplaced: this.replaced,
        gutter: this.gutters.get(layer.id) ?? null,
      };
      try {
        layer.drawGpu(rc);
      } catch (err) {
        console.error(`[chart] layer ${layer.id} failed to draw on the gpu`, err);
      }
    }
  }

  private drawAxes(ctx: Ctx2D, frame: PreparedFrame, ownTags: readonly { top: number; bottom: number }[]): void {
    const { layout, ticks, step, time } = frame;
    const th = this.theme;
    const dpr = this.dpr;
    ctx.save();
    ctx.strokeStyle = th.border;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    const ax = crisp(layout.priceAxis.x, dpr);
    ctx.moveTo(ax, 0);
    ctx.lineTo(ax, layout.priceAxis.h);
    const ty = crisp(layout.timeAxis.y, dpr);
    ctx.moveTo(0, ty);
    ctx.lineTo(layout.width, ty);
    for (const { rect } of layout.panes) {
      const py = crisp(rect.y, dpr);
      ctx.moveTo(0, py);
      ctx.lineTo(layout.width, py);
    }
    ctx.stroke();
    this.drawMissingPrints(ctx, frame);

    ctx.font = font(th.priceFontSize, th.fontFig);
    ctx.fillStyle = th.mutedText;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const half = th.priceFontSize / 2 + 1;
    const covered = (y: number) =>
      this.tagBands.some((b) => y + half > b.top && y - half < b.bottom) ||
      ownTags.some((b) => y + half > b.top && y - half < b.bottom);
    for (const p of ticks) {
      const y = this.price.yOf(p);
      if (y < layout.main.y + 8 || y > layout.main.y + layout.main.h - 8) continue;
      if (covered(y)) continue;
      ctx.fillText(this.format.axis(p, step), layout.priceAxis.x + 8, y + 0.5);
    }
    this.drawPaneTicks(ctx, frame, covered);

    this.drawTimeLabels(ctx, layout, time, this.grid.timeTicks);
    ctx.restore();
  }

  private drawMissingPrints(ctx: Ctx2D, frame: PreparedFrame): void {
    const { layout, time } = frame;
    const bars = { from: time.from, to: time.to, store: this.store, timeframeMs: this.timeframeMs };
    const gaps = SURFACES.flatMap((s) => this.registry.drawList(s)).flatMap((layer) => {
      if (!layer.missingPrints) return [];
      try {
        return layer.missingPrints(bars);
      } catch (err) {
        console.error(`[chart] layer ${layer.id} failed to say where prints are missing`, err);
        return [];
      }
    });
    this.gapRuns =
      gaps.length === 0 ? [] : drawMissingPrints(ctx, layout, time, this.theme, barsMissingPrints(bars, gaps));
  }

  private hoverGap(x: number, y: number, over: boolean): void {
    const run = over ? runAt(this.gapRuns, x) : null;
    if (run === this.gapHovered) return;
    this.gapHovered = run;
    const from = run ? this.store.time[run.from] : undefined;
    const last = run ? this.store.time[run.to] : undefined;
    this.emit(
      'gap',
      run && from !== undefined && last !== undefined ? { x, y, from, to: last + this.timeframeMs } : null,
    );
  }

  private drawPaneTicks(ctx: Ctx2D, frame: PreparedFrame, covered: (y: number) => boolean): void {
    const { layout } = frame;
    const half = this.theme.priceFontSize / 2 + 1;
    for (const { id, rect } of layout.panes) {
      const view = frame.panes.get(id);
      const scale = this.paneScales.get(id);
      if (!view || !scale?.hasRange || rect.h < 48) continue;
      const layers = this.subPanes.find((p) => p.id === id)?.layers ?? [];
      const marks = [...new Set(layers.flatMap((l) => l.axisMarks?.() ?? []))];
      const fixed = layers.some((l) => l.fixedRange === true);
      const step = scale.tickStep(Math.max(28, this.theme.priceFontSize * 2.4), 0);
      const placed: number[] = [];
      const label = (v: number, whole: boolean) => {
        const y = view.yOf(v);
        if (y < rect.y + 9 || y > rect.y + rect.h - 9) return;
        if (covered(y) || placed.some((p) => Math.abs(p - y) < half * 2)) return;
        placed.push(y);
        const r = Math.round(v);
        const text =
          whole && Math.abs(v) < 1000 ? (r < 0 ? `${MINUS}${String(-r)}` : String(r)) : this.formatPaneValue(id, v);
        ctx.fillText(text, layout.priceAxis.x + 8, y + 0.5);
      };
      for (const v of marks) label(v, Math.abs(v - Math.round(v)) < 1e-9);
      if (fixed && marks.length > 0) continue;
      const wholeStep = Math.abs(step - Math.round(step)) < 1e-9;
      for (const v of scale.ticks(step, 6)) label(v, wholeStep);
    }
  }

  private placeTimeLabels(layout: ChartLayout, time: TimeView): number[] {
    if (time.to < time.from) return [];
    const ses = this.session;
    const avgBarMs = this.timeframeMs;
    const barsPerLabel = LABEL_GAP_PX / Math.max(1e-6, time.barSpacing);
    let minWeight: number = Weight.Min1;
    while (minWeight < Weight.Year && WEIGHT_MS[minWeight]! < barsPerLabel * avgBarMs * 0.5) minWeight++;
    const cand: number[] = [];
    for (let i = time.from; i <= time.to; i++) if (ses.weight[i]! >= minWeight) cand.push(i);
    cand.sort((a, b) => ses.weight[b]! - ses.weight[a]! || a - b);
    const placed: number[] = [];
    const accepted: number[] = [];
    const insertAt = (x: number): number => {
      let lo = 0;
      let hi = placed.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (placed[mid]! < x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    for (const i of cand) {
      const x = time.xOfIndex(i);
      if (x < 0 || x > layout.main.w) continue;
      const k = insertAt(x);
      if (k > 0 && x - placed[k - 1]! < LABEL_GAP_PX) continue;
      if (k < placed.length && placed[k]! - x < LABEL_GAP_PX) continue;
      placed.splice(k, 0, x);
      accepted.push(i);
      if (accepted.length > 200) break;
    }
    return accepted;
  }

  private drawTimeLabels(ctx: Ctx2D, layout: ChartLayout, time: TimeView, accepted: readonly number[]): void {
    if (time.to < time.from) return;
    const th = this.theme;
    const ses = this.session;
    const y = layout.timeAxis.y + layout.timeAxis.h / 2 + 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const i of accepted) {
      const w = ses.weight[i]!;
      const label = timeLabel(ses.clock, this.store.time[i]!, w, ses.day[i]!, this.timeframeMs);
      ctx.font = font(th.fontSize, th.font);
      ctx.fillStyle = w >= Weight.Day ? th.dayText : th.mutedText;
      const x = clamp(time.xOfIndex(i), 20, layout.main.w - 20);
      ctx.fillText(label, x, y);
    }
  }

  private setTagBands(bands: { top: number; bottom: number }[]): boolean {
    const key = bands.map((b) => `${b.top.toFixed(1)}:${b.bottom.toFixed(1)}`).join(',');
    if (key === this.tagBandsKey) return false;
    this.tagBands = bands;
    this.tagBandsKey = key;
    return true;
  }

  private drawTags(ctx: Ctx2D, frame: PreparedFrame, tags: AxisTag[]): { top: number; bottom: number }[] {
    const { layout } = frame;
    const byPane = new Map<PaneId, AxisTag[]>();
    for (const t of tags) {
      const id = t.pane ?? 'main';
      byPane.set(id, [...(byPane.get(id) ?? []), t]);
    }
    const bands: { top: number; bottom: number }[] = [];
    for (const [id, group] of byPane) {
      const rect = id === 'main' ? layout.main : layout.panes.find((p) => p.id === id)?.rect;
      const view = id === 'main' ? frame.main : frame.panes.get(id);
      if (!rect || !view) continue;
      bands.push(...this.drawTagGroup(ctx, layout, rect, view, group));
    }
    return bands;
  }

  private drawTagGroup(
    ctx: Ctx2D,
    layout: ChartLayout,
    rect: Rect,
    view: PriceView,
    tags: AxisTag[],
  ): { top: number; bottom: number }[] {
    const th = this.theme;
    const lineH = th.priceFontSize + 6;
    const items = tags.map((t) => ({
      y: view.yOf(t.price),
      h: t.sub ? lineH * 2 - 2 : lineH,
      priority: t.priority,
    }));
    const inside = tags
      .map((t, k) => ({ t, it: items[k]! }))
      .filter(({ it }) => it.y >= rect.y - it.h / 2 && it.y <= rect.y + rect.h + it.h / 2);
    const ys = deOverlap(
      inside.map((v) => v.it),
      rect.y,
      rect.y + rect.h,
    );
    const order = [...inside.keys()].sort((a, b) => inside[a]!.t.priority - inside[b]!.t.priority);
    const f = font(th.priceFontSize, th.fontFig);
    for (const k of order) {
      const { t, it } = inside[k]!;
      drawAxisTag(
        ctx,
        t,
        layout.priceAxis.x + 1,
        ys[k]!,
        layout.priceAxis.w - 1,
        it.h,
        this.dpr,
        f,
        isLight(t.color) ? th.tagInk : th.tagInkLight,
        th.text,
        th.background,
      );
    }
    const fixed = inside.filter(({ t }) => !t.transient).map(({ it }) => it);
    const fixedYs = deOverlap(fixed, rect.y, rect.y + rect.h);
    return fixed.map((it, k) => ({ top: fixedYs[k]! - it.h / 2, bottom: fixedYs[k]! + it.h / 2 }));
  }

  resize(width: number, height: number, dpr: number = this.dpr): void {
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    const lastVisibleSlot = this.time.rightEdgeSlot;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.layoutCache = null;
    this.clearSurfaces.clear();
    this.host.resize(this.width, this.height, this.dpr);
    this.time.setWidth(this.plotWidth());
    this.time.rightEdgeSlot = lastVisibleSlot;
    if (this.placeAsked()) this.following = this.isFollowing();
    this.invalidate('all');
    this.viewMoved();
    this.render();
  }

  get size(): { width: number; height: number; dpr: number } {
    return { width: this.width, height: this.height, dpr: this.dpr };
  }

  coords(): ChartCoords {
    const layout = this.layout();
    this.time.setWidth(layout.main.w);
    this.price.setPane(layout.main.y, layout.main.h);
    const tv = this.makeTimeView();
    return {
      plot: { ...layout.main },
      volume: layout.volume ? { ...layout.volume } : null,
      panes: layout.panes.map((p) => ({ id: p.id, rect: { ...p.rect } })),
      priceAxis: { ...layout.priceAxis },
      timeAxis: { ...layout.timeAxis },
      barSpacing: this.time.barSpacing,
      from: tv.from,
      to: tv.to,
      xOfIndex: (i) => tv.xOfIndex(i),
      xOfTime: (t) => {
        const i = this.store.indexAtOrBefore(t);
        return i < 0 ? null : tv.xOfIndex(i);
      },
      indexOfX: (x) => (this.store.length ? tv.indexOfX(x) : -1),
      timeOfX: (x) => {
        if (!this.store.length) return null;
        return this.store.time[tv.indexOfX(x)]!;
      },
      yOfPrice: (p) => this.price.yOf(p),
      priceOfY: (y) => this.price.priceOf(y),
    };
  }

  private paneAt(x: number, y: number): string | null {
    const l = this.layout();
    if (x >= l.priceAxis.x && y < l.priceAxis.h) return y < l.main.y + l.main.h ? 'priceAxis' : 'paneAxis';
    if (y >= l.timeAxis.y && x < l.timeAxis.w) return 'timeAxis';
    for (const { id, rect } of l.panes) {
      if (y >= rect.y && y < rect.y + rect.h && x >= 0 && x < rect.w) return id;
    }
    if (x >= 0 && x < l.main.w && y >= 0 && y < l.main.h) return 'main';
    return null;
  }

  private separatorAt(x: number, y: number): { id: PaneId; above: PaneId } | null {
    const l = this.layout();
    if (x < 0 || x > l.width) return null;
    for (let k = 0; k < l.panes.length; k++) {
      const p = l.panes[k]!;
      if (Math.abs(y - p.rect.y) <= SEPARATOR_GRAB) return { id: p.id, above: k > 0 ? l.panes[k - 1]!.id : 'main' };
    }
    return null;
  }

  private shareOf(id: PaneId): number {
    const l = this.layout();
    const plotH = Math.max(1, l.timeAxis.y);
    if (id === 'main') return l.main.h / plotH;
    const rect = l.panes.find((p) => p.id === id)?.rect;
    return rect ? rect.h / plotH : 0;
  }

  private mainContext(): RenderContext {
    const layout = this.layout();
    this.time.setWidth(layout.main.w);
    this.price.setPane(layout.main.y, layout.main.h);
    const tv = this.makeTimeView();
    const mainView: PriceView = {
      min: this.price.min,
      max: this.price.max,
      yOf: (p) => this.price.yOf(p),
      priceOf: (yy) => this.price.priceOf(yy),
    };
    return {
      ctx: this.context('overlay'),
      dpr: this.dpr,
      theme: this.theme,
      layout,
      pane: this.contentOf(layout.main),
      store: this.store,
      session: this.session,
      time: tv,
      price: mainView,
      mainPrice: mainView,
      format: this.format,
      timeframeMs: this.timeframeMs,
      now: this.nowFn(),
      crosshair: this.crosshair,
      addAxisTag: () => undefined,
      formatPaneValue: (pane: PaneId, value: number) => this.formatPaneValue(pane, value),
      labelClaims: [],
      interacting: this.interacting,
      seriesReplaced: this.replaced,
      gutter: null,
      figures: this.figures,
      columns: null,
    };
  }

  hitTest(x: number, y: number): LayerHit[] {
    const rc = this.mainContext();
    const hits: LayerHit[] = [];
    for (const surface of ['overlay', 'main', 'underlay', 'gpu'] as const) {
      for (const layer of [...this.registry.drawList(surface)].reverse()) {
        if (!layer.hitTest) continue;
        const h = layer.hitTest(x, y, rc);
        if (h) hits.push({ layerId: layer.id, objectId: h.objectId, distance: h.distance });
      }
    }
    return hits.sort((a, b) => a.distance - b.distance);
  }

  private interactiveLayers(): Layer[] {
    return [...this.registry.drawList('overlay')].reverse().filter((l) => l.pointer !== undefined);
  }

  private offerPointer(type: LayerPointerEvent['type'], x: number, y: number, mods: PointerMods): Layer | null {
    const layers = this.interactiveLayers();
    if (layers.length === 0) return null;
    const rc = this.mainContext();
    const e: LayerPointerEvent = { type, x, y, shift: !!mods.shift, alt: !!mods.alt, cmdOrCtrl: !!mods.cmdOrCtrl };
    for (const layer of layers) {
      if (layer.pointer!(e, rc)) return layer;
    }
    return null;
  }

  cursorAt(x: number, y: number): string {
    if (this.drag?.kind === 'pan') return 'grabbing';
    if (this.drag?.kind === 'layer') return this.drag.layer.cursor?.(x, y, this.mainContext()) ?? 'grabbing';
    if (this.drag?.kind === 'pane' || this.separatorAt(x, y)) return 'row-resize';
    const pane = this.paneAt(x, y);
    if (pane === 'main') {
      const layers = this.interactiveLayers();
      if (layers.length) {
        const rc = this.mainContext();
        for (const layer of layers) {
          const c = layer.cursor?.(x, y, rc);
          if (c) return c;
        }
      }
    }
    if (pane === 'priceAxis') return 'ns-resize';
    if (pane === 'timeAxis') return 'ew-resize';
    if (pane === 'paneAxis') return 'default';
    if (pane === 'main' && this.hitTest(x, y).length) return 'pointer';
    return pane ? 'crosshair' : 'default';
  }

  pointerMove(x: number, y: number, mods: PointerMods = {}): void {
    const d = this.drag;
    if (d?.kind === 'layer') {
      d.layer.pointer!(
        { type: 'move', x, y, shift: !!mods.shift, alt: !!mods.alt, cmdOrCtrl: !!mods.cmdOrCtrl },
        this.mainContext(),
      );
    } else if (d) {
      if (d.kind === 'pan') {
        const dx = x - d.x;
        const dy = y - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
        if (d.moved) this.userMoved();
        this.time.rightEdgeSlot = d.right - dx / this.time.barSpacing;
        if (this.price.mode === 'manual' && d.pane === 'main') {
          const span = d.pmax - d.pmin;
          const dp = (dy / this.price.height) * span;
          this.price.min = d.pmin + dp;
          this.price.max = d.pmax + dp;
        }
      } else if (d.kind === 'price') {
        const factor = Math.exp((y - d.y) * 0.006);
        const mid = (d.pmin + d.pmax) / 2;
        this.price.mode = 'manual';
        this.price.min = mid - ((d.pmax - d.pmin) / 2) * factor;
        this.price.max = mid + ((d.pmax - d.pmin) / 2) * factor;
      } else if (d.kind === 'time') {
        const factor = Math.exp((x - d.x) * 0.01);
        this.userMoved();
        this.time.barSpacing = clamp(d.spacing * factor, this.time.minSpacing, this.time.maxSpacing);
        this.time.rightEdgeSlot = d.right;
      } else {
        this.dragSeparator(d, y);
        return;
      }
      this.crosshair = null;
      this.afterViewChange();
      return;
    }
    const pane = this.paneAt(x, y);
    if (!d) this.offerPointer(pane === 'main' ? 'hover' : 'leave', x, y, mods);
    this.hoverGap(x, y, pane === 'timeAxis');
    if (pane === null || pane === 'priceAxis' || pane === 'paneAxis' || pane === 'timeAxis') {
      if (this.crosshair) {
        this.crosshair = null;
        this.invalidate('overlay');
        this.emit('crosshair', null);
      }
      return;
    }
    const layout = this.layout();
    this.time.setWidth(layout.main.w);
    this.price.setPane(layout.main.y, layout.main.h);
    const index = this.store.length ? this.session.indexOfSlot(this.time.slotOfX(x)) : -1;
    const price = pane === 'main' ? this.price.priceOf(y) : Number.NaN;
    const value = pane === 'main' ? price : (this.paneScales.get(pane)?.priceOf(y) ?? Number.NaN);
    this.crosshair = { x, y, index, price, pane, value };
    this.invalidate('overlay');
    const bar: BarSnapshot | null = index >= 0 ? { index, ...this.store.bar(index) } : null;
    this.emit('crosshair', { x, y, index, time: bar ? bar.t : null, price, bar });
  }

  pointerLeave(): void {
    if (this.drag) return;
    this.offerPointer('leave', -1, -1, {});
    this.hoverGap(-1, -1, false);
    if (this.crosshair) {
      this.crosshair = null;
      this.invalidate('overlay');
      this.emit('crosshair', null);
    }
  }

  pointerDown(x: number, y: number, button = 0, mods: PointerMods = {}): void {
    if (button !== 0) return;
    const sep = this.separatorAt(x, y);
    if (!sep && this.paneAt(x, y) === 'main') {
      const layer = this.offerPointer('down', x, y, mods);
      if (layer) {
        this.drag = { kind: 'layer', layer };
        return;
      }
    }
    if (sep) {
      this.drag = {
        kind: 'pane',
        ...sep,
        y,
        share: this.shareOf(sep.id),
        aboveShare: this.shareOf(sep.above),
        moved: false,
      };
      if (this.crosshair) {
        this.crosshair = null;
        this.invalidate('overlay');
        this.emit('crosshair', null);
      }
      return;
    }
    const pane = this.paneAt(x, y);
    if (pane !== null && pane !== 'priceAxis' && pane !== 'paneAxis' && pane !== 'timeAxis') {
      this.drag = {
        kind: 'pan',
        x,
        y,
        right: this.time.rightEdgeSlot,
        pmin: this.price.min,
        pmax: this.price.max,
        moved: false,
        pane,
      };
    } else if (pane === 'priceAxis') {
      this.drag = { kind: 'price', y, pmin: this.price.min, pmax: this.price.max };
    } else if (pane === 'timeAxis') {
      this.drag = { kind: 'time', x, spacing: this.time.barSpacing, right: this.time.rightEdgeSlot };
    }
  }

  pointerUp(x: number, y: number, mods: PointerMods = {}): void {
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'layer') {
      d.layer.pointer!(
        { type: 'up', x, y, shift: !!mods.shift, alt: !!mods.alt, cmdOrCtrl: !!mods.cmdOrCtrl },
        this.mainContext(),
      );
      this.pointerMove(x, y, mods);
      return;
    }
    if (d?.kind === 'pane') {
      if (d.moved) {
        const traded = [d.id, d.above].filter((id) => id !== 'main');
        this.emit(
          'panes',
          traded.map((id) => ({ id, height: this.draggedShares.get(id) ?? this.shareOf(id) })),
        );
      }
      this.pointerMove(x, y);
      return;
    }
    if (d?.kind === 'pan' && !d.moved) {
      const layout = this.layout();
      this.time.setWidth(layout.main.w);
      this.price.setPane(layout.main.y, layout.main.h);
      const index = this.store.length ? this.session.indexOfSlot(this.time.slotOfX(x)) : -1;
      this.emit('click', { x, y, index, price: this.price.priceOf(y), hits: this.hitTest(x, y) });
    }
    this.pointerMove(x, y);
  }

  private dragSeparator(d: Extract<DragMode, { kind: 'pane' }>, y: number): void {
    const plotH = Math.max(1, this.layout().timeAxis.y);
    const min = PANE_MIN_H / plotH;
    const mainMin = Math.max(80 / plotH, MAIN_MIN_SHARE);
    const delta = (y - d.y) / plotH;
    const aboveMin = d.above === 'main' ? mainMin : min;
    const share = clamp(d.share - delta, min, d.share + d.aboveShare - aboveMin);
    if (share === d.share && !d.moved) return;
    d.moved = true;
    this.draggedShares.set(d.id, share);
    if (d.above !== 'main') this.draggedShares.set(d.above, d.aboveShare + d.share - share);
    this.relayout();
  }

  wheel(
    deltaX: number,
    deltaY: number,
    x: number,
    y: number,
    modifiers: { shift?: boolean; ctrl?: boolean } = {},
  ): void {
    const pane = this.paneAt(x, y);
    if (pane === 'paneAxis') return;
    if (pane === 'priceAxis') {
      const mid = (this.price.min + this.price.max) / 2;
      this.price.scaleAround(Math.exp(deltaY * 0.002), mid);
      this.afterViewChange();
      return;
    }
    const horizontal = modifiers.shift ? deltaY || deltaX : Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : 0;
    if (horizontal !== 0 || deltaY !== 0) this.userMoved();
    if (horizontal !== 0 && !modifiers.ctrl) {
      this.time.panPixels(-horizontal);
    } else if (deltaY !== 0) {
      const atPointer = pane !== 'timeAxis' && x <= this.plotWidth() && (!this.following || modifiers.ctrl);
      this.time.zoom(Math.exp(-deltaY * (modifiers.ctrl ? 0.01 : 0.002)), atPointer ? x : this.plotWidth());
    }
    this.afterViewChange();
  }

  doubleClick(x: number, y: number, mods: PointerMods = {}): void {
    if (this.separatorAt(x, y)) return;
    const pane = this.paneAt(x, y);
    if (pane === 'main' && this.offerPointer('dblclick', x, y, mods)) return;
    if (pane === 'priceAxis') {
      this.price.mode = 'auto';
      this.afterViewChange();
    } else if (pane !== null && pane !== 'paneAxis') {
      this.userMoved();
      this.resetView();
      this.afterViewChange();
    }
  }

  keyDown(key: string): boolean {
    for (const layer of this.interactiveLayers()) if (layer.keyDown?.(key)) return true;
    const visible = this.time.visibleSlots;
    switch (key) {
      case 'ArrowLeft':
        this.time.rightEdgeSlot -= Math.max(1, visible / 10);
        break;
      case 'ArrowRight':
        this.time.rightEdgeSlot += Math.max(1, visible / 10);
        break;
      case '+':
      case '=':
        this.time.zoom(1.25, this.plotWidth());
        break;
      case '-':
        this.time.zoom(0.8, this.plotWidth());
        break;
      case 'Home':
        this.resetView();
        break;
      default:
        return false;
    }
    this.userMoved();
    this.afterViewChange();
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frameHandle !== null) this.scheduler.cancel(this.frameHandle);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.dataTimer !== null) this.timers.clear(this.dataTimer);
    if (this.settleTimer !== null) this.timers.clear(this.settleTimer);
    this.dataTimer = null;
    this.settleTimer = null;
    this.gpu.destroy();
    for (const layer of this.registry.all()) layer.detach?.();
    this.listeners.clear();
  }
}

function askOf(update: ViewportUpdate): TimeAsk | null {
  if (update.fitAll) return { fitAll: true };
  if (update.lastBars !== undefined) return { lastBars: Math.max(1, Math.round(update.lastBars)) };
  if (update.range) return { range: { from: update.range.from, to: update.range.to } };
  return null;
}

function sameSessions(a: SessionOptions, b: SessionOptions): boolean {
  return (
    a.mode === b.mode &&
    a.timezone === b.timezone &&
    a.dayStartMinutes === b.dayStartMinutes &&
    (a.dayStartZone ?? a.timezone) === (b.dayStartZone ?? b.timezone) &&
    (a.maxGapMs ?? null) === (b.maxGapMs ?? null)
  );
}
