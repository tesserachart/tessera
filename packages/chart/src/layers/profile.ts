import type { FootprintStore } from '../flow/footprintStore.ts';
import { nakedPocs, pointOfControl, ProfileAccumulator, valueAreaBand, volumeNodes } from '../flow/profile.ts';
import { autoRowTicks, floorDiv, type TickGrid } from '../flow/ticks.ts';
import type { PriceFormatter } from '../format.ts';
import { dashOf, type PlotStyle } from '../indicators/types.ts';
import { font, snap, TextMeasurer } from '../render/draw.ts';
import { formatCount } from '../render/glyphs.ts';
import {
  FlowState,
  NO_GAPS,
  signedCount,
  STOPPED_ALPHA,
  type AskSource,
  type AskTarget,
  type FlowReadout,
  type LegendNote,
  type LegendNotice,
  type LegendValue,
} from './flowReadout.ts';
import type { ChartTheme, Rect, TimeSpan } from '../types.ts';
import type { LabelClaim, Layer, LayerHost, RenderContext } from './types.ts';

export type ProfilePeriod = 'session' | 'day' | 'week' | 'month';
export type ProfileKind = ProfilePeriod | 'composite' | 'range' | 'anchored' | 'visible';
export type ProfileShow = 'volume' | 'split' | 'delta' | 'volumeDelta';
export type ProfileHours = 'all' | 'rth' | 'split';
export type ProfileSide = 'left' | 'right';

export function periodOf(kind: ProfileKind): ProfilePeriod | null {
  return kind === 'session' || kind === 'day' || kind === 'week' || kind === 'month' ? kind : null;
}

export function placedOver(kind: ProfileKind): kind is 'range' | 'anchored' {
  return kind === 'range' || kind === 'anchored';
}

function showsDelta(show: ProfileShow): boolean {
  return show === 'delta' || show === 'volumeDelta';
}

const PERIOD_WORDS: Readonly<Record<ProfilePeriod, readonly [string, string]>> = {
  session: ['session', 'sessions'],
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
};

export function periodCount(n: number, period: ProfilePeriod): string {
  const [one, many] = PERIOD_WORDS[period];
  return `${String(n)} ${n === 1 ? one : many}`;
}

const KIND_WORDS: Readonly<Record<ProfileKind, string>> = {
  session: 'the session profile',
  day: 'the daily profile',
  week: 'the weekly profile',
  month: 'the monthly profile',
  composite: 'the composite profile',
  range: 'the fixed-range profile',
  anchored: 'the anchored profile',
  visible: 'the visible profile',
};

const PLACED_LABEL: Readonly<Record<'range' | 'anchored', string>> = { range: 'Range', anchored: 'Anchored' };

export interface RenderedProfileInfo {
  label: string;
  from: number;
  to: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  volume: number;
  delta: number;
  partial: boolean;
}

export interface ProfileOptions {
  period: ProfileKind;
  compositePeriod: ProfilePeriod;
  length: number;
  from: number | null;
  to: number | null;
  show: ProfileShow;
  hours: ProfileHours;
  valueArea: number;
  rowTicks: number | 'auto';
  extendLines: boolean;
  nakedPocs: boolean;
  developingPoc: boolean;
  developingVa: boolean;
  nodes: boolean;
  side: ProfileSide;
  priorVa: boolean;
  notes: Readonly<Record<string, string>> | null;
}

export const DEFAULT_PROFILE: Readonly<ProfileOptions> = {
  period: 'session',
  compositePeriod: 'session',
  length: 5,
  from: null,
  to: null,
  show: 'volume',
  hours: 'all',
  valueArea: 0.7,
  rowTicks: 'auto',
  extendLines: false,
  nakedPocs: true,
  developingPoc: false,
  developingVa: false,
  nodes: false,
  side: 'left',
  priorVa: false,
  notes: null,
};

export interface SessionProfileData {
  from: number;
  to: number;
  label: string;
  rowTicks: number;
  lowTick: number;
  rows: number;
  volume: Float64Array;
  buy: Float64Array;
  sell: Float64Array;
  levels?: { poc: number; vah: number; val: number } | null;
  partial?: boolean;
  tpo?: TpoData | null;
}

export interface TpoBracketData {
  start: number;
  letter: number;
  lowTick: number;
  highTick: number;
}

export interface TpoData {
  minutes: number;
  brackets: readonly TpoBracketData[];
  ibFrom: number | null;
  ibLowTick: number | null;
  ibHighTick: number | null;
}

export interface ProfileSource {
  periods(period: ProfilePeriod, hours?: ProfileHours, tpoMinutes?: number): readonly SessionProfileData[];
  composite(n: number, period: ProfilePeriod, hours: ProfileHours): SessionProfileData | null;
  span(from: number, to: number | null, hours: ProfileHours): SessionProfileData | null;
}

export function shownSessions(sessions: readonly SessionProfileData[], count: number): readonly SessionProfileData[] {
  let period = -1;
  const periods = sessions.map((s, k) => {
    const prev = sessions[k - 1];
    if (!prev || !partsOfOnePeriod(prev, s)) period++;
    return period;
  });
  const first = period - Math.max(1, count) + 1;
  return sessions.filter((_, k) => periods[k]! >= first);
}

function partsOfOnePeriod(eth: SessionProfileData, rth: SessionProfileData): boolean {
  return eth.to === rth.from && eth.label.endsWith(' ETH') && rth.label === `${sessionOf(eth)} RTH`;
}

