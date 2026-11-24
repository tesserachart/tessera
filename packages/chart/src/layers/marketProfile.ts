import { pointOfControl, valueAreaBand } from '../flow/profile.ts';
import { autoRowTicks, floorDiv, type TickGrid } from '../flow/ticks.ts';
import type { PriceFormatter } from '../format.ts';
import { font, snap, TextMeasurer } from '../render/draw.ts';
import type { ChartTheme, TimeSpan } from '../types.ts';
import {
  FlowState,
  NO_GAPS,
  STOPPED_ALPHA,
  type AskSource,
  type AskTarget,
  type FlowReadout,
  type LegendNote,
  type LegendNotice,
  type LegendValue,
} from './flowReadout.ts';
import {
  barEnd,
  barsOver,
  levelLine,
  shownSessions,
  viewEnd,
  type ProfilePeriod,
  type ProfileSource,
  type ProfileStyle,
  type RenderedProfileInfo,
  type SessionProfileData,
  type TpoBracketData,
  type TpoData,
} from './profile.ts';
import type { Layer, LayerHost, RenderContext } from './types.ts';

export type TpoStyle = 'letters' | 'blocks';

export interface MarketProfileOptions {
  period: ProfilePeriod;
  length: number;
  tpo: number;
  style: TpoStyle;
  hours: 'all' | 'rth';
  valueArea: number;
  rowTicks: number | 'auto';
  ib: boolean;
  notes: Readonly<Record<string, string>> | null;
}

const DEFAULT_MARKET_PROFILE: Readonly<MarketProfileOptions> = {
  period: 'session',
  length: 5,
  tpo: 30,
  style: 'letters',
  hours: 'all',
  valueArea: 0.7,
  rowTicks: 'auto',
  ib: true,
  notes: null,
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function tpoLetter(i: number): string {
  return LETTERS[((i % LETTERS.length) + LETTERS.length) % LETTERS.length]!;
}

export interface TpoProfile {
  rowTicks: number;
  lowTick: number;
  rows: number;
  letters: readonly (readonly number[])[];
  maxCount: number;
  poc: number;
  val: number;
  vah: number;
  pocTick: number;
  valTick: number;
  vahTick: number;
  ibLow: number;
  ibHigh: number;
}

const EMPTY_LETTERS: readonly (readonly number[])[] = [];

export function tpoProfile(
  tpo: TpoData,
  baseTicks: number,
  rowTicks: number,
  share: number,
  grid: TickGrid,
): TpoProfile {
  const n = Math.max(1, Math.round(baseTicks));
  const rt = Math.max(n, Math.ceil(Math.max(1, Math.round(rowTicks)) / n) * n);
  const ib = (t: number | null) => (t === null ? Number.NaN : grid.toPrice(t));
  const out: TpoProfile = {
    rowTicks: rt,
    lowTick: 0,
    rows: 0,
    letters: EMPTY_LETTERS,
    maxCount: 0,
    poc: Number.NaN,
    val: Number.NaN,
    vah: Number.NaN,
    pocTick: Number.NaN,
    valTick: Number.NaN,
    vahTick: Number.NaN,
    ibLow: ib(tpo.ibLowTick),
    ibHigh: ib(tpo.ibHighTick),
  };
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of tpo.brackets) {
    lo = Math.min(lo, b.lowTick);
    hi = Math.max(hi, b.highTick);
  }
  if (!(hi >= lo)) return out;
  const b0 = floorDiv(lo, n);
  const counts = new Float64Array(floorDiv(hi, n) - b0 + 1);
  for (const b of tpo.brackets)
    for (let r = floorDiv(b.lowTick, n); r <= floorDiv(b.highTick, n); r++) counts[r - b0] = counts[r - b0]! + 1;
  const poc = pointOfControl(counts);
  const [a, z] = valueAreaBand(counts, poc, share);
  out.pocTick = (b0 + poc) * n;
  out.valTick = Math.max((b0 + a) * n, lo);
  out.vahTick = Math.min((b0 + z + 1) * n - 1, hi);
  out.poc = grid.toPrice(out.pocTick);
  out.val = grid.toPrice(out.valTick);
  out.vah = grid.toPrice(out.vahTick);
  const r0 = floorDiv(lo, rt);
  const rows = floorDiv(hi, rt) - r0 + 1;
  const letters: number[][] = Array.from({ length: rows }, () => []);
  for (const b of tpo.brackets)
    for (let r = floorDiv(b.lowTick, rt); r <= floorDiv(b.highTick, rt); r++) letters[r - r0]!.push(b.letter);
  out.lowTick = r0 * rt;
  out.rows = rows;
  out.letters = letters;
  out.maxCount = letters.reduce((m, l) => Math.max(m, l.length), 0);
  return out;
}

