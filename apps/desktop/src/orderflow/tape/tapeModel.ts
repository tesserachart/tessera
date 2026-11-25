import { formatCount, type AggTape, type TradeTape } from '@tessera/chart';
import { displayZone } from '../../state/timeZone.ts';
import { normalizeLink, type LinkGroup } from '../../workspace/dock/links.ts';

export type TapeSide = 'all' | 'buy' | 'sell';

const TAPE_ROWS_PER_SECOND = { slow: 3, medium: 8, fast: 20 } as const;

export type TapeSpeed = keyof typeof TAPE_ROWS_PER_SECOND | 'live';

export const TAPE_SPEEDS: readonly TapeSpeed[] = ['slow', 'medium', 'fast', 'live'];

export const TAPE_SPEED_WORDS: Readonly<Record<TapeSpeed, string>> = {
  slow: 'Slow',
  medium: 'Medium',
  fast: 'Fast',
  live: 'Live',
};

export const MOST_BEHIND_MS = 2_000;

export interface TapeParams {
  link: LinkGroup | null;
  instrument: string | null;
  minSize: number;
  highlight: 'auto' | number;
  side: TapeSide;
  aggregate: boolean;
  millis: boolean;
  speed: TapeSpeed;
}

export const DEFAULT_TAPE_PARAMS: TapeParams = {
  link: null,
  instrument: null,
  minSize: 0,
  highlight: 'auto',
  side: 'all',
  aggregate: true,
  millis: false,
  speed: 'live',
};

export const TAPE_SIZES: readonly number[] = [1, 2, 5, 10, 25, 50, 100, 250];

export function rowsPerSecond(speed: TapeSpeed): number | null {
  return speed === 'live' ? null : TAPE_ROWS_PER_SECOND[speed];
}

function sizeLadder(decade: number): number[] {
  const d = 10 ** decade;
  return [d, decade === 0 ? 2 : 2.5 * d, 5 * d];
}

export function stepMinSize(value: number, by: number): number {
  let v = value;
  for (let k = 0; k < Math.abs(by); k++) {
    if (by > 0) {
      const decade = v < 1 ? 0 : Math.floor(Math.log10(v));
      v = [...sizeLadder(decade), 10 ** (decade + 1)].find((s) => s > v)!;
    } else if (v <= 1) {
      v = 0;
    } else {
      const decade = Math.floor(Math.log10(v));
      const below = [...sizeLadder(decade - 1), ...sizeLadder(decade)].filter((s) => s >= 1 && s < v);
      v = below.at(-1) ?? 0;
    }
  }
  return v;
}

export function readTapeParams(v: unknown): TapeParams {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const str = (x: unknown) => (typeof x === 'string' && x.trim() !== '' ? x : null);
  const number = (x: unknown) => {
    const n = typeof x === 'number' || typeof x === 'string' ? Number(x) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };
  const size = (x: unknown) => {
    const n = number(x);
    return n !== null && n > 0 ? n : null;
  };
  const minSize = number(o.minSize);
  return {
    link: normalizeLink(o.link),
    instrument: str(o.instrument),
    minSize: minSize !== null && minSize >= 0 ? minSize : DEFAULT_TAPE_PARAMS.minSize,
    highlight: o.highlight === 'auto' ? 'auto' : (size(o.highlight) ?? DEFAULT_TAPE_PARAMS.highlight),
    side: o.side === 'buy' || o.side === 'sell' || o.side === 'all' ? o.side : DEFAULT_TAPE_PARAMS.side,
    aggregate: typeof o.aggregate === 'boolean' ? o.aggregate : DEFAULT_TAPE_PARAMS.aggregate,
    millis: typeof o.millis === 'boolean' ? o.millis : DEFAULT_TAPE_PARAMS.millis,
    speed: TAPE_SPEEDS.find((s) => s === o.speed) ?? DEFAULT_TAPE_PARAMS.speed,
  };
}

export function filterWords(p: Pick<TapeParams, 'minSize' | 'side'>): string | null {
  const side = p.side === 'buy' ? 'Buys' : p.side === 'sell' ? 'Sells' : null;
  const size = p.minSize > 0 ? `≥ ${p.minSize.toLocaleString('en-US')}` : null;
  return [side, size].filter(Boolean).join(' ') || null;
}