function sessionOf(s: SessionProfileData): string {
  return s.label.replace(/ (RTH|ETH)$/, '');
}

interface BarsOver {
  first: number;
  last: number;
}

export function barEnd(store: RenderContext['store'], i: number, timeframeMs: number): number {
  const t = store.time[i]!;
  const next = i + 1 < store.length ? store.time[i + 1]! : Infinity;
  return Math.min(next, t + timeframeMs);
}

export function barsOver(
  store: RenderContext['store'],
  timeframeMs: number,
  from: number,
  to: number,
): BarsOver | null {
  const n = store.length;
  if (n === 0 || !(to > from)) return null;
  let first = store.indexAtOrBefore(from);
  if (first < 0) first = 0;
  else if (barEnd(store, first, timeframeMs) <= from) first++;
  const last = store.indexAtOrBefore(Math.min(to, Number.MAX_SAFE_INTEGER) - 1);
  if (first >= n || last < first) return null;
  return { first, last };
}

export interface ProfileStyle {
  poc: PlotStyle;
  vah: PlotStyle;
  val: PlotStyle;
}

export interface VolumeProfileLayerOptions {
  id: string;
  grid: TickGrid;
  options?: Partial<ProfileOptions>;
  style: ProfileStyle;
  z?: number;
  owner?: string | null;
  visible?: boolean;
}

interface DrawnProfile {
  rowTicks: number;
  lowTick: number;
  rows: number;
  volume: Float64Array;
  buy: Float64Array;
  sell: Float64Array;
  max: number;
  maxDelta: number;
  poc: number;
  val: number;
  vah: number;
}

interface Placement {
  share: number;
  cap: number;
  overSeries: boolean;
}

const PERIOD_PLACEMENT: Placement = { share: 0.3, cap: 240, overSeries: false };
const RANGE_PLACEMENT: Placement = { share: 0.7, cap: Infinity, overSeries: true };
const PLACED_MIN = 24;
const STRIP_SHARE = 0.16;
const STRIP_MIN = 72;
const STRIP_MAX = 160;
const LABEL_H = 14;
const GUTTER_GAP = 6;
const DELTA_BESIDE_FROM = 0.7;
const VOLUME_BESIDE_SHARE = 0.65;

interface Placed {
  x0: number;
  x1: number;
  s: SessionProfileData;
}

export class VolumeProfileLayer implements Layer, FlowReadout, AskSource {
  readonly id: string;
  readonly kind = 'study' as const;
  readonly surface = 'underlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = 'Tessera';
  readonly owner: string | null;
  readonly visible: boolean;
  readonly state = new FlowState();
  options: ProfileOptions;
  style: ProfileStyle;
  grid: TickGrid;
  needFrom: number | null = null;
  private source: ProfileSource | null = null;
  private gaps: readonly TimeSpan[] = NO_GAPS;
  private footprints: FootprintStore | null = null;
  private host: LayerHost | null = null;
  private visibleSpan: { from: number; to: number | null } | null = null;
  private readonly merged = new WeakMap<SessionProfileData, { key: string; p: DrawnProfile }>();
  private developing: { key: string; lines: Map<number, DevelopingLines> } | null = null;
  private readonly measurer = new TextMeasurer();
  private lastRc: RenderContext | null = null;
  private lastStrip: { x0: number; x1: number; p: DrawnProfile; s: SessionProfileData } | null = null;
  private lastSessions: Placed[] = [];
  private placed: Rect | null = null;
  private drawn: RenderedProfileInfo[] = [];
  private naked: {
    key: string;
    sessions: readonly SessionProfileData[];
    lines: { price: number; label: string; x0: number }[];
  } | null = null;

  constructor(o: VolumeProfileLayerOptions) {
    this.id = o.id;
    this.grid = o.grid;
    this.z = o.z ?? 4;
    this.owner = o.owner ?? null;
    this.visible = o.visible ?? true;
    this.options = { ...DEFAULT_PROFILE, ...o.options };
    this.style = o.style;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
    this.drawn = [];
  }

  setSource(source: ProfileSource | null): void {
    this.source = source;
    this.drawn = [];
    this.host?.invalidate('data');
  }

  setFootprints(store: FootprintStore | null): void {
    if (store === this.footprints) return;
    this.footprints = store;
    this.developing = null;
    this.host?.invalidate('data');
  }

  setOptions(o: Partial<ProfileOptions>, style?: ProfileStyle): void {
    this.options = { ...this.options, ...o };
    if (style) this.style = style;
    this.developing = null;
    this.host?.invalidate();
  }

  dataChanged(): void {
    this.host?.invalidate('data');
  }

  noteChanged(): void {
    this.host?.invalidate();
  }

  onViewSettled(): void {
    const rc = this.lastRc;
    const o = this.options;
    if (!rc || !(o.period === 'visible' || (placedOver(o.period) && o.from === null))) return;
    const span = viewSpan(rc);
    const held = this.visibleSpan;
    if (span && held?.from === span.from && held.to === span.to) return;
    this.visibleSpan = span;
    this.host?.invalidate('data');
  }

  setGaps(gaps: readonly TimeSpan[]): void {
    if (gaps === this.gaps) return;
    this.gaps = gaps;
    this.host?.invalidate('data');
  }

