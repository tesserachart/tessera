import { MINUS, type PriceFormatter } from '../format.ts';
import type { FootprintBar, FootprintStore, FootprintView } from '../flow/footprintStore.ts';
import {
  BUY_IMBALANCE,
  DEFAULT_IMBALANCE,
  flagsOnRows,
  imbalanceFlags,
  SELL_IMBALANCE,
  stacksOf,
  type ImbalanceOptions,
} from '../flow/imbalance.ts';
import { autoRowTicks } from '../flow/ticks.ts';
import { formatCount, GlyphAtlas } from '../render/glyphs.ts';
import { font, snap } from '../render/draw.ts';
import type { SeriesValues } from '../indicators/values.ts';
import { ORDERFLOW_STYLE, rgba } from '../theme.ts';
import type { ChartTheme, TimeSpan } from '../types.ts';
import { CVD_COLUMN } from './delta.ts';
import {
  defaultCanvasFactory,
  FlowState,
  NO_GAPS,
  STOPPED_ALPHA,
  type AskSource,
  type AskTarget,
  type CanvasFactory,
  type FlowReadout,
  type LegendNote,
  type LegendNotice,
  type LegendValue,
} from './flowReadout.ts';
import { CANDLE_BODY_MIN_SPACING } from './candles.ts';
import { paintZones, ZoneFinder } from './imbalanceZones.ts';
import type { Ctx2D, FigureColumn, Layer, LayerHost, RenderContext, ViewHints } from './types.ts';

export type FootprintMode = 'bid_ask' | 'delta' | 'volume' | 'trades' | 'histogram';
export type FootprintTint = 'volume' | 'delta' | 'none';
export type FootprintMaxLevel = 'off' | 'volume' | 'trades' | 'bid' | 'ask';

export interface FootprintOptions extends ImbalanceOptions {
  mode: FootprintMode;
  tint: FootprintTint;
  rowTicks: number | 'auto';
  dimBelow: number;
  maxLevel: FootprintMaxLevel;
  extendZones: boolean;
  poc: boolean;
  deltaPoc: boolean;
  valueArea: boolean;
  unfinished: boolean;
  stats: boolean;
  minRowTicks: number;
}

export const DEFAULT_FOOTPRINT: Readonly<FootprintOptions> = {
  mode: 'bid_ask',
  tint: 'volume',
  rowTicks: 'auto',
  dimBelow: 0,
  maxLevel: 'off',
  ...DEFAULT_IMBALANCE,
  extendZones: true,
  poc: true,
  deltaPoc: true,
  valueArea: true,
  unfinished: true,
  stats: false,
  minRowTicks: 1,
};

export function footprintRowTicks(root: string | null | undefined): number {
  switch (root) {
    case 'NQ':
    case 'MNQ':
      return 4;
    case 'YM':
    case 'MYM':
    case 'RTY':
    case 'M2K':
    case 'CL':
    case 'MCL':
      return 5;
    case 'GC':
    case 'MGC':
      return 3;
    default:
      return 1;
  }
}

const STATS_ROWS = ['Vol', 'Δ', 'Δ %', 'Δ high', 'Δ low', 'CVD'] as const;
const STATS_ROW_PX = 14;
const STATS_MIN_SPACING = 40;

export const FOOTPRINT_LOD = { cells: 14, volumeBars: 96, hysteresis: 4 } as const;
export const FOOTPRINT_MAX_SPACING = 480;
const ROW_PX_TEXT = 12;
const ROW_PX_CELLS = 3;
const CELL_LEFT_PX = 6;
const CELL_CUT_MIN_PX = 4;
const CELL_CUT_SHARE = 0.06;
export const STEM_X_PX = 2;
export const STEM_BODY_PX = 3;

const FIGURE_GAP_PX = 5;
export const FOOTPRINT_FIGURE_SIZES = [
  ORDERFLOW_STYLE.figureSize,
  ORDERFLOW_STYLE.figureSize - 1,
  ORDERFLOW_STYLE.figureSize - 2,
] as const;

function sided(mode: FootprintMode): boolean {
  return mode === 'bid_ask' || mode === 'histogram';
}

function peakRow(v: FootprintView, level: FootprintMaxLevel): number {
  switch (level) {
    case 'volume':
      return v.poc;
    case 'trades':
      return v.tradesPoc;
    case 'bid':
      return v.bidPeak;
    case 'ask':
      return v.askPeak;
    case 'off':
      return -1;
  }
}

function cellCut(spacing: number): number {
  return Math.max(CELL_CUT_MIN_PX, CELL_CUT_SHARE * spacing);
}

function cellSpan(x: number, spacing: number, dpr: number): { cl: number; cr: number; centre: number } {
  const cl = snap(x - spacing / 2 + CELL_LEFT_PX, dpr);
  const cr = snap(x + spacing / 2 - cellCut(spacing), dpr);
  return { cl, cr, centre: snap((cl + cr) / 2, dpr) };
}