export function tapeWords(p: Pick<TapeParams, 'minSize' | 'side' | 'speed'>): string | null {
  const speed = p.speed === 'live' ? null : TAPE_SPEED_WORDS[p.speed];
  return [filterWords(p), speed].filter(Boolean).join(' · ') || null;
}

export function highlightSize(p: Pick<TapeParams, 'highlight'>, threshold: number | null): number | null {
  if (p.highlight !== 'auto') return p.highlight;
  return threshold !== null && threshold > 0 ? threshold : null;
}

export interface TapeSource {
  readonly kind: 'prints' | 'orders';
  readonly start: number;
  readonly end: number;
  readonly settled: number;
  readonly epoch: number;
  nsAt(i: number): number;
  priceAt(i: number): number;
  averageAt(i: number): number;
  sizeAt(i: number): number;
  sideAt(i: number): number;
  printsAt(i: number): number;
  firstPrintAt(i: number): number;
  bigAt?(i: number): boolean | undefined;
}

export type IsBig = (seq: number) => boolean;

function seqAt(tape: TradeTape, i: number): number | null {
  return tape.seq === null ? null : tape.seq - (tape.end - i) + 1;
}

export function printsOf(tape: TradeTape, big?: IsBig): TapeSource {
  return {
    kind: 'prints',
    get start() {
      return tape.start;
    },
    get end() {
      return tape.end;
    },
    get settled() {
      return tape.end;
    },
    get epoch() {
      return tape.epoch;
    },
    nsAt: (i) => tape.nsAt(i),
    priceAt: (i) => tape.priceAt(i),
    averageAt: (i) => tape.priceAt(i),
    sizeAt: (i) => tape.sizeAt(i),
    sideAt: (i) => tape.sideAt(i),
    printsAt: () => 1,
    firstPrintAt: (i) => i,
    bigAt: big
      ? (i) => {
          const seq = seqAt(tape, i);
          return seq === null ? undefined : big(seq);
        }
      : undefined,
  };
}

export function ordersOf(agg: AggTape, big?: IsBig): TapeSource {
  const mask = agg.capacity - 1;
  return {
    kind: 'orders',
    get start() {
      return agg.start;
    },
    get end() {
      return agg.end;
    },
    get settled() {
      return agg.closedEnd;
    },
    get epoch() {
      return agg.tape.epoch;
    },
    nsAt: (i) => agg.ns[i & mask]!,
    priceAt: (i) => agg.endTick[i & mask]! * agg.tape.grid.tick,
    averageAt: (i) => agg.tick[i & mask]! * agg.tape.grid.tick,
    sizeAt: (i) => agg.size[i & mask]!,
    sideAt: (i) => agg.side[i & mask]!,
    printsAt: (i) => agg.prints[i & mask]!,
    firstPrintAt: (i) => agg.firstPrint[i & mask]!,
    bigAt: big
      ? (i) => {
          const seq = agg.seqOf(i);
          return seq === null ? undefined : big(seq);
        }
      : undefined,
  };
}

export interface HistoryRow {
  ns: number;
  price: number;
  average: number;
  size: number;
  side: number;
  prints: number;
}

export interface TapeRow {
  ns: number;
  price: number;
  average: number;
  size: number;
  side: number;
  prints: number;
  key: string;
  big?: boolean;
}

/** A double cannot hold a UTC nanosecond past 2^53 exactly: it can round to a little after the exchange's time. */
export function historyBefore<R extends { ns: number }>(rows: readonly R[], first: number | null): readonly R[] {
  if (first === null) return rows;
  let n = rows.length;
  while (n > 0 && rows[n - 1]!.ns >= first) n--;
  return n === rows.length ? rows : rows.slice(0, n);
}

export const SCROLLBACK = 20_000;
const RING = 32_768;

export class TapeList {
  private readonly idx = new Float64Array(RING);
  private mStart = 0;
  private mEnd = 0;
  private settled = 0;
  private epoch = -1;
  private kind: TapeSource['kind'] | null = null;
  private src: TapeSource | null = null;
  private minSize = 0;
  private side: TapeSide = 'all';
  private dirty = true;
  private top: number | null = null;
  private shownBefore: number | null = null;
  private shownEnd = 0;
  private cut = false;
  private history: readonly HistoryRow[] = [];
  private shownHistory: HistoryRow[] = [];
  version = 0;