  legendValues(_index: number, format: PriceFormatter, theme: ChartTheme): LegendValue[] {
    const p = this.currentProfile();
    if (!p || !Number.isFinite(p.poc)) return [];
    const ink = this.style.poc.visible ? this.style.poc.color : theme.subtleText;
    const values = [{ text: `POC ${format.grouped(p.poc)}`, color: ink }];
    if (!showsDelta(this.options.show)) return values;
    const d = deltaOf(p);
    const tone = d > 0 ? theme.flow.deltaUp : d < 0 ? theme.flow.deltaDown : theme.subtleText;
    return [...values, { text: `Δ ${signedCount(d)}`, color: tone }];
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
    const o = this.options;
    return o.period === 'composite' ? periodCount(o.length, o.compositePeriod) : '';
  }

  rendered(): readonly RenderedProfileInfo[] {
    return this.drawn;
  }

  aggressorNote(): string | null {
    return this.state.aggressor;
  }

  optionNotes(): Readonly<Record<string, string>> | null {
    return this.options.notes;
  }

  private onePartHours(): 'all' | 'rth' {
    return this.options.hours === 'rth' ? 'rth' : 'all';
  }

  private periodList(hours: ProfileHours): readonly SessionProfileData[] {
    const period = periodOf(this.options.period);
    return period ? (this.source?.periods(period, hours) ?? []) : [];
  }

  private taggedSessions(): readonly SessionProfileData[] {
    return this.periodList(this.onePartHours());
  }

  private placedSpan(rc: RenderContext): { s: SessionProfileData; to: number } | null {
    const o = this.options;
    if (!placedOver(o.period)) return null;
    const view = o.from === null ? this.settledView(rc) : null;
    const from = o.from ?? view?.from ?? null;
    if (from === null) return null;
    const to = o.period === 'anchored' ? null : o.from === null ? (view?.to ?? null) : o.to;
    if (to !== null && to <= from) return null;
    const s = this.source?.span(from, to, this.onePartHours()) ?? null;
    return s ? { s: { ...s, label: PLACED_LABEL[o.period] }, to: to ?? Infinity } : null;
  }

  private settledView(rc: RenderContext): { from: number; to: number | null } | null {
    this.visibleSpan ??= viewSpan(rc);
    return this.visibleSpan;
  }

  private stripSpan(rc: RenderContext): SessionProfileData | null {
    const o = this.options;
    if (o.period === 'composite') return this.composite();
    if (o.period !== 'visible') return null;
    const v = this.settledView(rc);
    return v ? (this.source?.span(v.from, v.to, this.onePartHours()) ?? null) : null;
  }

  private currentProfile(): DrawnProfile | null {
    const o = this.options;
    if (!periodOf(o.period)) {
      if (this.lastStrip) return this.lastStrip.p;
      const placed = this.lastSessions[0];
      return placed ? this.mergedProfile(placed.s, placed.s.rowTicks) : null;
    }
    const sessions = this.taggedSessions();
    const rc = this.lastRc;
    const n = rc?.store.length ?? 0;
    const t = rc && n > 0 ? rc.store.time[n - 1] : undefined;
    const bar = rc && t !== undefined ? { from: t, to: barEnd(rc.store, n - 1, rc.timeframeMs) } : null;
    if (bar && !this.periodList('all').some((s) => s.from < bar.to && bar.from < s.to)) return null;
    const s = bar ? sessions.findLast((x) => x.from < bar.to) : sessions.at(-1);
    if (!s) return null;
    return this.mergedProfile(s, rc ? this.rowTicksFor(rc) : s.rowTicks);
  }

  private tickPx(rc: RenderContext): number {
    return Math.abs(rc.mainPrice.yOf(0) - rc.mainPrice.yOf(this.grid.tick));
  }

  private rowTicksFor(rc: RenderContext, base = 1): number {
    const r = this.options.rowTicks;
    if (r !== 'auto') return Math.max(base, Math.round(r));
    return autoRowTicks(this.tickPx(rc), 2, base);
  }

  private mergedProfile(s: SessionProfileData, rowTicks: number): DrawnProfile {
    const size = Math.max(1, Math.ceil(rowTicks / s.rowTicks) * s.rowTicks);
    const share = this.options.valueArea;
    const key = `${String(size)}|${String(share)}|${String(s.rows)}|${String(totalOf(s.volume))}|${s.levels ? `${String(s.levels.poc)},${String(s.levels.vah)},${String(s.levels.val)}` : ''}`;
    const held = this.merged.get(s);
    if (held?.key === key) return held.p;
    const p = merge(s, size, share, this.grid);
    this.merged.set(s, { key, p });
    return p;
  }

  gutter(rc: RenderContext): number {
    if (!rc.seriesReplaced || !periodOf(this.options.period) || !this.gutterSession(rc)) return 0;
    return Math.round(Math.min(STRIP_MAX, Math.max(STRIP_MIN, STRIP_SHARE * rc.layout.main.w)));
  }

  private gutterSession(rc: RenderContext): SessionProfileData | null {
    const { time, store } = rc;
    const n = store.length;
    if (n === 0 || time.to < time.from) return null;
    const last = Math.min(time.to, n - 1);
    const t0 = store.time[time.from]!;
    const t1 = barEnd(store, last, rc.timeframeMs);
    const sessions = this.shown(rc);
    for (let k = sessions.length - 1; k >= 0; k--) {
      const s = sessions[k]!;
      if (s.rows > 0 && s.to > t0 && s.from < t1) return s;
    }
    return null;
  }

  labelClaims(rc: RenderContext): readonly LabelClaim[] {
    const out: LabelClaim[] = [];
    for (const l of this.edgeLabels(rc)) out.push({ y: l.y, h: LABEL_H, edge: 'right' });
    return out;
  }