export interface FootprintLayerOptions {
  id: string;
  options?: Partial<FootprintOptions>;
  z?: number;
  owner?: string | null;
  visible?: boolean;
  createCanvas?: CanvasFactory;
}

const INK = 0;
const UP = 1;
const DOWN = 2;
const QUIET = 3;

export class FootprintLayer implements Layer, FlowReadout, AskSource {
  readonly id: string;
  readonly kind = 'series' as const;
  readonly surface = 'main' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = 'Tessera';
  readonly owner: string | null;
  readonly visible: boolean;
  readonly state = new FlowState();
  options: FootprintOptions;
  private store: FootprintStore | null = null;
  private host: LayerHost | null = null;
  private readonly createCanvas: CanvasFactory | null;
  private atlas: GlyphAtlas | null = null;
  private atlasKey = '';
  lod = 0;
  figureSize: number = FOOTPRINT_FIGURE_SIZES[0];
  rowTicks = 1;
  needFrom: number | null = null;
  private cvd: SeriesValues | null = null;
  private gaps: readonly TimeSpan[] = NO_GAPS;
  private lastSpacing = Number.NaN;
  private lastRc: RenderContext | null = null;
  private flags = new Uint8Array(64);
  private found = new Uint8Array(64);
  private readonly zones = new ZoneFinder();
  private readonly bufs = new CellBufs();
  private frameBars: (FootprintBar | undefined)[] = [];
  private frameFrom = 0;