  setFilter(f: { minSize: number; side: TapeSide }): void {
    if (f.minSize === this.minSize && f.side === this.side) return;
    this.minSize = f.minSize;
    this.side = f.side;
    this.dirty = true;
    this.filterHistory();
  }

  setHistory(rows: readonly HistoryRow[]): void {
    this.history = rows;
    this.filterHistory();
    this.version++;
  }

  dropLive(): void {
    this.mStart = 0;
    this.mEnd = 0;
    this.settled = 0;
    this.epoch = -1;
    this.kind = null;
    this.src = null;
    this.dirty = true;
    this.top = null;
    if (this.shownBefore !== null) this.shownBefore = 0;
    this.shownEnd = 0;
    this.cut = false;
    this.history = [];
    this.shownHistory = [];
    this.version++;
  }

  setPaced(paced: boolean): void {
    if (paced === (this.shownBefore !== null)) return;
    this.shownBefore = paced ? (this.src?.end ?? 0) : null;
    this.placeShown();
  }

  get waiting(): number {
    return this.shownBefore === null ? 0 : this.mEnd - this.shownEnd;
  }

  get newestEnd(): number | null {
    return this.mEnd > this.mStart ? this.idx[(this.mEnd - 1) & (RING - 1)]! + 1 : null;
  }

  reveal(rows: number): void {
    if (this.shownBefore === null || rows <= 0 || this.shownEnd >= this.mEnd) return;
    const to = Math.min(this.mEnd, this.shownEnd + rows);
    this.revealBefore(to < this.mEnd ? this.idx[to & (RING - 1)]! : this.newestEnd!);
  }

  revealBefore(end: number): void {
    if (this.shownBefore === null || end <= this.shownBefore) return;
    this.shownBefore = end;
    this.placeShown();
  }

  waitingBefore(end: number): number {
    return this.shownBefore === null ? 0 : Math.max(0, this.firstAtOrAfter(end) - this.shownEnd);
  }

  private firstAtOrAfter(index: number): number {
    let lo = this.mStart;
    let hi = this.mEnd;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.idx[mid & (RING - 1)]! >= index) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  private placeShown(): void {
    const before = this.shownEnd;
    this.shownEnd = this.shownBefore === null ? this.mEnd : this.firstAtOrAfter(this.shownBefore);
    if (this.shownEnd !== before) this.version++;
  }

  get historyLength(): number {
    return this.history.length;
  }

  private filterHistory(): void {
    this.shownHistory = this.history.filter((r) => this.passes(r.size, r.side));
  }

  private passes(size: number, side: number): boolean {
    if (size < this.minSize) return false;
    if (this.side === 'buy') return side > 0;
    if (this.side === 'sell') return side < 0;
    return true;
  }

  sync(src: TapeSource): boolean {
    if (src !== this.src || src.kind !== this.kind || src.epoch !== this.epoch) {
      this.src = src;
      this.kind = src.kind;
      this.epoch = src.epoch;
      this.dirty = true;
    }
    if (this.dirty) {
      this.rebuild(src);
      return true;
    }
    const before = this.version;
    if (src.start > 0 && !this.cut) this.cut = true;
    while (this.mStart < this.mEnd && this.idx[this.mStart & (RING - 1)]! < src.start) this.mStart++;
    let popped = false;
    while (this.mEnd > this.mStart && this.idx[(this.mEnd - 1) & (RING - 1)]! >= this.settled) {
      this.mEnd--;
      popped = true;
    }
    const from = Math.max(this.settled, src.start);
    for (let i = from; i < src.end; i++) if (this.passes(src.sizeAt(i), src.sideAt(i))) this.push(i);
    if (popped || src.end > from) this.version++;
    this.settled = src.settled;
    if (this.top !== null && this.top < this.mStart) this.top = null;
    this.placeShown();
    return this.version !== before;
  }

  private push(i: number): void {
    this.idx[this.mEnd & (RING - 1)] = i;
    this.mEnd++;
    if (this.mEnd - this.mStart > RING) {
      this.mStart = this.mEnd - RING;
      this.cut = true;
    }
  }