  draw(rc: RenderContext): void {
    this.lastRc = rc;
    this.drawn = [];
    const { ctx, pane } = rc;
    if (rc.time.to < rc.time.from) return;
    this.needFrom = rc.store.time[rc.time.from] ?? null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    if (this.state.stopped) ctx.globalAlpha = STOPPED_ALPHA;
    this.lastSessions = [];
    this.placed = null;
    this.lastStrip = null;
    const o = this.options;
    const byPeriod = periodOf(o.period) !== null;
    if (byPeriod) {
      for (const s of this.shown(rc)) this.drawPlaced(rc, s, PERIOD_PLACEMENT);
    } else if (placedOver(o.period)) {
      const placed = this.placedSpan(rc);
      if (placed) this.drawPlaced(rc, placed.s, RANGE_PLACEMENT, placed.to);
    } else {
      const s = this.stripSpan(rc);
      if (s) this.drawStrip(rc, s);
    }
    if (o.priorVa && byPeriod) this.drawPrior(rc);
    if (o.nakedPocs && byPeriod) this.drawNaked(rc);
    this.drawEdgeLabels(rc);
    ctx.restore();
    if (rc.gutter && byPeriod) this.drawGutter(rc, rc.gutter);
    this.addTags(rc);
  }

  private note(label: string, from: number, to: number, p: DrawnProfile, partial: boolean): void {
    const fin = (v: number) => (Number.isFinite(v) ? v : null);
    this.drawn.push({
      label,
      from,
      to,
      poc: fin(p.poc),
      vah: fin(p.vah),
      val: fin(p.val),
      volume: totalOf(p.volume),
      delta: deltaOf(p),
      partial,
    });
  }

  private priorLines(): { prior: DrawnProfile; from: number } | null {
    const sessions = this.taggedSessions();
    const newest = sessions.at(-1);
    const prior = sessions.at(-2);
    if (!newest || !prior) return null;
    return { prior: this.mergedProfile(prior, prior.rowTicks), from: newest.from };
  }

  private drawPrior(rc: RenderContext): void {
    const held = this.priorLines();
    if (!held) return;
    const { time, pane } = rc;
    const bars = barsOver(rc.store, rc.timeframeMs, held.from, Infinity);
    if (!bars) return;
    const x0 = Math.max(pane.x, time.xOfIndex(bars.first) - time.barSpacing / 2);
    const dashed = (st: PlotStyle): PlotStyle => ({ ...st, line: 'dash', opacity: st.opacity * 0.8 });
    this.hline(rc, held.prior.poc, x0, pane.x + pane.w, dashed(this.style.poc));
    this.hline(rc, held.prior.vah, x0, pane.x + pane.w, dashed(this.style.vah));
    this.hline(rc, held.prior.val, x0, pane.x + pane.w, dashed(this.style.val));
  }

  private drawGutter(rc: RenderContext, gutter: Rect): void {
    const s = this.gutterSession(rc);
    if (!s) return;
    const { ctx } = rc;
    ctx.save();
    ctx.beginPath();
    ctx.rect(gutter.x, gutter.y, gutter.w, gutter.h);
    ctx.clip();
    if (this.state.stopped) ctx.globalAlpha = STOPPED_ALPHA;
    const p = this.mergedProfile(s, this.rowTicksFor(rc, s.rowTicks));
    const bars = this.drawHistogram(rc, p, gutter.x, gutter.w - GUTTER_GAP, 'right');
    const lines = this.drawLines(rc, p, gutter.x, gutter.x + gutter.w);
    ctx.restore();
    this.lastSessions.push({ x0: gutter.x, x1: gutter.x + gutter.w, s });
    if ((bars || lines) && !this.drawn.some((d) => d.from === s.from && d.label === s.label))
      this.note(s.label, s.from, s.to, p, s.partial === true);
  }

  private composite(): SessionProfileData | null {
    const o = this.options;
    return this.source?.composite(o.length, o.compositePeriod, this.onePartHours()) ?? null;
  }

  private shown(rc: RenderContext): readonly SessionProfileData[] {
    const end = viewEnd(rc);
    const upToView = this.periodList(this.options.hours).filter((s) => s.from < end);
    return shownSessions(upToView, this.options.length);
  }

  placedBox(): Rect | null {
    return this.placed;
  }

  private boxOf(rc: RenderContext, p: DrawnProfile, left: number, right: number): Rect | null {
    if (p.rows === 0) return null;
    const grid = this.grid;
    const top = rc.mainPrice.yOf(grid.toPrice(p.lowTick + p.rows * p.rowTicks) - grid.tick / 2);
    const bottom = rc.mainPrice.yOf(grid.toPrice(p.lowTick) - grid.tick / 2);
    const y0 = Math.max(rc.pane.y, Math.min(top, bottom));
    const y1 = Math.min(rc.pane.y + rc.pane.h, Math.max(top, bottom));
    return y1 > y0 && right > left ? { x: left, y: y0, w: right - left, h: y1 - y0 } : null;
  }