export function addTpoPrints(
  t: TpoData,
  periodFrom: number,
  prints: readonly (readonly [tick: number, ms: number])[],
): TpoData {
  if (prints.length === 0) return t;
  const len = t.minutes * 60_000;
  const brackets: TpoBracketData[] = [...t.brackets];
  let ibLowTick = t.ibLowTick;
  let ibHighTick = t.ibHighTick;
  for (const [tick, ms] of prints) {
    const last = brackets.at(-1);
    const open = last ? last.start - last.letter * len : periodFrom;
    const letter = Math.floor((ms - open) / len);
    if (letter < 0) continue;
    const start = open + letter * len;
    if (last?.start === start) {
      brackets[brackets.length - 1] = {
        ...last,
        lowTick: Math.min(last.lowTick, tick),
        highTick: Math.max(last.highTick, tick),
      };
    } else if (!last || start > last.start) {
      brackets.push({ start, letter, lowTick: tick, highTick: tick });
    }
    if (t.ibFrom !== null && ms >= t.ibFrom && ms < t.ibFrom + IB_MS) {
      ibLowTick = Math.min(ibLowTick ?? tick, tick);
      ibHighTick = Math.max(ibHighTick ?? tick, tick);
    }
  }
  return { ...t, brackets, ibLowTick, ibHighTick };
}

const IB_MS = 3_600_000;
const LETTER_ROW_PX = 12;
const LETTER_MIN_ROW_PX = 9;
const BLOCK_ROW_PX = 4;
const IB_BAR_PX = 2;
const IB_GAP_PX = 4;

export interface MarketProfileLayerOptions {
  id: string;
  grid: TickGrid;
  options?: Partial<MarketProfileOptions>;
  style: ProfileStyle;
  z?: number;
  owner?: string | null;
  visible?: boolean;
}

interface Placed {
  x0: number;
  x1: number;
  s: SessionProfileData;
  p: TpoProfile;
}

type Tone = 'out' | 'va' | 'poc';

class Marks {
  private readonly items: number[] = [];
  private readonly glyphs: string[] = [];

  rect(x: number, y: number, w: number, h: number): void {
    this.items.push(x, y, w, h);
  }

  glyph(x: number, y: number, letter: number): void {
    this.items.push(x, y);
    this.glyphs.push(tpoLetter(letter));
  }

  get size(): number {
    return this.glyphs.length + this.items.length;
  }

  fillRects(ctx: CanvasRenderingContext2D, color: string): void {
    if (this.items.length === 0) return;
    ctx.beginPath();
    for (let k = 0; k < this.items.length; k += 4)
      ctx.rect(this.items[k]!, this.items[k + 1]!, this.items[k + 2]!, this.items[k + 3]!);
    ctx.fillStyle = color;
    ctx.fill();
  }

  fillGlyphs(ctx: CanvasRenderingContext2D, color: string): void {
    ctx.fillStyle = color;
    for (let k = 0; k < this.glyphs.length; k++)
      ctx.fillText(this.glyphs[k]!, this.items[2 * k]!, this.items[2 * k + 1]!);
  }
}