  constructor(o: FootprintLayerOptions) {
    this.id = o.id;
    this.z = o.z ?? 12;
    this.owner = o.owner ?? null;
    this.visible = o.visible ?? true;
    this.options = { ...DEFAULT_FOOTPRINT, ...o.options };
    this.createCanvas = o.createCanvas ?? defaultCanvasFactory();
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  setCvd(values: SeriesValues | null): void {
    if (values === this.cvd) return;
    this.cvd = values;
    this.host?.invalidate('data');
  }

  setGaps(gaps: readonly TimeSpan[]): void {
    if (gaps === this.gaps) return;
    this.gaps = gaps;
    this.host?.invalidate('data');
  }

  setStore(store: FootprintStore | null): void {
    if (store === this.store) return;
    this.store = store;
    this.zones.reset();
    this.host?.invalidate('data');
  }

  setOptions(o: Partial<FootprintOptions>): void {
    this.options = { ...this.options, ...o };
    this.zones.reset();
    this.host?.invalidate();
  }

  dataChanged(): void {
    this.host?.invalidate('data');
  }

  noteChanged(): void {
    this.host?.invalidate();
  }

  viewHints(): ViewHints {
    return { maxBarSpacing: FOOTPRINT_MAX_SPACING };
  }

  legendValues(_index: number, _format: PriceFormatter, _theme: ChartTheme): LegendValue[] {
    return [];
  }

  missingPrints(): readonly TimeSpan[] {
    return this.gaps;
  }

  legendNote(): LegendNote | null {
    return this.state.note;
  }

  legendNotice(): LegendNotice | null {
    return this.state.notice;
  }

  reading(): boolean {
    return this.state.reading;
  }

  legendSuffix(): string {
    return this.options.rowTicks === 'auto' && this.lod >= 1 && this.rowTicks > 1
      ? `${String(this.rowTicks)} ticks`
      : '';
  }

  aggressorNote(): string | null {
    return this.state.aggressor;
  }

  private barAt(rc: RenderContext, i: number): FootprintBar | undefined {
    const k = i - this.frameFrom;
    if (k >= 0 && k < this.frameBars.length) return this.frameBars[k];
    return this.store?.get(rc.store.time[i]!);
  }

  private mapBars(rc: RenderContext): void {
    const { time } = rc;
    const n = Math.max(0, time.to - time.from + 1);
    if (this.frameBars.length !== n) this.frameBars = new Array<FootprintBar | undefined>(n);
    this.frameFrom = time.from;
    const store = this.store;
    for (let k = 0; k < n; k++) this.frameBars[k] = store?.get(rc.store.time[time.from + k]!);
  }

  private tickPx(rc: RenderContext): number {
    const tick = this.store?.grid.tick ?? 1;
    return Math.abs(rc.mainPrice.yOf(0) - rc.mainPrice.yOf(tick));
  }

  private detectionTicks(): number {
    const fixed = this.options.rowTicks;
    return Math.max(1, Math.round(fixed === 'auto' ? this.options.minRowTicks : fixed));
  }

  private baseTicks(): number {
    let base = 1;
    for (const b of this.frameBars) if (b && b.baseTicks > base) base = b.baseTicks;
    return base;
  }

  private widestText(rc: RenderContext, rowTicks: number): number {
    const store = this.store;
    if (!store) return 0;
    let side = 0;
    let delta = 0;
    let vol = 0;
    let trades = 0;
    for (const b of this.frameBars) {
      if (!b) continue;
      const v = store.view(b, rowTicks);
      if (v.maxSide > side) side = v.maxSide;
      if (v.maxDelta > delta) delta = v.maxDelta;
      if (v.maxVolume > vol) vol = v.maxVolume;
      if (v.maxTrades > trades) trades = v.maxTrades;
    }
    const mode = this.options.mode;
    const text = sided(mode)
      ? formatCount(side)
      : mode === 'delta'
        ? formatCount(-delta, true)
        : formatCount(mode === 'trades' ? trades : vol);
    return this.measure(rc, text, 400, FOOTPRINT_FIGURE_SIZES[0]);
  }

  private measure(rc: RenderContext, text: string, weight = 400, size = this.figureSize): number {
    const atlas = this.ensureAtlas(rc);
    if (atlas) return (atlas.measure(text) * size) / atlas.size;
    rc.ctx.font = font(size, rc.theme.fontFig, weight);
    return rc.ctx.measureText(text).width;
  }

  private fitSpacing(textW: number): number {
    const need = sided(this.options.mode) ? 2 * textW + 2 * FIGURE_GAP_PX + 2 : textW + 8;
    const narrow = need + (CELL_LEFT_PX + CELL_CUT_MIN_PX);
    return narrow <= CELL_CUT_MIN_PX / CELL_CUT_SHARE ? narrow : (need + CELL_LEFT_PX) / (1 - CELL_CUT_SHARE);
  }

  private shows(rc: RenderContext): boolean {
    return rc.time.barSpacing >= CANDLE_BODY_MIN_SPACING;
  }

  private sync(rc: RenderContext): void {
    if (rc.time.barSpacing !== this.lastSpacing || this.frameFrom !== rc.time.from) this.decide(rc);
    else if (this.shows(rc)) this.mapBars(rc);
  }

  private decide(rc: RenderContext): void {
    const spacing = rc.time.barSpacing;
    this.lastSpacing = spacing;
    if (!this.shows(rc)) {
      this.lod = 0;
      this.frameFrom = rc.time.from;
      this.frameBars.length = 0;
      return;
    }
    this.mapBars(rc);
    const h = FOOTPRINT_LOD.hysteresis;
    const held = this.lod;
    const heldSize = this.figureSize;
    const at = (lvl: number, threshold: number) => spacing >= (held >= lvl ? threshold - h : threshold);
    const tickPx = this.tickPx(rc);
    const base = this.baseTicks();
    const fixed = this.options.rowTicks;
    const floor = Math.max(base, Math.round(this.options.minRowTicks));
    const rowFor = (minPx: number) =>
      fixed === 'auto' ? autoRowTicks(tickPx, minPx, floor) : Math.max(base, Math.round(fixed));
    let lod = 0;
    let figureSize: number = FOOTPRINT_FIGURE_SIZES[0];
    if (at(1, FOOTPRINT_LOD.cells)) {
      lod = 1;
      const textRows = rowFor(ROW_PX_TEXT);
      if (textRows * tickPx >= ROW_PX_TEXT) {
        const full = FOOTPRINT_FIGURE_SIZES[0];
        const widest = this.widestText(rc, textRows);
        const fits = FOOTPRINT_FIGURE_SIZES.find((size) => {
          const threshold = this.fitSpacing((widest * size) / full);
          return spacing >= (held >= 2 && size <= heldSize ? threshold - h : threshold);
        });
        if (fits !== undefined) {
          lod = at(3, FOOTPRINT_LOD.volumeBars) ? 3 : 2;
          figureSize = fits;
        }
      }
    }
    this.lod = lod;
    this.figureSize = figureSize;
    this.rowTicks = rowFor(lod >= 2 ? ROW_PX_TEXT : ROW_PX_CELLS);
  }

  figureColumns(rc: RenderContext): readonly FigureColumn[] {
    const store = this.store;
    if (!store || rc.time.to < rc.time.from) return [];
    this.sync(rc);
    if (this.lod < 2) return [];
    const { time, dpr } = rc;
    const mode = this.options.mode;
    const out: FigureColumn[] = [];
    for (let i = time.from; i <= time.to; i++) {
      const b = this.barAt(rc, i);
      if (!b || b.rows === 0) continue;
      const { cl, cr, centre } = cellSpan(time.xOfIndex(i), time.barSpacing, dpr);
      if (cr <= cl) continue;
      const v = store.view(b, Math.max(b.baseTicks, this.rowTicks));
      const width = (text: string) => this.measure(rc, text, ORDERFLOW_STYLE.imbalanceWeight);
      let bidW = 0;
      let askW = 0;
      for (let r = 0; r < v.rows; r++) {
        const bid = v.bid[r]!;
        const ask = v.ask[r]!;
        if (bid + ask <= 0) continue;
        if (sided(mode)) {
          bidW = Math.max(bidW, width(count(bid)));
          askW = Math.max(askW, width(count(ask)));
        } else {
          const w = width(centredText(mode, bid, ask, v.trades[r]!)) / 2;
          bidW = Math.max(bidW, w);
          askW = Math.max(askW, w);
        }
      }
      if (bidW === 0 && askW === 0) continue;
      const gap = sided(mode) ? FIGURE_GAP_PX : 0;
      out.push({ index: i, left: centre - gap - bidW, right: centre + gap + askW });
    }
    return out;
  }

  replacesSeries(rc: RenderContext): boolean {
    this.decide(rc);
    if (this.lod < 1) return false;
    return this.frameBars.some((b) => b !== undefined);
  }

  private ensureAtlas(rc: RenderContext): GlyphAtlas | null {
    if (!this.createCanvas) return null;
    const fl = rc.theme.flow;
    const key = `${String(rc.dpr)}|${String(this.figureSize)}|${rc.theme.fontFig}|${fl.text}|${fl.imbalanceAsk}|${fl.imbalanceBid}|${rc.theme.mutedText}`;
    if (this.atlas && this.atlasKey === key) return this.atlas;
    this.atlas = new GlyphAtlas({
      createCanvas: this.createCanvas,
      family: rc.theme.fontFig,
      size: this.figureSize,
      colors: [fl.text, fl.imbalanceAsk, fl.imbalanceBid, rc.theme.mutedText],
      weights: [400, ORDERFLOW_STYLE.imbalanceWeight],
      dpr: rc.dpr,
    });
    this.atlasKey = key;
    return this.atlas;
  }

  draw(rc: RenderContext): void {
    this.lastRc = rc;
    if (rc.time.to >= rc.time.from) this.needFrom = this.shows(rc) ? (rc.store.time[rc.time.from] ?? null) : null;
    if (rc.time.to < rc.time.from || !this.store || !this.shows(rc)) return;
    this.sync(rc);
    const { ctx, pane } = rc;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    if (this.state.stopped) ctx.globalAlpha = STOPPED_ALPHA;
    if (this.lod === 0) this.drawPocDashes(rc);
    else this.drawCells(rc);
    if (this.options.stats && rc.time.barSpacing >= STATS_MIN_SPACING) this.drawStats(rc);
    ctx.restore();
  }

  private drawStats(rc: RenderContext): void {
    const { ctx, time, pane, theme } = rc;
    const h = STATS_ROW_PX;
    const top = pane.y + pane.h - STATS_ROWS.length * h - 2;
    ctx.fillStyle = theme.background;
    ctx.globalAlpha *= 0.92;
    ctx.fillRect(pane.x, top - 2, pane.w, pane.y + pane.h - top + 2);
    ctx.globalAlpha /= 0.92;
    ctx.fillStyle = theme.border;
    ctx.fillRect(pane.x, top - 2, pane.w, 1 / rc.dpr);
    ctx.font = font(ORDERFLOW_STYLE.figureSize - 1, theme.fontFig);
    ctx.textBaseline = 'middle';
    const ink = (v: number) => (v > 0 ? theme.upText : v < 0 ? theme.downText : theme.mutedText);
    const signed = (v: number) => formatCount(v, true);
    ctx.textAlign = 'center';
    for (let i = time.from; i <= time.to; i++) {
      const b = this.barAt(rc, i);
      if (!b || b.rows === 0) continue;
      const x = time.xOfIndex(i);
      if (x < pane.x + 44) continue;
      const vol = b.volume;
      const d = b.delta;
      const cvd = this.cvd?.valueAt(CVD_COLUMN, rc.store.time[i]!) ?? Number.NaN;
      const cells: [string, string][] = [
        [formatCount(vol), theme.flow.text],
        [signed(d), ink(d)],
        [vol > 0 ? `${d > 0 ? '+' : d < 0 ? MINUS : ''}${String(Math.round((Math.abs(d) / vol) * 100))}%` : '', ink(d)],
        [b.deltaHigh === null ? '' : signed(Math.max(0, b.deltaHigh, d)), theme.subtleText],
        [b.deltaLow === null ? '' : signed(Math.min(0, b.deltaLow, d)), theme.subtleText],
        [Number.isNaN(cvd) ? '' : signed(cvd), ink(cvd)],
      ];
      for (let r = 0; r < cells.length; r++) {
        const [text, color] = cells[r]!;
        if (!text) continue;
        ctx.fillStyle = color;
        ctx.fillText(text, x, top + r * h + h / 2);
      }
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.mutedText;
    for (let r = 0; r < STATS_ROWS.length; r++) ctx.fillText(STATS_ROWS[r]!, pane.x + 6, top + r * h + h / 2);
  }

  private drawPocDashes(rc: RenderContext): void {
    if (!this.options.poc) return;
    const { ctx, time, dpr, mainPrice } = rc;
    const store = this.store!;
    const grid = store.grid;
    const px = 1 / dpr;
    const w = Math.max(px, snap(time.barSpacing * 0.7, dpr));
    ctx.beginPath();
    for (let i = time.from; i <= time.to; i++) {
      const b = this.barAt(rc, i);
      if (!b || b.rows === 0) continue;
      const v = store.view(b, Math.max(b.baseTicks, this.rowTicks));
      if (v.poc < 0) continue;
      const mid = grid.toPrice(v.lowTick + v.poc * v.rowTicks) + ((v.rowTicks - 1) * grid.tick) / 2;
      const y = snap(mainPrice.yOf(mid), dpr);
      const x = snap(time.xOfIndex(i), dpr);
      ctx.rect(x - w / 2, y, w, px);
    }
    const g = ctx.globalAlpha;
    ctx.globalAlpha = g * ORDERFLOW_STYLE.pocDash.alpha;
    ctx.fillStyle = rc.theme.flow.poc;
    ctx.fill();
    ctx.globalAlpha = g;
  }

  private drawCells(rc: RenderContext): void {
    const { ctx, time, dpr, mainPrice, theme, pane } = rc;
    const store = this.store!;
    const grid = store.grid;
    const o = this.options;
    const px = 1 / dpr;
    const spacing = time.barSpacing;
    const rowTicks = this.rowTicks;
    const detectTicks = this.detectionTicks();
    const lod = this.lod;
    const steps = ORDERFLOW_STYLE.tintSteps;
    const b0 = this.bufs;
    b0.reset();
    const tints = b0.tints;
    const tintPath = (bucket: number) => (tints[bucket] ??= new PathBuf());
    const splitPath = (bucket: number, side: 1 | -1) => (b0.splits[2 * bucket + (side > 0 ? 1 : 0)] ??= new PathBuf());
    const candles = b0.candles;
    const pocBoxes = b0.pocBoxes;
    const edgeUp = b0.edgeUp;
    const edgeDown = b0.edgeDown;
    const vaRules = b0.vaRules;
    const unfinished = b0.unfinished;
    const dpocUp = b0.dpocUp;
    const dpocDown = b0.dpocDown;
    const profile = b0.profile;
    const faint = b0.faint;
    const peaks = b0.peaks;
    const cellBars = b0.cellBars;
    const dividers = b0.dividers;
    const texts = b0.texts;
    const rowY = (tick: number) => mainPrice.yOf(grid.toPrice(tick) - grid.tick / 2);
    const top = pane.y;
    const bottom = pane.y + pane.h;
    const tint = store.tintScale(rowTicks);
    const atlas = lod >= 2 ? this.ensureAtlas(rc) : null;
    atlas?.beginFrame();
    const numbers = lod >= 2;
    const histogram = o.mode === 'histogram';
    const dimShare = Math.min(1, Math.max(0, o.dimBelow / 100));
    const peakPx = Math.max(1, Math.round(ORDERFLOW_STYLE.maxLevel.width * dpr)) * px;

    for (let i = time.from; i <= time.to; i++) {
      const b = this.barAt(rc, i);
      const x = time.xOfIndex(i);
      const left = x - spacing / 2;
      const oi = rc.store.open[i]!;
      const ci = rc.store.close[i]!;
      const up = ci >= oi;
      const yh = snap(mainPrice.yOf(rc.store.high[i]!), dpr);
      const yl = snap(mainPrice.yOf(rc.store.low[i]!), dpr);
      if (!b || b.rows === 0) {
        const body = Math.max(px, snap(spacing * 0.7, dpr));
        const cx = snap(x, dpr);
        const path = up ? candles.up : candles.down;
        path.rect(cx - px / 2, yh, px, Math.max(px, yl - yh));
        const yo = mainPrice.yOf(oi);
        const yc = mainPrice.yOf(ci);
        path.rect(cx - body / 2, snap(Math.min(yo, yc), dpr), body, Math.max(px, snap(Math.abs(yc - yo), dpr)));
        continue;
      }
      const sx = snap(left + STEM_X_PX, dpr);
      const stem = up ? candles.up : candles.down;
      stem.rect(sx - px / 2, yh, px, Math.max(px, yl - yh));
      const yo = mainPrice.yOf(oi);
      const yc = mainPrice.yOf(ci);
      stem.rect(
        sx - STEM_BODY_PX / 2,
        snap(Math.min(yo, yc), dpr),
        STEM_BODY_PX,
        Math.max(px, snap(Math.abs(yc - yo), dpr)),
      );

      const v = store.view(b, Math.max(b.baseTicks, rowTicks));
      const live = !b.closed;
      const { cl, cr, centre } = cellSpan(x, spacing, dpr);
      const cw = cr - cl;
      if (cw <= 0) continue;
      const d = store.view(b, Math.max(b.baseTicks, detectTicks));
      if (this.found.length < d.rows) this.found = new Uint8Array(d.rows * 2);
      if (this.flags.length < v.rows) this.flags = new Uint8Array(v.rows * 2);
      const found = imbalanceFlags(d, o, this.found);
      const flags = d === v ? found : flagsOnRows(d, found, v, this.flags);
      const dimCut = dimShare * v.maxVolume;
      const peak = peakRow(v, o.maxLevel);
      for (let r = 0; r < v.rows; r++) {
        const bid = v.bid[r]!;
        const ask = v.ask[r]!;
        const vol = bid + ask;
        const lowTick = v.lowTick + r * v.rowTicks;
        const y0 = snap(rowY(lowTick + v.rowTicks), dpr);
        const y1 = snap(rowY(lowTick), dpr);
        if (y1 < top || y0 > bottom) continue;
        const h = Math.max(px, y1 - y0 - (y1 - y0 > 3 ? px : 0));
        const faded = vol > 0 && vol < dimCut;
        if (vol > 0 && o.mode === 'volume') {
          if (v.maxVolume > 0) (faded ? faint : profile).rect(cl, y0, Math.max(px, (vol / v.maxVolume) * cw), h);
        } else if (histogram) {
          if (v.maxSide > 0) {
            const bShare = bid / v.maxSide;
            const aShare = ask / v.maxSide;
            if (bShare > 0) {
              const w = Math.max(px, bShare * (centre - cl));
              splitPath(faded ? 0 : quant(bShare, steps), -1).rect(centre - w, y0, w, h);
            }
            if (aShare > 0)
              splitPath(faded ? 0 : quant(aShare, steps), 1).rect(centre, y0, Math.max(px, aShare * (cr - centre)), h);
          }
        } else if (vol > 0 && !faded) {
          if (o.tint === 'volume' && tint.volume > 0) {
            tintPath(quant(vol / tint.volume, steps)).rect(cl, y0, cw, h);
          } else if (o.tint === 'delta' && tint.delta > 0) {
            const d = ask - bid;
            if (d !== 0) tintPath(steps * (d > 0 ? 1 : 2) + quant(Math.abs(d) / tint.delta, steps)).rect(cl, y0, cw, h);
          }
        }
        if (lod === 1 && o.mode !== 'volume' && !histogram && v.maxSide > 0) {
          const left = centre - cl;
          const right = cr - centre;
          const bShare = bid / v.maxSide;
          const aShare = ask / v.maxSide;
          if (bShare > 0) splitPath(faded ? 0 : quant(bShare, steps), -1).rect(cl, y0, Math.max(px, bShare * left), h);
          if (aShare > 0)
            splitPath(faded ? 0 : quant(aShare, steps), 1).rect(
              cr - Math.max(px, aShare * right),
              y0,
              Math.max(px, aShare * right),
              h,
            );
        }
        if (r === peak && h > 2 * peakPx) peaks.strokeRect(cl + peakPx / 2, y0 + peakPx / 2, cw - peakPx, h - peakPx);
        else if (o.poc && r === v.poc) pocBoxes.strokeRect(cl + px / 2, y0 + px / 2, cw - px, h - px);
        if (o.deltaPoc && r === v.deltaPoc && h > 4 * px) {
          const d = ask - bid;
          (d >= 0 ? dpocUp : dpocDown).strokeRect(cl + 2 * px + px / 2, y0 + 2 * px + px / 2, cw - 5 * px, h - 5 * px);
        }
        if (o.unfinished && r === v.rows - 1 && v.unfinishedHigh) unfinished.rect(cl, y0, cw + 6, px * 2);
        if (o.unfinished && r === 0 && v.unfinishedLow) unfinished.rect(cl, y0 + h - px * 2, cw + 6, px * 2);
        const f = flags[r]!;
        if (lod === 1) {
          if (f & BUY_IMBALANCE) edgeUp.rect(cr - 2, y0, 2, h);
          if (f & SELL_IMBALANCE) edgeDown.rect(cl, y0, 2, h);
        }
        if (lod >= 3 && !histogram && !faded && v.maxVolume > 0 && vol > 0)
          cellBars.rect(cl, y0, Math.max(px, (vol / v.maxVolume) * cw), h);
        if (numbers && vol > 0 && y1 - y0 >= ROW_PX_TEXT - 1) {
          const ty = (y0 + y1) / 2;
          if (sided(o.mode)) {
            const buy = !faded && (f & BUY_IMBALANCE) !== 0;
            const sell = !faded && (f & SELL_IMBALANCE) !== 0;
            const bidInk = sell ? DOWN : bid === 0 || faded ? QUIET : INK;
            const askInk = buy ? UP : ask === 0 || faded ? QUIET : INK;
            texts.add(count(bid), centre - FIGURE_GAP_PX, ty, 'right', bidInk, sell ? 1 : 0, live);
            texts.add(count(ask), centre + FIGURE_GAP_PX, ty, 'left', askInk, buy ? 1 : 0, live);
            if (histogram) continue;
            if (spacing < 96) dividers.rect(centre - px / 2, y0 + 2, px, Math.max(px, h - 4));
            else texts.add('×', centre, ty, 'center', QUIET, 0, false);
          } else if (o.mode === 'delta') {
            const d = ask - bid;
            const ink = faded || d === 0 ? QUIET : d > 0 ? UP : DOWN;
            texts.add(count(d, true), centre, ty, 'center', ink, f && !faded ? 1 : 0, live);
          } else if (o.mode === 'trades') {
            const trades = v.trades[r]!;
            if (trades > 0) texts.add(count(trades), centre, ty, 'center', faded ? QUIET : INK, 0, live);
          } else {
            texts.add(count(vol), centre, ty, 'center', faded ? QUIET : INK, 0, live);
          }
        }
      }
      if (o.valueArea && v.vaLow >= 0) {
        const yTop = snap(rowY(v.lowTick + (v.vaHigh + 1) * v.rowTicks), dpr);
        const yBot = snap(rowY(v.lowTick + v.vaLow * v.rowTicks), dpr);
        vaRules.rect(cl - 2, yTop, px, Math.max(px, yBot - yTop));
      }
      for (const s of stacksOf(found, d.rows, o.stackRows)) {
        const yTop = snap(rowY(d.lowTick + (s.high + 1) * d.rowTicks), dpr);
        const yBot = snap(rowY(d.lowTick + s.low * d.rowTicks), dpr);
        if (s.side === 'buy') edgeUp.rect(cr, yTop, 2, yBot - yTop);
        else edgeDown.rect(cl - 2, yTop, 2, yBot - yTop);
      }
    }

    const g = ctx.globalAlpha;
    for (let k = 0; k < tints.length; k++) {
      const p = tints[k];
      if (!p) continue;
      const step = k % steps;
      const which = Math.floor(k / steps);
      const [lo, hi] = which === 0 ? ORDERFLOW_STYLE.tintVolume : ORDERFLOW_STYLE.tintDelta;
      const a = lo + ((hi - lo) * (step + 1)) / steps;
      const rgb = which === 0 ? theme.flow.volume : which === 1 ? theme.flow.ask : theme.flow.bid;
      ctx.fillStyle = rgba(rgb, a);
      p.fill(ctx);
    }
    const [splitLo, splitHi] = histogram ? ORDERFLOW_STYLE.histogram : ORDERFLOW_STYLE.cellSplit;
    for (let k = 0; k < steps; k++) {
      const a = splitLo + ((splitHi - splitLo) * (k + 1)) / steps;
      const bid = b0.splits[2 * k];
      if (bid) {
        ctx.fillStyle = rgba(theme.flow.bid, a);
        bid.fill(ctx);
      }
      const ask = b0.splits[2 * k + 1];
      if (ask) {
        ctx.fillStyle = rgba(theme.flow.ask, a);
        ask.fill(ctx);
      }
    }
    if (lod >= 2 && o.extendZones) this.drawZones(rc);
    ctx.fillStyle = rgba(theme.flow.volume, ORDERFLOW_STYLE.cellBar);
    cellBars.fill(ctx);
    ctx.fillStyle = rgba(theme.flow.volume, ORDERFLOW_STYLE.barProfile);
    profile.fill(ctx);
    ctx.fillStyle = rgba(theme.flow.volume, ORDERFLOW_STYLE.cellBar);
    faint.fill(ctx);
    ctx.fillStyle = rgba(theme.flow.volume, ORDERFLOW_STYLE.barValueArea);
    vaRules.fill(ctx);
    ctx.fillStyle = rgba(theme.flow.volume, ORDERFLOW_STYLE.unfinished);
    unfinished.fill(ctx);
    ctx.fillStyle = theme.upFill;
    candles.up.fill(ctx);
    ctx.fillStyle = theme.downFill;
    candles.down.fill(ctx);
    ctx.fillStyle = theme.upFill;
    edgeUp.fill(ctx);
    ctx.fillStyle = theme.downFill;
    edgeDown.fill(ctx);
    ctx.fillStyle = theme.border;
    dividers.fill(ctx);
    if (o.poc) {
      ctx.globalAlpha = g * ORDERFLOW_STYLE.pocOutline.alpha;
      ctx.strokeStyle = theme.flow.poc;
      ctx.lineWidth = px;
      pocBoxes.stroke(ctx);
      ctx.globalAlpha = g;
    }
    if (o.deltaPoc) {
      ctx.lineWidth = px;
      ctx.strokeStyle = rgba(theme.flow.ask, ORDERFLOW_STYLE.deltaPoc);
      dpocUp.stroke(ctx);
      ctx.strokeStyle = rgba(theme.flow.bid, ORDERFLOW_STYLE.deltaPoc);
      dpocDown.stroke(ctx);
    }
    ctx.lineWidth = peakPx;
    ctx.strokeStyle = rgba(theme.flow.volume, ORDERFLOW_STYLE.maxLevel.alpha);
    peaks.stroke(ctx);
    if (texts.n) this.drawTexts(rc, atlas, texts);
  }

  private drawTexts(rc: RenderContext, atlas: GlyphAtlas | null, t: TextBuf): void {
    const { ctx, theme } = rc;
    if (atlas) {
      for (let k = 0; k < t.n; k++)
        atlas.draw(ctx, t.text[k]!, t.x[k]!, t.y[k]!, t.align[k]!, t.color[k], t.weight[k], !t.live[k]);
      return;
    }
    const inks = [theme.flow.text, theme.flow.imbalanceAsk, theme.flow.imbalanceBid, theme.mutedText];
    ctx.textBaseline = 'middle';
    for (let k = 0; k < t.n; k++) {
      ctx.font = font(this.figureSize, theme.fontFig, t.weight[k] ? ORDERFLOW_STYLE.imbalanceWeight : 400);
      ctx.fillStyle = inks[t.color[k]!]!;
      ctx.textAlign = t.align[k]!;
      ctx.fillText(t.text[k]!, t.x[k]!, t.y[k]!);
    }
    ctx.textAlign = 'left';
  }

  private drawZones(rc: RenderContext): void {
    const store = this.store!;
    paintZones(rc, store.grid, this.zones.inView(store, rc, this.options, this.detectionTicks()));
  }

  askTarget(x: number, y: number): AskTarget | null {
    const rc = this.lastRc;
    const store = this.store;
    if (!rc || !store || rc.time.to < rc.time.from) return null;
    const i = rc.time.indexOfX(x);
    if (i < 0 || i >= rc.store.length) return null;
    const b = store.get(rc.store.time[i]!);
    if (!b || b.rows === 0) return null;
    const price = rc.mainPrice.priceOf(y);
    const low = rc.store.low[i]!;
    const high = rc.store.high[i]!;
    const tick = store.grid.tick;
    if (price < low - tick || price > high + tick) return null;
    const v = store.view(b, b.baseTicks);
    return {
      kind: 'bar',
      label: 'this bar',
      from: b.t,
      to: b.t + rc.timeframeMs,
      low,
      high,
      detail: `volume ${formatCount(v.volume)}, delta ${formatCount(v.delta, true)}`,
    };
  }
}

const COUNTS = new Map<number, string>();
const SIGNED = new Map<number, string>();

function count(v: number, signed = false): string {
  if (!Number.isInteger(v) || v <= -100_000 || v >= 100_000) return formatCount(v, signed);
  const m = signed ? SIGNED : COUNTS;
  let t = m.get(v);
  if (t === undefined) {
    t = formatCount(v, signed);
    m.set(v, t);
  }
  return t;
}

function centredText(mode: FootprintMode, bid: number, ask: number, trades: number): string {
  if (mode === 'delta') return count(ask - bid, true);
  if (mode === 'trades') return count(trades);
  return count(bid + ask);
}

function quant(share: number, steps: number): number {
  return Math.min(steps - 1, Math.max(0, Math.floor(share * steps)));
}

class PathBuf {
  private readonly r: number[] = [];
  private readonly s: number[] = [];

  reset(): void {
    this.r.length = 0;
    this.s.length = 0;
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.r.push(x, y, w, h);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.s.push(x, y, w, h);
  }

  fill(ctx: Ctx2D): void {
    const r = this.r;
    if (r.length === 0) return;
    ctx.beginPath();
    for (let k = 0; k < r.length; k += 4) ctx.rect(r[k]!, r[k + 1]!, r[k + 2]!, r[k + 3]!);
    ctx.fill();
  }

  stroke(ctx: Ctx2D): void {
    const s = this.s;
    if (s.length === 0) return;
    ctx.beginPath();
    for (let k = 0; k < s.length; k += 4) ctx.rect(s[k]!, s[k + 1]!, s[k + 2]!, s[k + 3]!);
    ctx.stroke();
  }
}

class TextBuf {
  n = 0;
  readonly text: string[] = [];
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly align: ('left' | 'right' | 'center')[] = [];
  readonly color: number[] = [];
  readonly weight: number[] = [];
  readonly live: boolean[] = [];

  add(
    text: string,
    x: number,
    y: number,
    align: 'left' | 'right' | 'center',
    color: number,
    weight: number,
    live: boolean,
  ): void {
    const k = this.n++;
    this.text[k] = text;
    this.x[k] = x;
    this.y[k] = y;
    this.align[k] = align;
    this.color[k] = color;
    this.weight[k] = weight;
    this.live[k] = live;
  }
}

class CellBufs {
  readonly tints: PathBuf[] = [];
  readonly splits: PathBuf[] = [];
  readonly candles = { up: new PathBuf(), down: new PathBuf() };
  readonly pocBoxes = new PathBuf();
  readonly edgeUp = new PathBuf();
  readonly edgeDown = new PathBuf();
  readonly cellBars = new PathBuf();
  readonly dividers = new PathBuf();
  readonly texts = new TextBuf();
  readonly vaRules = new PathBuf();
  readonly unfinished = new PathBuf();
  readonly dpocUp = new PathBuf();
  readonly dpocDown = new PathBuf();
  readonly profile = new PathBuf();
  readonly faint = new PathBuf();
  readonly peaks = new PathBuf();

  reset(): void {
    this.tints.forEach((t) => t.reset());
    this.splits.forEach((t) => t.reset());
    this.candles.up.reset();
    this.candles.down.reset();
    this.pocBoxes.reset();
    this.edgeUp.reset();
    this.edgeDown.reset();
    this.cellBars.reset();
    this.dividers.reset();
    this.vaRules.reset();
    this.unfinished.reset();
    this.dpocUp.reset();
    this.dpocDown.reset();
    this.profile.reset();
    this.faint.reset();
    this.peaks.reset();
    this.texts.n = 0;
  }
}