  private drawPlaced(rc: RenderContext, s: SessionProfileData, place: Placement, to = s.to): void {
    const { time, store } = rc;
    const n = store.length;
    if (n === 0) return;
    const bars = barsOver(store, rc.timeframeMs, s.from, to);
    if (!bars || bars.last < time.from || bars.first > time.to) return;
    const x0 = time.xOfIndex(bars.first) - time.barSpacing / 2;
    const x1 = time.xOfIndex(bars.last) + time.barSpacing / 2;
    const left = Math.max(x0, rc.pane.x);
    const right = Math.min(x1, rc.pane.x + rc.pane.w);
    const span = right - left;
    const fitted = place.share * (x1 - x0);
    const width = Math.min(span, place.cap, Math.max(PLACED_MIN, fitted));
    if (width < 2) return;
    const atEnd = this.options.side === 'right' && place === PERIOD_PLACEMENT;
    const anchor = atEnd ? right : left;
    const p = this.mergedProfile(s, this.rowTicksFor(rc, s.rowTicks));
    const histogram = place.overSeries || !rc.seriesReplaced;
    const rows = histogram && this.drawHistogram(rc, p, anchor, width, atEnd ? 'left' : 'right');
    const lines = this.drawLines(rc, p, x0, this.options.extendLines ? rc.pane.x + rc.pane.w : x1);
    if (this.options.developingPoc || this.options.developingVa) {
      this.drawDeveloping(rc, s, bars.first, bars.last);
      this.needFrom = Math.min(this.needFrom ?? Infinity, s.from);
    }
    if (rows || lines) this.note(s.label, s.from, s.to, p, s.partial === true);
    if (histogram) this.lastSessions.push({ x0: atEnd ? anchor - width : anchor, x1: atEnd ? anchor : x1, s });
    if (place === RANGE_PLACEMENT) this.placed = this.boxOf(rc, p, left, right);
  }

  private drawStrip(rc: RenderContext, s: SessionProfileData): void {
    const { pane } = rc;
    const p = this.mergedProfile(s, this.rowTicksFor(rc, s.rowTicks));
    if (!(p.max > 0)) return;
    const width = Math.min(STRIP_MAX, Math.max(STRIP_MIN, STRIP_SHARE * pane.w));
    const right = pane.x + pane.w;
    const bars = this.drawHistogram(rc, p, right, width, 'left');
    const lines = this.drawLines(rc, p, right - width, right);
    this.lastStrip = { x0: right - width, x1: right, p, s };
    if (!bars && !lines) return;
    const o = this.options;
    const label = o.period === 'composite' ? periodCount(o.length, o.compositePeriod) : 'Visible';
    this.note(label, s.from, s.to, p, s.partial === true);
  }

  private drawHistogram(
    rc: RenderContext,
    p: DrawnProfile,
    anchor: number,
    width: number,
    dir: 'left' | 'right',
  ): boolean {
    const { ctx, mainPrice, dpr, pane } = rc;
    if (!(p.max > 0)) return false;
    const grid = this.grid;
    const px = 1 / dpr;
    const show = this.options.show;
    const fills = { bar: new Rects(), va: new Rects(), poc: new Rects(), up: new Rects(), down: new Rects() };
    const vaLow = grid.toTick(p.val);
    const vaHigh = grid.toTick(p.vah);
    const pocTick = floorDiv(grid.toTick(p.poc), p.rowTicks) * p.rowTicks;
    const put = (rects: Rects, from: number, len: number, y: number, h: number) => {
      if (len <= 0) return;
      if (dir === 'right') rects.add(anchor + from, y, len, h);
      else rects.add(anchor - from - len, y, len, h);
    };
    const volumeWidth = show === 'volumeDelta' ? width * VOLUME_BESIDE_SHARE : width;
    const deltaFrom = show === 'volumeDelta' ? width * DELTA_BESIDE_FROM : 0;
    const deltaWidth = width - deltaFrom;
    for (let r = 0; r < p.rows; r++) {
      const v = p.volume[r]!;
      if (v <= 0) continue;
      const low = p.lowTick + r * p.rowTicks;
      const yTop = snap(mainPrice.yOf(grid.toPrice(low + p.rowTicks) - grid.tick / 2), dpr);
      const yBot = snap(mainPrice.yOf(grid.toPrice(low) - grid.tick / 2), dpr);
      if (yBot < pane.y || yTop > pane.y + pane.h) continue;
      const h = Math.max(px, yBot - yTop - (yBot - yTop >= 3 ? px : 0));
      if (show === 'split') {
        const b = (p.buy[r]! / p.max) * width;
        const s = (p.sell[r]! / p.max) * width;
        put(fills.up, 0, b, yTop, h);
        put(fills.down, b, s, yTop, h);
        continue;
      }
      if (show === 'volume' || show === 'volumeDelta') {
        const len = Math.max(px, (v / p.max) * volumeWidth);
        const inVa = low + p.rowTicks - 1 >= vaLow && low <= vaHigh;
        put(low === pocTick ? fills.poc : inVa ? fills.va : fills.bar, 0, len, yTop, h);
      }
      if (showsDelta(show)) {
        const d = p.buy[r]! - p.sell[r]!;
        const len = rowDeltaLength(d, p);
        if (len > 0) put(d > 0 ? fills.up : fills.down, deltaFrom, Math.max(px, len * deltaWidth), yTop, h);
      }
    }
    const fl = rc.theme.flow;
    fills.bar.fill(ctx, fl.profileBar);
    fills.va.fill(ctx, fl.profileValueArea);
    fills.poc.fill(ctx, fl.profilePoc);
    fills.up.fill(ctx, fl.profileBuy);
    fills.down.fill(ctx, fl.profileSell);
    if (this.options.nodes) this.drawNodes(rc, p, anchor, width, dir);
    return Object.values(fills).some((r) => r.size > 0);
  }