export class MarketProfileLayer implements Layer, FlowReadout, AskSource {
  readonly id: string;
  readonly kind = 'study' as const;
  readonly surface = 'underlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = 'Tessera';
  readonly owner: string | null;
  readonly visible: boolean;
  readonly state = new FlowState();
  options: MarketProfileOptions;
  style: ProfileStyle;
  grid: TickGrid;
  needFrom: number | null = null;
  private source: ProfileSource | null = null;
  private gaps: readonly TimeSpan[] = NO_GAPS;
  private host: LayerHost | null = null;
  private lastRc: RenderContext | null = null;
  private placed: Placed[] = [];
  private drawn: RenderedProfileInfo[] = [];
  private readonly profiles = new WeakMap<SessionProfileData, { key: string; p: TpoProfile }>();
  private readonly measurer = new TextMeasurer();

  constructor(o: MarketProfileLayerOptions) {
    this.id = o.id;
    this.grid = o.grid;
    this.z = o.z ?? 4;
    this.owner = o.owner ?? null;
    this.visible = o.visible ?? true;
    this.options = { ...DEFAULT_MARKET_PROFILE, ...o.options };
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

  setOptions(o: Partial<MarketProfileOptions>, style?: ProfileStyle): void {
    this.options = { ...this.options, ...o };
    if (style) this.style = style;
    this.host?.invalidate();
  }

  dataChanged(): void {
    this.host?.invalidate('data');
  }

  noteChanged(): void {
    this.host?.invalidate();
  }

  setGaps(gaps: readonly TimeSpan[]): void {
    if (gaps === this.gaps) return;
    this.gaps = gaps;
    this.host?.invalidate('data');
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
    return '';
  }

  aggressorNote(): string | null {
    return null;
  }

  optionNotes(): Readonly<Record<string, string>> | null {
    return this.options.notes;
  }

  rendered(): readonly RenderedProfileInfo[] {
    return this.drawn;
  }

  legendValues(_index: number, format: PriceFormatter, theme: ChartTheme): LegendValue[] {
    const s = this.current();
    const p = s ? this.profileOf(s, s.rowTicks) : null;
    if (!p || !Number.isFinite(p.poc)) return [];
    const ink = this.style.poc.visible ? this.style.poc.color : theme.subtleText;
    return [{ text: `POC ${format.grouped(p.poc)}`, color: ink }];
  }

  private sessions(): readonly SessionProfileData[] {
    const o = this.options;
    return this.source?.periods(o.period, o.hours, o.tpo) ?? [];
  }

  private shown(rc: RenderContext): readonly SessionProfileData[] {
    const end = viewEnd(rc);
    return shownSessions(
      this.sessions().filter((s) => s.from < end && s.tpo),
      this.options.length,
    );
  }

  private current(): SessionProfileData | null {
    const sessions = this.sessions().filter((s) => s.tpo);
    const rc = this.lastRc;
    const n = rc?.store.length ?? 0;
    if (!rc || n === 0) return sessions.at(-1) ?? null;
    const end = barEnd(rc.store, n - 1, rc.timeframeMs);
    return sessions.findLast((s) => s.from < end) ?? null;
  }

  private live(rc: RenderContext): SessionProfileData | null {
    const last = this.sessions().at(-1);
    const n = rc.store.length;
    if (!last?.tpo || n === 0) return null;
    const lastBar = rc.store.time[n - 1]!;
    return barEnd(rc.store, n - 1, rc.timeframeMs) > last.from && lastBar < last.to ? last : null;
  }

  private profileOf(s: SessionProfileData, rowTicks: number): TpoProfile | null {
    const tpo = s.tpo;
    if (!tpo) return null;
    const last = tpo.brackets.at(-1);
    const key = `${String(s.rowTicks)}|${String(rowTicks)}|${String(this.options.valueArea)}|${String(tpo.brackets.length)}|${String(last?.lowTick)}|${String(last?.highTick)}|${String(tpo.ibLowTick)}|${String(tpo.ibHighTick)}`;
    const held = this.profiles.get(s);
    if (held?.key === key) return held.p;
    const p = tpoProfile(tpo, s.rowTicks, rowTicks, this.options.valueArea, this.grid);
    this.profiles.set(s, { key, p });
    return p;
  }

  private tickPx(rc: RenderContext): number {
    return Math.abs(rc.mainPrice.yOf(0) - rc.mainPrice.yOf(this.grid.tick));
  }

  private rowTicksFor(rc: RenderContext): number {
    const r = this.options.rowTicks;
    if (r !== 'auto') return Math.max(1, Math.round(r));
    return autoRowTicks(this.tickPx(rc), this.options.style === 'letters' ? LETTER_ROW_PX : BLOCK_ROW_PX);
  }

  draw(rc: RenderContext): void {
    this.lastRc = rc;
    this.drawn = [];
    this.placed = [];
    const { ctx, pane } = rc;
    if (rc.time.to < rc.time.from) return;
    this.needFrom = rc.store.time[rc.time.from] ?? null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    if (this.state.stopped) ctx.globalAlpha = STOPPED_ALPHA;
    const rowTicks = this.rowTicksFor(rc);
    for (const s of this.shown(rc)) this.drawPeriod(rc, s, rowTicks);
    ctx.restore();
    this.addTags(rc);
  }

  private drawPeriod(rc: RenderContext, s: SessionProfileData, rowTicks: number): void {
    const { ctx, time, store, mainPrice, dpr, pane, theme } = rc;
    const bars = barsOver(store, rc.timeframeMs, s.from, s.to);
    if (!bars || bars.last < time.from || bars.first > time.to) return;
    const p = this.profileOf(s, rowTicks);
    if (!p || p.rows === 0) return;
    const x0 = time.xOfIndex(bars.first) - time.barSpacing / 2;
    const x1 = time.xOfIndex(bars.last) + time.barSpacing / 2;
    const o = this.options;
    const grid = this.grid;
    const withIb = o.ib && Number.isFinite(p.ibLow) && Number.isFinite(p.ibHigh);
    const start = Math.max(x0, pane.x);
    const right = Math.min(x1, pane.x + pane.w);
    const left = start + (withIb ? IB_BAR_PX + IB_GAP_PX : 1);
    const rowPx = p.rowTicks * this.tickPx(rc);
    const size = Math.max(8, Math.min(theme.fontSize, Math.floor(rowPx) - 1));
    const f = font(size, theme.fontMono, 500);
    const glyph = this.measurer.measure(ctx, f, 'W');
    const cell = Math.min(glyph + 2, Math.max(0, right - left) / Math.max(1, p.maxCount));
    const letters = o.style === 'letters' && rowPx >= LETTER_MIN_ROW_PX && cell >= glyph;
    const px = 1 / dpr;
    const marks: Record<Tone, Marks> = { out: new Marks(), va: new Marks(), poc: new Marks() };
    const pocRow = floorDiv(p.pocTick, p.rowTicks) * p.rowTicks;
    for (let r = 0; r < p.rows; r++) {
      const row = p.letters[r]!;
      if (row.length === 0) continue;
      const low = p.lowTick + r * p.rowTicks;
      const yTop = snap(mainPrice.yOf(grid.toPrice(low + p.rowTicks) - grid.tick / 2), dpr);
      const yBot = snap(mainPrice.yOf(grid.toPrice(low) - grid.tick / 2), dpr);
      if (yBot < pane.y || yTop > pane.y + pane.h) continue;
      const tone: Tone = low === pocRow ? 'poc' : low + p.rowTicks - 1 >= p.valTick && low <= p.vahTick ? 'va' : 'out';
      const h = Math.max(px, yBot - yTop - (yBot - yTop >= 3 ? px : 0));
      const w = Math.max(px, cell - (cell >= 3 ? px : 0));
      for (let c = 0; c < row.length; c++) {
        const x = left + c * cell;
        if (x > pane.x + pane.w) break;
        if (x + cell < pane.x) continue;
        if (letters) marks[tone].glyph(x + cell / 2, (yTop + yBot) / 2, row[c]!);
        else marks[tone].rect(x, yTop, w, h);
      }
    }
    const fl = theme.flow;
    if (letters) {
      ctx.font = f;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      marks.out.fillGlyphs(ctx, theme.mutedText);
      marks.va.fillGlyphs(ctx, theme.subtleText);
      marks.poc.fillGlyphs(ctx, theme.text);
      ctx.textAlign = 'left';
    } else {
      marks.out.fillRects(ctx, fl.profileBar);
      marks.va.fillRects(ctx, fl.profileValueArea);
      marks.poc.fillRects(ctx, fl.profilePoc);
    }
    if (withIb) {
      const top = snap(mainPrice.yOf(p.ibHigh + grid.tick / 2), dpr);
      const bottom = snap(mainPrice.yOf(p.ibLow - grid.tick / 2), dpr);
      ctx.fillStyle = fl.profilePoc;
      ctx.fillRect(snap(start + 1, dpr), Math.min(top, bottom), IB_BAR_PX, Math.abs(bottom - top));
    }
    const lines = [
      levelLine(rc, p.poc, x0, x1, this.style.poc),
      levelLine(rc, p.vah, x0, x1, this.style.vah),
      levelLine(rc, p.val, x0, x1, this.style.val),
    ].some(Boolean);
    const shown = marks.out.size + marks.va.size + marks.poc.size > 0;
    this.placed.push({ x0, x1, s, p });
    if (!shown && !lines) return;
    const base = this.profileOf(s, s.rowTicks) ?? p;
    const fin = (v: number) => (Number.isFinite(v) ? v : null);
    let buy = 0;
    let sell = 0;
    let volume = 0;
    for (let k = 0; k < s.rows; k++) {
      buy += s.buy[k]!;
      sell += s.sell[k]!;
      volume += s.volume[k]!;
    }
    this.drawn.push({
      label: s.label,
      from: s.from,
      to: s.to,
      poc: fin(base.poc),
      vah: fin(base.vah),
      val: fin(base.val),
      volume,
      delta: buy - sell,
      partial: s.partial === true,
    });
  }

  private addTags(rc: RenderContext): void {
    const s = this.live(rc);
    const p = s ? this.profileOf(s, s.rowTicks) : null;
    if (!p) return;
    const tag = (price: number, color: string, dashed: boolean) => {
      if (!Number.isFinite(price)) return;
      rc.addAxisTag({ price, text: rc.format.grouped(price), style: 'outline', color, priority: 15, dashed });
    };
    if (this.style.poc.visible) tag(p.poc, this.style.poc.color, false);
    if (this.style.vah.visible) tag(p.vah, rc.theme.mutedText, true);
    if (this.style.val.visible) tag(p.val, rc.theme.mutedText, true);
  }

  askTarget(x: number, y: number): AskTarget | null {
    const rc = this.lastRc;
    if (!rc) return null;
    const price = rc.mainPrice.priceOf(y);
    for (const { x0, x1, s, p } of this.placed) {
      if (x < x0 || x > x1) continue;
      const low = this.grid.toPrice(p.lowTick);
      const high = this.grid.toPrice(p.lowTick + p.rows * p.rowTicks - 1);
      if (price < low || price > high) continue;
      const base = this.profileOf(s, s.rowTicks) ?? p;
      const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(this.grid.decimals) : '—');
      const brackets = s.tpo?.brackets.length ?? 0;
      const ib = Number.isFinite(base.ibLow) ? `, initial balance ${fmt(base.ibLow)}–${fmt(base.ibHigh)}` : '';
      return {
        kind: 'profile',
        label: 'the market profile',
        from: s.from,
        to: s.to,
        low,
        high,
        detail: `TPO POC ${fmt(base.poc)}, VAH ${fmt(base.vah)}, VAL ${fmt(base.val)}, ${String(brackets)} brackets of ${String(this.options.tpo)} min${ib}`,
      };
    }
    return null;
  }
}