  private rebuild(src: TapeSource): void {
    this.dirty = false;
    const paused = this.top !== null;
    const found: number[] = [];
    for (let i = src.end - 1; i >= src.start && found.length < SCROLLBACK; i--) {
      if (this.passes(src.sizeAt(i), src.sideAt(i))) found.push(i);
    }
    this.mStart = 0;
    this.mEnd = 0;
    for (let k = found.length - 1; k >= 0; k--) this.push(found[k]!);
    this.cut = src.start > 0 || (found.length >= SCROLLBACK && found[found.length - 1]! > src.start);
    this.settled = src.settled;
    this.top = paused ? this.liveTop : null;
    if (this.shownBefore !== null) this.shownBefore = src.end;
    this.placeShown();
    this.version++;
  }

  get frozen(): boolean {
    return this.top !== null;
  }

  freeze(): void {
    this.top ??= this.liveTop;
  }

  resume(): void {
    const behind = this.waiting > 0;
    if (this.top === null && !behind) return;
    this.top = null;
    if (behind) this.reveal(this.waiting);
    this.version++;
  }

  get fresh(): number {
    return this.top === null ? 0 : Math.max(0, this.mEnd - this.top);
  }

  private get liveTop(): number {
    return this.top ?? (this.shownBefore === null ? this.mEnd : this.shownEnd);
  }

  private get liveCount(): number {
    return Math.max(0, Math.min(SCROLLBACK, this.liveTop - this.mStart));
  }

  private get historyShown(): boolean {
    return !this.cut && this.liveTop - this.mStart <= SCROLLBACK;
  }

  get length(): number {
    const live = this.liveCount;
    return this.historyShown ? Math.min(SCROLLBACK, live + this.shownHistory.length) : live;
  }

  row(pos: number): TapeRow | null {
    if (pos < 0 || pos >= this.length) return null;
    const live = this.liveCount;
    if (pos < live) {
      const src = this.src!;
      const i = this.idx[(this.liveTop - 1 - pos) & (RING - 1)]!;
      return {
        ns: src.nsAt(i),
        price: src.priceAt(i),
        average: src.averageAt(i),
        size: src.sizeAt(i),
        side: src.sideAt(i),
        prints: src.printsAt(i),
        key: `l${String(i)}`,
        big: src.bigAt?.(i),
      };
    }
    const k = this.shownHistory.length - 1 - (pos - live);
    const h = this.shownHistory[k];
    if (!h) return null;
    return { ...h, key: `h${String(h.ns)}:${String(k)}` };
  }

  posOf(key: string): number | null {
    const n = this.length;
    const live = this.liveCount;
    if (key.startsWith('l')) {
      const i = Number(key.slice(1));
      const m = this.findLive((j) => j >= i);
      if (m === null || this.idx[m & (RING - 1)] !== i) return null;
      const pos = this.liveTop - 1 - m;
      return pos < live ? pos : null;
    }
    for (let pos = live; pos < n; pos++) if (this.row(pos)?.key === key) return pos;
    return null;
  }

  private findLive(pred: (index: number) => boolean): number | null {
    let lo = Math.max(this.mStart, this.liveTop - SCROLLBACK);
    let hi = this.liveTop;
    if (lo >= hi) return null;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (pred(this.idx[mid & (RING - 1)]!)) hi = mid;
      else lo = mid + 1;
    }
    return lo < this.liveTop ? lo : null;
  }

  find(ref: string, tMs: number, size: number): number | null {
    const src = this.src;
    const live = this.liveCount;
    if (src && ref.startsWith('live:')) {
      const tapeIndex = Number(ref.slice(5));
      const m = this.findLive((i) => src.firstPrintAt(i) >= tapeIndex);
      if (m !== null && src.firstPrintAt(this.idx[m & (RING - 1)]!) === tapeIndex) {
        const pos = this.liveTop - 1 - m;
        if (pos < live) return pos;
      }
    }
    const t = tMs * 1e6;
    const pick = { pos: null as number | null, score: Infinity };
    const n = this.length;
    const near = (pos: number) => {
      const r = this.row(pos);
      if (!r) return;
      const dt = Math.abs(r.ns - t);
      if (dt > 1e6) return;
      const score = dt / 1e6 + Math.abs(r.size - size) / Math.max(1, size);
      if (score < pick.score) {
        pick.score = score;
        pick.pos = pos;
      }
    };
    if (src && live > 0) {
      const m = this.findLive((i) => src.nsAt(i) >= t - 1e6);
      if (m !== null)
        for (let k = m; k < this.liveTop && src.nsAt(this.idx[k & (RING - 1)]!) <= t + 1e6; k++)
          near(this.liveTop - 1 - k);
    }
    if (pick.pos === null) for (let pos = live; pos < n; pos++) near(pos);
    return pick.pos;
  }

  static firstLiveNs(src: TapeSource): number | null {
    return src.end > src.start ? src.nsAt(src.start) : null;
  }
}