  private drawNodes(rc: RenderContext, p: DrawnProfile, anchor: number, width: number, dir: 'left' | 'right'): void {
    const { ctx, mainPrice, dpr, pane } = rc;
    const grid = this.grid;
    const { hvn, lvn } = volumeNodes(p.volume.subarray(0, p.rows));
    const x0 = dir === 'right' ? anchor : anchor - width;
    const x1 = dir === 'right' ? anchor + width : anchor;
    const g = ctx.globalAlpha;
    ctx.lineWidth = 1 / dpr;
    for (const [rows, color, dash] of [
      [hvn, rc.theme.flow.profilePoc, [] as number[]],
      [lvn, rc.theme.mutedText, [2, 3]],
    ] as const) {
      ctx.beginPath();
      for (const r of rows) {
        const mid = grid.toPrice(p.lowTick + r * p.rowTicks) + ((p.rowTicks - 1) * grid.tick) / 2;
        const y = snap(mainPrice.yOf(mid), dpr) + 0.5 / dpr;
        if (y < pane.y || y > pane.y + pane.h) continue;
        ctx.moveTo(Math.max(pane.x, x0), y);
        ctx.lineTo(Math.min(pane.x + pane.w, x1), y);
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = g;
      ctx.setLineDash(dash);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  private drawLines(rc: RenderContext, p: DrawnProfile, x0: number, x1: number): boolean {
    const poc = this.hline(rc, p.poc, x0, x1, this.style.poc);
    const vah = this.hline(rc, p.vah, x0, x1, this.style.vah);
    const val = this.hline(rc, p.val, x0, x1, this.style.val);
    return poc || vah || val;
  }

  private hline(rc: RenderContext, price: number, x0: number, x1: number, st: PlotStyle): boolean {
    return levelLine(rc, price, x0, x1, st);
  }

  private drawDeveloping(rc: RenderContext, s: SessionProfileData, first: number, last: number): void {
    const store = this.footprints;
    if (!store) return;
    const share = this.options.valueArea;
    const key = `${String(store.generation)}|${String(store.version >> 4)}|${String(share)}`;
    if (this.developing?.key !== key) this.developing = { key, lines: new Map() };
    let lines = this.developing.lines.get(s.from);
    if (!lines) {
      const bars = [];
      for (let i = first; i <= last; i++) {
        const b = store.get(rc.store.time[i]!);
        bars.push(b && b.rows > 0 ? store.view(b, b.baseTicks) : null);
      }
      lines = developingLines(bars, share, this.grid);
      this.developing.lines.set(s.from, lines);
    }
    const o = this.options;
    if (o.developingPoc) this.trace(rc, lines.poc, first, last, this.style.poc);
    if (o.developingVa) {
      this.trace(rc, lines.vah, first, last, this.style.vah);
      this.trace(rc, lines.val, first, last, this.style.val);
    }
  }

  private trace(rc: RenderContext, line: Float64Array, first: number, last: number, st: PlotStyle): void {
    const { ctx, time, mainPrice, dpr } = rc;
    const g = ctx.globalAlpha;
    ctx.strokeStyle = st.color;
    ctx.globalAlpha = g * st.opacity * 0.5;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    let pen = false;
    for (let i = Math.max(first, time.from - 1); i <= Math.min(last, time.to); i++) {
      const v = line[i - first]!;
      if (Number.isNaN(v)) {
        pen = false;
        continue;
      }
      const y = snap(mainPrice.yOf(v), dpr) + 0.5 / dpr;
      const xl = time.xOfIndex(i) - time.barSpacing / 2;
      if (pen) ctx.lineTo(xl, y);
      else ctx.moveTo(xl, y);
      ctx.lineTo(xl + time.barSpacing, y);
      pen = true;
    }
    ctx.stroke();
    ctx.globalAlpha = g;
  }

  private nakedLines(rc: RenderContext): { price: number; label: string; x0: number }[] {
    const sessions = this.taggedSessions();
    const { store, time } = rc;
    const n = store.length;
    const key = `${String(n)}|${String(n ? store.high[n - 1] : 0)}|${String(n ? store.low[n - 1] : 0)}|${String(sessions.length)}|${String(sessions[0]?.from ?? 0)}|${String(time.from)}|${String(time.barSpacing)}`;
    if (this.naked?.key === key && this.naked.sessions === sessions) return this.naked.lines;
    const lines = this.readNaked(rc, sessions);
    this.naked = { key, sessions, lines };
    return lines;
  }

  private readNaked(
    rc: RenderContext,
    sessions: readonly SessionProfileData[],
  ): { price: number; label: string; x0: number }[] {
    const { store, time } = rc;
    const grid = this.grid;
    const pocs = [];
    for (let k = 0; k < sessions.length - 1; k++) {
      const s = sessions[k]!;
      const p = this.mergedProfile(s, s.rowTicks);
      if (!Number.isFinite(p.poc)) continue;
      const lastBar = store.indexAtOrBefore(s.to - 1);
      if (lastBar < 0) continue;
      pocs.push({ tick: grid.toTick(p.poc), rowTicks: 1, lastBar, label: s.label });
    }
    const naked = nakedPocs(
      pocs,
      {
        length: store.length,
        lowTick: (i) => grid.toTick(store.low[i]!),
        highTick: (i) => grid.toTick(store.high[i]!),
      },
      5,
    );
    return naked.map((p) => ({
      price: grid.toPrice(p.tick),
      label: `nPOC ${p.label}`,
      x0: time.xOfIndex(p.lastBar) + time.barSpacing / 2,
    }));
  }

  private drawNaked(rc: RenderContext): void {
    const { pane } = rc;
    const st: PlotStyle = {
      color: rc.theme.mutedText,
      downColor: null,
      width: 1,
      line: 'dot',
      opacity: 1,
      visible: true,
    };
    for (const l of this.nakedLines(rc)) this.hline(rc, l.price, Math.max(pane.x, l.x0), pane.x + pane.w, st);
  }

  private edgeLabels(rc: RenderContext): { y: number; text: string; color: string; price: number }[] {
    const out: { y: number; text: string; color: string; price: number }[] = [];
    const p = this.taggedProfile(rc);
    const { mainPrice, pane } = rc;
    const push = (price: number, text: string, color: string) => {
      if (!Number.isFinite(price)) return;
      const y = mainPrice.yOf(price);
      if (y < pane.y + LABEL_H / 2 || y > pane.y + pane.h - LABEL_H / 2) return;
      out.push({ y, text, color, price });
    };
    if (p) {
      if (this.style.poc.visible) push(p.poc, 'POC', this.style.poc.color);
      if (this.style.vah.visible) push(p.vah, 'VAH', rc.theme.mutedText);
      if (this.style.val.visible) push(p.val, 'VAL', rc.theme.mutedText);
    }
    const byPeriod = periodOf(this.options.period) !== null;
    const prior = this.options.priorVa && byPeriod ? this.priorLines() : null;
    if (prior) {
      if (this.style.poc.visible) push(prior.prior.poc, 'pPOC', rc.theme.mutedText);
      if (this.style.vah.visible) push(prior.prior.vah, 'pVAH', rc.theme.mutedText);
      if (this.style.val.visible) push(prior.prior.val, 'pVAL', rc.theme.mutedText);
    }
    if (this.options.nakedPocs && byPeriod)
      for (const l of this.nakedLines(rc)) push(l.price, l.label, rc.theme.mutedText);
    return out;
  }

  private taggedProfile(rc: RenderContext): DrawnProfile | null {
    if (!periodOf(this.options.period)) {
      if (this.lastStrip) return this.lastStrip.p;
      const placed = this.lastSessions[0];
      return placed ? this.mergedProfile(placed.s, this.rowTicksFor(rc, placed.s.rowTicks)) : null;
    }
    const sessions = this.taggedSessions();
    const last = sessions[sessions.length - 1];
    const n = rc.store.length;
    if (!last || n === 0) return null;
    const lastBar = rc.store.time[n - 1]!;
    if (barEnd(rc.store, n - 1, rc.timeframeMs) <= last.from || lastBar >= last.to) return null;
    return this.mergedProfile(last, this.rowTicksFor(rc, last.rowTicks));
  }

  private drawEdgeLabels(rc: RenderContext): void {
    const { ctx, pane, theme } = rc;
    const labels = this.edgeLabels(rc);
    if (labels.length === 0) return;
    const f = font(theme.fontSize, theme.font);
    ctx.font = f;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const right = pane.x + pane.w - 6;
    for (const l of labels) {
      const w = this.measurer.measure(ctx, f, l.text);
      ctx.fillStyle = theme.background;
      ctx.globalAlpha = 0.72;
      ctx.fillRect(right - w - 4, l.y - LABEL_H / 2, w + 8, LABEL_H);
      ctx.globalAlpha = 1;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, right, l.y);
    }
    ctx.textAlign = 'left';
  }

  private addTags(rc: RenderContext): void {
    for (const l of this.edgeLabels(rc)) {
      rc.addAxisTag({
        price: l.price,
        text: rc.format.grouped(l.price),
        style: 'outline',
        color: l.color,
        priority: 15,
        dashed: l.text !== 'POC',
      });
    }
  }

  askTarget(x: number, y: number): AskTarget | null {
    const rc = this.lastRc;
    if (!rc) return null;
    const price = rc.mainPrice.priceOf(y);
    const strip = this.lastStrip;
    if (strip && x >= strip.x0 && x <= strip.x1) return this.target(strip.p, price, strip.s);
    for (const s of this.lastSessions) {
      if (x < s.x0 || x > s.x1) continue;
      const t = this.target(this.mergedProfile(s.s, s.s.rowTicks), price, s.s);
      if (t) return t;
    }
    return null;
  }

  private target(p: DrawnProfile, price: number, s: SessionProfileData): AskTarget | null {
    const low = this.grid.toPrice(p.lowTick);
    const high = this.grid.toPrice(p.lowTick + p.rows * p.rowTicks - 1);
    if (price < low || price > high) return null;
    const fmt = (v: number) => this.grid.toPrice(this.grid.toTick(v)).toFixed(this.grid.decimals);
    return {
      kind: 'profile',
      label: KIND_WORDS[this.options.period],
      from: s.from,
      to: s.to,
      low,
      high,
      detail: `POC ${fmt(p.poc)}, VAH ${fmt(p.vah)}, VAL ${fmt(p.val)}, volume ${formatCount(totalOf(p.volume))}, delta ${signedCount(deltaOf(p))}`,
    };
  }
}

export interface DevelopingLines {
  poc: Float64Array;
  vah: Float64Array;
  val: Float64Array;
}

export interface DevelopingBar {
  lowTick: number;
  rowTicks: number;
  rows: number;
  bid: ArrayLike<number>;
  ask: ArrayLike<number>;
}

export function developingLines(
  bars: readonly (DevelopingBar | null)[],
  share: number,
  grid: TickGrid,
): DevelopingLines {
  const n = bars.length;
  const out = {
    poc: new Float64Array(n).fill(Number.NaN),
    vah: new Float64Array(n).fill(Number.NaN),
    val: new Float64Array(n).fill(Number.NaN),
  };
  const acc = new ProfileAccumulator(1);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (b) acc.addRows(b.lowTick, b.rowTicks, b.rows, b.bid, b.ask);
    if (acc.rows === 0) continue;
    const vol = new Float64Array(acc.rows);
    for (let r = 0; r < acc.rows; r++) vol[r] = acc.buy[r]! + acc.sell[r]!;
    const poc = pointOfControl(vol);
    const [a, z] = valueAreaBand(vol, poc, share);
    out.poc[i] = grid.toPrice(acc.lowTick + poc);
    out.val[i] = grid.toPrice(acc.lowTick + a);
    out.vah[i] = grid.toPrice(acc.lowTick + z);
  }
  return out;
}

export function levelLine(rc: RenderContext, price: number, x0: number, x1: number, st: PlotStyle): boolean {
  if (!st.visible || !Number.isFinite(price)) return false;
  const { ctx, mainPrice, dpr, pane } = rc;
  const y = snap(mainPrice.yOf(price), dpr) + 0.5 / dpr;
  if (y < pane.y || y > pane.y + pane.h) return false;
  if (Math.max(x0, x1) < pane.x || Math.min(x0, x1) > pane.x + pane.w) return false;
  const g = ctx.globalAlpha;
  ctx.strokeStyle = st.color;
  ctx.globalAlpha = g * st.opacity;
  ctx.lineWidth = st.width <= 1 ? 1 / dpr : st.width;
  ctx.setLineDash(st.line === 'dot' ? [2, 3] : dashOf(st.line, st.width));
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = g;
  return true;
}

export function rowDeltaLength(delta: number, p: { maxDelta: number }): number {
  return delta === 0 || !(p.maxDelta > 0) ? 0 : Math.abs(delta) / p.maxDelta;
}

export function viewEnd(rc: RenderContext): number {
  const { store, time } = rc;
  const n = store.length;
  return n === 0 ? Infinity : barEnd(store, Math.min(Math.max(time.to, 0), n - 1), rc.timeframeMs);
}

function viewSpan(rc: RenderContext): { from: number; to: number | null } | null {
  const { store, time } = rc;
  const n = store.length;
  if (n === 0 || time.to < time.from) return null;
  const last = Math.min(time.to, n - 1);
  const from = store.time[Math.max(0, time.from)]!;
  return { from, to: last === n - 1 ? null : barEnd(store, last, rc.timeframeMs) };
}

function totalOf(a: Float64Array): number {
  let t = 0;
  for (const v of a) t += v;
  return t;
}

function deltaOf(p: { buy: Float64Array; sell: Float64Array }): number {
  return totalOf(p.buy) - totalOf(p.sell);
}

function merge(s: SessionProfileData, size: number, share: number, grid: TickGrid): DrawnProfile {
  let volume = s.volume;
  let buy = s.buy;
  let sell = s.sell;
  let lowTick = s.lowTick;
  let rows = s.rows;
  if (size !== s.rowTicks && s.rows > 0) {
    lowTick = floorDiv(s.lowTick, size) * size;
    const top = floorDiv(s.lowTick + (s.rows - 1) * s.rowTicks, size) * size;
    rows = (top - lowTick) / size + 1;
    volume = new Float64Array(rows);
    buy = new Float64Array(rows);
    sell = new Float64Array(rows);
    for (let r = 0; r < s.rows; r++) {
      const k = (floorDiv(s.lowTick + r * s.rowTicks, size) * size - lowTick) / size;
      volume[k] = volume[k]! + s.volume[r]!;
      buy[k] = buy[k]! + s.buy[r]!;
      sell[k] = sell[k]! + s.sell[r]!;
    }
  }
  let max = 0;
  let maxDelta = 0;
  for (let r = 0; r < rows; r++) {
    max = Math.max(max, volume[r]!);
    maxDelta = Math.max(maxDelta, Math.abs(buy[r]! - sell[r]!));
  }
  let poc = Number.NaN;
  let val = Number.NaN;
  let vah = Number.NaN;
  if (s.levels && Math.abs(share - 0.7) < 1e-9) {
    ({ poc, val, vah } = s.levels);
  } else if (s.rows > 0 && totalOf(s.volume) > 0) {
    const pi = pointOfControl(s.volume);
    const [a, b] = valueAreaBand(s.volume, pi, share);
    poc = grid.toPrice(s.lowTick + pi * s.rowTicks);
    val = grid.toPrice(s.lowTick + a * s.rowTicks);
    vah = grid.toPrice(s.lowTick + b * s.rowTicks + s.rowTicks - 1);
  }
  return { rowTicks: size, lowTick, rows, volume, buy, sell, max, maxDelta, poc, val, vah };
}

class Rects {
  private readonly r: number[] = [];

  add(x: number, y: number, w: number, h: number): void {
    this.r.push(x, y, w, h);
  }

  get size(): number {
    return this.r.length / 4;
  }

  fill(ctx: CanvasRenderingContext2D, color: string): void {
    if (this.r.length === 0) return;
    ctx.beginPath();
    for (let k = 0; k < this.r.length; k += 4) ctx.rect(this.r[k]!, this.r[k + 1]!, this.r[k + 2]!, this.r[k + 3]!);
    ctx.fillStyle = color;
    ctx.fill();
  }
}