export class TapePacer {
  private at: number | null = null;
  private credit = 1;
  private caughtUp = true;
  private readonly arrivals: { at: number; end: number }[] = [];

  reset(): void {
    this.at = null;
    this.credit = 1;
    this.caughtUp = true;
    this.arrivals.length = 0;
  }

  step(list: TapeList, now: number, perSecond: number): void {
    const end = list.newestEnd;
    if (end !== null && end > (this.arrivals.at(-1)?.end ?? -Infinity)) this.arrivals.push({ at: now, end });
    while (this.arrivals.length > 0 && this.arrivals[0]!.at <= now - MOST_BEHIND_MS)
      list.revealBefore(this.arrivals.shift()!.end);
    while (this.arrivals.length > 0 && list.waitingBefore(this.arrivals[0]!.end) === 0) this.arrivals.shift();
    let need = perSecond;
    for (const a of this.arrivals) {
      const left = Math.max(1, a.at + MOST_BEHIND_MS - now);
      need = Math.max(need, (list.waitingBefore(a.end) * 1000) / left);
    }
    const waiting = list.waiting;
    const elapsed = this.at === null ? 0 : Math.max(0, now - this.at);
    this.at = now;
    const gain = (elapsed * need) / 1000;
    this.credit = this.caughtUp ? Math.min(1, this.credit + gain) : this.credit + gain;
    const rows = Math.min(waiting, Math.floor(this.credit));
    this.credit -= rows;
    list.reveal(rows);
    this.caughtUp = list.waiting === 0;
    if (this.caughtUp) this.credit = Math.min(1, this.credit);
  }
}

function minuteClock(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone });
}

export class TapeClock {
  private zone = displayZone();
  private fmt = minuteClock(this.zone);
  private minute = Number.NaN;
  private hm = '';

  parts(ns: number): [string, string] {
    const ms = Math.floor(ns / 1e6);
    const minute = Math.floor(ms / 60_000);
    const zone = displayZone();
    if (zone !== this.zone) {
      this.zone = zone;
      this.fmt = minuteClock(zone);
      this.minute = Number.NaN;
    }
    if (minute !== this.minute) {
      this.minute = minute;
      this.hm = this.fmt.format(new Date(minute * 60_000));
    }
    const within = ms - minute * 60_000;
    const s = Math.floor(within / 1000);
    return [`${this.hm}:${String(s).padStart(2, '0')}`, `.${String(within % 1000).padStart(3, '0')}`];
  }
}

export function tapeSize(v: number): string {
  if (!(v > 0)) return '';
  if (v >= 10_000) {
    const k = v / 1000;
    return `${k >= 100 ? String(Math.round(k)) : (Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  }
  const n = Math.round(v * 100) / 100;
  return Number.isInteger(n) ? formatCount(n) : String(n);
}

export type TapePill =
  { kind: 'fresh'; text: string } | { kind: 'paused'; text: string } | { kind: 'note'; text: string };

export function pillFor(s: {
  frozen: boolean;
  fresh: number;
  held: boolean;
  dropped: string | null;
  flash: string | null;
  closed?: string | null;
}): TapePill | null {
  if (s.flash) return { kind: 'note', text: s.flash };
  if (s.dropped) return { kind: 'note', text: s.dropped };
  if (s.frozen && s.fresh > 0) return { kind: 'fresh', text: `${s.fresh.toLocaleString('en-US')} new` };
  if (s.frozen && s.held) return { kind: 'paused', text: 'Paused' };
  if (s.closed) return { kind: 'note', text: s.closed };
  return null;
}
