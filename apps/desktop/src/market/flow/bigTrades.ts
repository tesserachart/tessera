import {
  decideOutcome,
  MIN_REACH_TICKS,
  watchOutcome,
  type AggTape,
  type BigTrade,
  type BigTradeOutcome,
  type BigTradeSource,
  type BigTradeTier,
  type Grouping,
  type OutcomeWatch,
  type TimeSpan,
  type TradeTape,
} from '@tessera/chart';
import {
  msToNs,
  normalizeEpochMs,
  Runtime,
  type BigTradeCuts,
  type BigTradesOutput,
  type BigTradeRule as AnsweredRule,
  type BigTrade as WireBigTrade,
} from '@tessera/protocol';
import { Lifetime, retrying } from '../../app/lifetime.ts';
import { onMarketServed } from '../../app/health.ts';
import { appClient } from '../../app/services.ts';
import { toolCode } from '../../app/tools.ts';
import { feedErrorWords, retryFeedError } from '../../shell/deskWords.ts';
import {
  DEFAULT_DAYS_TO_LOAD,
  Emitter,
  loadedOf,
  settledGapsOf,
  NO_GAPS,
  Refill,
  sessionAgainMs,
  spliceGaps,
  type FlowStatus,
  type InstrumentFlow,
  type Loaded,
  withLoaded,
} from './hub.ts';

export const HISTORY_LIMIT = 5000;
const AUTO_MARGIN = 0.75;
export const LOWER_AFTER_MS = 400;
const HISTORY_DAYS_PER_SESSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const GAP_MS = 60_000;
const SLICES = 6;
const LIVE_MAX = 5000;
const HALF_HOUR_MS = 30 * 60 * 1000;

export type BigTradeFilter = { kind: 'auto'; tier: BigTradeTier } | { kind: 'size'; min: number; max: number | null };

const TIER_RANK: Readonly<Record<BigTradeTier, number>> = { low: 0, medium: 1, high: 2 };

export function passes(filter: BigTradeFilter, t: BigTrade): boolean {
  if (filter.kind === 'auto')
    return t.tier !== null && t.tier !== undefined && TIER_RANK[t.tier] >= TIER_RANK[filter.tier];
  return filter.min <= t.size && (filter.max === null || t.size <= filter.max);
}

export function sameFilter(a: BigTradeFilter, b: BigTradeFilter): boolean {
  if (a.kind === 'auto') return b.kind === 'auto' && a.tier === b.tier;
  return b.kind === 'size' && a.min === b.min && a.max === b.max;
}

export interface BigTradeDemand {
  set(filter: BigTradeFilter): void;
  drop(): void;
}

function tierOf(cuts: BigTradeCuts | null, size: number): BigTradeTier | null {
  if (!cuts) return null;
  if (size >= cuts.high) return 'high';
  if (size >= cuts.medium) return 'medium';
  return size >= cuts.low ? 'low' : null;
}

interface LiveEvent {
  size: number;
  price: number;
}

function liveTier(answered: AnsweredRule, e: LiveEvent): BigTradeTier | null {
  const floors = e.size >= answered.floor && e.size * e.price * answered.multiplier >= answered.minNotional;
  return floors ? tierOf(answered.cuts, e.size) : null;
}

function tieringKey(answered: AnsweredRule, floor: number): string {
  return JSON.stringify([
    answered.cuts,
    answered.floor,
    answered.minNotional,
    answered.multiplier,
    answered.reachTicks,
    answered.reachFrom,
    floor,
  ]);
}

function reachAt(answered: AnsweredRule, ms: number): number {
  if (answered.reachFrom === null) return MIN_REACH_TICKS;
  return answered.reachTicks[Math.floor((ms - normalizeEpochMs(answered.reachFrom)) / HALF_HOUR_MS)] ?? MIN_REACH_TICKS;
}

function outcomeOf(
  kind: BigTradeOutcome['kind'],
  reachTicks: number,
  decidedNs: number,
  lastNs: number,
): BigTradeOutcome {
  return { kind, reachTicks, withinMs: (decidedNs - lastNs) / 1e6 };
}

function lowerIndex(list: readonly number[], i: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]! < i) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBound(list: readonly BigTrade[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(list: readonly BigTrade[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bubbleOf(w: WireBigTrade, ref: string): BigTrade | null {
  if (w.side === 'unknown') return null;
  return {
    t: normalizeEpochMs(w.t),
    price: w.price,
    size: w.size,
    side: w.side === 'buy' ? 1 : -1,
    prints: w.prints,
    ref,
    tier: w.tier,
    outcome: w.outcome && outcomeOf(w.outcome.kind, w.outcome.reachTicks, w.outcome.decided, w.t + w.durationNs),
    levels: w.levels,
    firstPrice: w.firstPrice,
    lastPrice: w.lastPrice,
    durationMs: w.durationNs / 1e6,
    orders: w.orders,
  };
}

function tapeIndexOf(tape: TradeTape, seq: number): number | null {
  if (tape.seq === null) return null;
  const i = tape.end - (tape.seq - seq) - 1;
  return i >= tape.start && i < tape.end ? i : null;
}

export class LiveBigTrades {
  list: BigTrade[] = [];
  version = 0;
  private readonly seqs: number[] = [];
  private readonly bySeq = new Map<number, BigTrade>();
  private readonly starts: number[] = [];

  reset(): void {
    if (this.list.length === 0) return;
    this.list = [];
    this.seqs.length = 0;
    this.starts.length = 0;
    this.bySeq.clear();
    this.version++;
  }

  apply(events: readonly WireBigTrade[], tape: TradeTape): void {
    if (events.length === 0) return;
    let list = this.list;
    for (const w of events) {
      if (w.seq === null) continue;
      const i = tapeIndexOf(tape, w.seq);
      const t = bubbleOf(w, i === null ? `h:${String(w.t)}` : `live:${String(i)}`);
      if (!t) continue;
      const held = this.bySeq.get(w.seq);
      if (list === this.list) list = [...this.list];
      if (held) {
        const k = list.indexOf(held);
        if (k >= 0) list[k] = t;
      } else {
        const k = upperBound(list, t.t);
        list.splice(k, 0, t);
        this.seqs.splice(k, 0, w.seq);
        this.starts.splice(this.startAt(w.seq), 0, w.seq);
      }
      this.bySeq.set(w.seq, t);
    }
    if (list.length > LIVE_MAX) {
      const drop = list.length - LIVE_MAX;
      for (const seq of this.seqs.splice(0, drop)) {
        this.bySeq.delete(seq);
        const k = this.startAt(seq);
        if (this.starts[k] === seq) this.starts.splice(k, 1);
      }
      list = list.slice(drop);
    }
    this.list = list;
    this.version++;
  }

  get(seq: number): BigTrade | undefined {
    return this.bySeq.get(seq);
  }

  containing(seq: number): BigTrade | undefined {
    const k = this.startAt(seq + 1) - 1;
    if (k < 0) return undefined;
    const t = this.bySeq.get(this.starts[k]!);
    return t && seq < this.starts[k]! + t.prints ? t : undefined;
  }

  private startAt(seq: number): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid]! < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

interface HistoryWalk {
  dayFrom: number;
  dayHasPrints: boolean;
  sessions: number;
  days: number;
}

interface HistoryRead {
  kind: 'walk' | 'gap' | 'band';
  from: number;
  to: number;
  minSize: number;
  maxSize: number | null;
}

function spanKey(span: HistoryRead): string {
  return JSON.stringify([span.from, span.to, span.minSize, span.maxSize]);
}

interface HeldSpan {
  from: number;
  to: number;
  floor: number;
}

function cover(spans: readonly HeldSpan[], from: number, to: number, floor: number): HeldSpan[] {
  if (to <= from) return [...spans];
  const parts: HeldSpan[] = [];
  let at = from;
  for (const s of spans) {
    if (s.to <= from || s.from >= to) {
      parts.push(s);
      continue;
    }
    if (s.from < from) parts.push({ from: s.from, to: from, floor: s.floor });
    if (s.from > at) parts.push({ from: at, to: s.from, floor });
    const end = Math.min(s.to, to);
    parts.push({ from: Math.max(s.from, from), to: end, floor: Math.min(s.floor, floor) });
    at = end;
    if (s.to > to) parts.push({ from: to, to: s.to, floor: s.floor });
  }
  if (at < to) parts.push({ from: at, to, floor });
  parts.sort((x, y) => x.from - y.from);
  const merged: HeldSpan[] = [];
  for (const s of parts) {
    const last = merged.at(-1);
    if (last?.to === s.from && last.floor === s.floor) last.to = s.to;
    else merged.push({ ...s });
  }
  return merged;
}

export class BigTradeFeed {
  readonly flow: InstrumentFlow;
  readonly grouping: Grouping;
  readonly changed = new Emitter();
  floor: number | null = null;
  gaps: readonly TimeSpan[] = NO_GAPS;
  private readonly demands = new Set<{ filter: BigTradeFilter }>();
  private lowering: (() => void) | null = null;
  private lowestCut: number | null = null;
  private newest: { to: number; rule: AnsweredRule } | null = null;
  private readonly grouped: { agg: AggTape; release: () => void };
  private releaseTrades: (() => void) | null = null;
  private off: (() => void) | null = null;
  private history: BigTrade[] = [];
  private held: HeldSpan[] = [];
  private coveredFrom = Number.NaN;
  private coveredTo = Number.NaN;
  private walk: HistoryWalk | null = null;
  private gap: { top: number; end: number } | null = null;
  private reading = false;
  private refused = false;
  private readonly reads = new Lifetime();
  private readonly refill = new Refill(this.reads);
  private error: string | null = null;
  private sessionTries = 0;
  private live: BigTrade[] = [];
  private liveIdx: number[] = [];
  private watching: { i: number; w: OutcomeWatch }[] = [];
  private head = 0;
  private cursor = 0;
  private liveEpoch = -1;
  private liveTiering = '';
  private openKey = '';
  private openBig: BigTrade | null = null;
  private version = 0;
  private readonly slices = new Map<string, BigTrade[]>();
  private slicesVersion = -1;
  private loaded: Loaded | null = null;

  constructor(
    flow: InstrumentFlow,
    grouping: Grouping,
    readonly days = DEFAULT_DAYS_TO_LOAD,
  ) {
    this.flow = flow;
    this.grouping = grouping;
    this.grouped = flow.useAgg(grouping);
  }

  start(): void {
    this.releaseTrades = this.flow.useTrades();
    this.off = this.flow.tradesChanged.on(() => {
      this.pump();
      this.changed.emit();
    });
    const anchor = this.liveStart();
    this.coveredFrom = anchor;
    this.coveredTo = anchor;
    this.walk = { dayFrom: anchor - DAY_MS, dayHasPrints: false, sessions: 0, days: 0 };
    this.pump();
  }

  stop(): void {
    this.reads.end();
    this.lowering = null;
    this.off?.();
    this.releaseTrades?.();
    this.grouped.release();
    this.off = null;
    this.releaseTrades = null;
  }

  demand(filter: BigTradeFilter): BigTradeDemand {
    const d = { filter };
    this.demands.add(d);
    this.demandsChanged();
    return {
      set: (next) => {
        if (!this.demands.has(d)) return;
        d.filter = next;
        this.demandsChanged();
      },
      drop: () => {
        if (this.demands.delete(d)) this.demandsChanged();
      },
    };
  }

  get cuts(): BigTradeCuts | null {
    return this.newest?.rule.cuts ?? null;
  }

  cutFor(tier: BigTradeTier): number | null {
    return this.cuts?.[tier] ?? null;
  }

  get status(): FlowStatus {
    return this.statusDownTo(this.floor);
  }

  statusFor(filter: BigTradeFilter): FlowStatus {
    return this.statusDownTo(filter.kind === 'size' ? filter.min : (this.cutFor(filter.tier) ?? this.floor));
  }

  private statusDownTo(size: number | null): FlowStatus {
    if (this.error !== null) return { reading: false, error: this.error };
    if (this.refused || this.demands.size === 0) return { reading: false, error: null };
    const down = size === null || this.floor === null ? this.floor : Math.max(size, this.floor);
    return withLoaded({ reading: !this.held.some((s) => down !== null && s.floor <= down), error: null }, this.loaded);
  }

  get sizing(): boolean {
    return this.newest !== null && this.newest.rule.cuts === null;
  }

  private demandsChanged(): void {
    this.lowering?.();
    this.lowering =
      this.floor === null
        ? null
        : this.reads.after(LOWER_AFTER_MS, () => {
            this.lowering = null;
            this.pump();
          });
    this.pump();
  }

  private target(): number | null {
    let target: number | null = null;
    const lower = (n: number) => {
      target = target === null ? n : Math.min(target, n);
    };
    for (const { filter } of this.demands) {
      if (filter.kind === 'size') {
        lower(filter.min);
        continue;
      }
      const threshold = this.flow.threshold;
      if (threshold) lower(Math.max(threshold.floor, Math.floor(AUTO_MARGIN * threshold.size)));
      if (this.lowestCut !== null) lower(this.lowestCut);
    }
    return target;
  }

  private retarget(): void {
    if ([...this.demands].some((d) => d.filter.kind === 'auto')) this.flow.loadThreshold();
    if (this.lowering) return;
    const target = this.target();
    if (target === null || (this.floor !== null && target >= this.floor)) return;
    this.floor = target;
    this.refused = false;
    this.version++;
    this.changed.emit();
  }

  private tapeStart(): number {
    const tape = this.flow.tape;
    return tape.length > 0 ? tape.msAt(tape.start) : this.flow.clock.now();
  }

  private liveStart(): number {
    return this.live.length > this.head ? this.live[this.head]!.t : this.tapeStart();
  }

  between(fromMs: number, toMs: number): readonly BigTrade[] {
    this.syncLive();
    const live = this.live;
    const liveFrom = this.head;
    const open = this.openBig;
    const cut = this.liveStart();
    const cutK = lowerBound(this.history, cut);
    const key = `${String(fromMs)}|${String(toMs)}|${String(cutK)}`;
    if (this.slicesVersion !== this.version) {
      this.slices.clear();
      this.slicesVersion = this.version;
    }
    const held = this.slices.get(key);
    if (held) return held;
    const out: BigTrade[] = [];
    const hEnd = Math.min(cutK, upperBound(this.history, toMs));
    for (let k = lowerBound(this.history, fromMs); k < hEnd; k++) out.push(this.history[k]!);
    const lEnd = upperBound(live, toMs);
    for (let k = Math.max(liveFrom, lowerBound(live, fromMs)); k < lEnd; k++) out.push(live[k]!);
    if (open && open.t >= fromMs && open.t <= toMs) out.push(open);
    if (this.slices.size >= SLICES) this.slices.delete(this.slices.keys().next().value!);
    this.slices.set(key, out);
    return out;
  }

  private tierAt(agg: AggTape, i: number, answered: AnsweredRule, floor: number): BigTradeTier | null | 'hidden' {
    const s = i & (agg.capacity - 1);
    if (agg.side[s] === 0 || agg.size[s]! < floor) return 'hidden';
    return liveTier(answered, { size: agg.size[s]!, price: agg.tick[s]! * this.flow.grid.tick });
  }

  private eventOf(agg: AggTape, i: number, tier: BigTradeTier | null): BigTrade {
    const s = i & (agg.capacity - 1);
    const tape = this.flow.tape;
    const tick = this.flow.grid.tick;
    const first = agg.firstPrint[s]!;
    const last = first + agg.prints[s]! - 1;
    const ref = `live:${String(first)}`;
    const t = agg.ns[s]! / 1e6;
    return {
      t,
      price: agg.tick[s]! * tick,
      size: agg.size[s]!,
      side: agg.side[s]! > 0 ? 1 : -1,
      prints: agg.prints[s]!,
      levels: agg.levels[s]!,
      orders: agg.orders[s]!,
      firstPrice: first >= tape.start ? tape.priceAt(first) : undefined,
      lastPrice: agg.endTick[s]! * tick,
      durationMs: first >= tape.start && last < tape.end ? tape.msAt(last) - t : undefined,
      tier,
      ref,
    };
  }

  private syncLive(): void {
    const agg = this.grouped.agg;
    const epoch = this.flow.tape.epoch;
    const answered = this.newest?.rule;
    const floor = this.floor;
    const tiering = answered && floor !== null ? tieringKey(answered, floor) : '';
    if (epoch !== this.liveEpoch || tiering !== this.liveTiering || agg.end < this.cursor) {
      this.live = [];
      this.liveIdx = [];
      this.watching = [];
      this.head = 0;
      this.cursor = agg.start;
      this.liveEpoch = epoch;
      this.liveTiering = tiering;
      this.openKey = '';
      this.openBig = null;
      this.version++;
    }
    if (!answered || floor === null) return;
    const start = agg.start;
    if (this.cursor < start) this.cursor = start;
    let head = this.head;
    while (head < this.liveIdx.length && this.liveIdx[head]! < start) head++;
    if (head !== this.head) {
      this.head = head;
      this.watching = this.watching.filter((x) => x.i >= start);
      this.version++;
      if (head > 1024 && head * 2 > this.live.length) {
        this.live = this.live.slice(head);
        this.liveIdx = this.liveIdx.slice(head);
        this.head = 0;
      }
    }
    const closed = agg.closedEnd;
    if (this.cursor < closed) {
      for (let i = this.cursor; i < closed; i++) {
        const tier = this.tierAt(agg, i, answered, floor);
        if (tier === 'hidden') continue;
        const t = this.eventOf(agg, i, tier);
        this.live.push(t);
        this.liveIdx.push(i);
        const w = watchOutcome(agg, i, reachAt(answered, t.t));
        if (w) this.watching.push({ i, w });
        this.version++;
      }
      this.cursor = closed;
    }
    this.settle();
    const i = agg.end - 1;
    const s = i & (agg.capacity - 1);
    const tier = agg.open && i >= start ? this.tierAt(agg, i, answered, floor) : 'hidden';
    const openKey = tier === 'hidden' ? '' : `${String(i)}|${String(agg.size[s])}|${String(agg.prints[s])}`;
    if (openKey !== this.openKey) {
      this.openKey = openKey;
      this.openBig = tier === 'hidden' ? null : this.eventOf(agg, i, tier);
      this.version++;
    }
  }

  private settle(): void {
    if (this.watching.length === 0) return;
    const tape = this.flow.tape;
    this.watching = this.watching.filter(({ i, w }) => {
      const at = decideOutcome(tape, w);
      if (!at) return true;
      const k = lowerIndex(this.liveIdx, i);
      const t = this.live[k];
      if (t && this.liveIdx[k] === i) {
        this.live[k] = { ...t, outcome: outcomeOf(at.kind, w.reachTicks, at.decidedNs, w.lastNs) };
        this.version++;
      }
      return false;
    });
  }

  private pump(): void {
    this.retarget();
    this.syncLive();
    if (this.reading || this.refused) return;
    const next = this.nextRead();
    if (next) this.read(next);
  }

  private nextRead(): HistoryRead | null {
    const floor = this.floor;
    if (floor === null) return null;
    const live = this.liveStart();
    if (!this.gap && this.flow.tape.length > 0 && live - this.coveredTo >= GAP_MS) this.gap = { top: live, end: live };
    const atFloor = { minSize: floor, maxSize: null };
    if (this.gap)
      return { kind: 'gap', from: Math.max(this.coveredTo, this.gap.end - DAY_MS), to: this.gap.end, ...atFloor };
    const above = this.held.findLast((s) => s.floor > floor);
    if (above)
      return {
        kind: 'band',
        from: Math.max(above.from, above.to - DAY_MS),
        to: above.to,
        minSize: floor,
        maxSize: above.floor - 1,
      };
    if (this.walk) return { kind: 'walk', from: this.walk.dayFrom, to: this.coveredFrom, ...atFloor };
    return null;
  }

  private read(span: HistoryRead): void {
    this.reading = true;
    this.error = null;
    this.changed.emit();
    const done = this.reads.hold(() => {
      this.reading = false;
    });
    const next = (wait: number) => {
      const go = () => {
        done();
        this.pump();
      };
      if (wait > 0) this.reads.after(wait, go);
      else go();
    };
    const question = () => this.ask(span);
    this.reads.run(
      question,
      (out) => {
        this.take(out, span);
        this.changed.emit();
        this.sessionTries = 0;
        if (out.filling)
          this.refill.ask(
            spanKey(span),
            question,
            (settled) => {
              this.take(settled, span, 'again');
              this.changed.emit();
            },
            (filling) => {
              if (span.kind === 'walk' || span.to >= (this.newest?.to ?? -Infinity)) this.loaded = loadedOf(filling);
              this.changed.emit();
            },
          );
        next(0);
      },
      (e) => {
        this.refused = toolCode(e) === 'invalid_input';
        this.error = feedErrorWords(e);
        this.changed.emit();
        next(this.refused ? 0 : sessionAgainMs(++this.sessionTries));
      },
    );
  }

  private ask(span: HistoryRead): Promise<BigTradesOutput> {
    return retrying(
      () =>
        Runtime.invoke(appClient(), 'market.get_big_trades', {
          instrument: this.flow.instrument,
          from: msToNs(span.from),
          to: msToNs(span.to),
          minSize: span.minSize,
          ...(span.maxSize === null ? {} : { maxSize: span.maxSize }),
          joinOrders: this.grouping.joinOrders,
          reachLimit: this.grouping.reachLimit,
          limit: HISTORY_LIMIT,
          daysToLoad: this.days,
        }),
      { again: retryFeedError, live: this.reads.live(), wake: onMarketServed },
    );
  }

  private take(out: BigTradesOutput, span: HistoryRead, pass: 'first' | 'again' = 'first'): void {
    const { from, to } = span;
    const settled = settledGapsOf(out);
    if (settled) this.gaps = spliceGaps(this.gaps, from, to, settled);
    if (out.aggressorSource) this.flow.info.aggressorSource = out.aggressorSource;
    if (to >= (this.newest?.to ?? -Infinity)) {
      this.newest = { to, rule: out.rule };
      this.loaded = loadedOf(out);
    }
    const cut = out.rule.cuts?.low;
    if (cut !== undefined && (this.lowestCut === null || cut < this.lowestCut)) this.lowestCut = cut;
    const read = out.trades.flatMap((t) => bubbleOf(t, `h:${String(t.t)}`) ?? []);
    const oldest = out.trades[0];
    const answered = out.count > out.trades.length && oldest ? normalizeEpochMs(oldest.t) : from;
    const inSpan = (t: BigTrade) =>
      t.t >= answered && t.t < to && t.size >= span.minSize && (span.maxSize === null || t.size <= span.maxSize);
    const kept = this.history.filter((t) => !inSpan(t));
    this.history = [...kept, ...read].sort((a, b) => a.t - b.t);
    this.version++;
    this.held = cover(this.held, answered, to, span.minSize);
    if (span.kind !== 'band' && pass === 'first') this.advance(span, answered, out.orders > 0);
    this.error = null;
  }

  private advance(span: HistoryRead, reached: number, prints: boolean): void {
    if (span.kind === 'gap' && this.gap) {
      this.gap.end = reached;
      if (reached <= this.coveredTo) {
        this.coveredTo = this.gap.top;
        this.gap = null;
      }
      return;
    }
    this.coveredFrom = Math.min(this.coveredFrom, reached);
    const walk = this.walk;
    if (!walk) return;
    walk.dayHasPrints ||= prints;
    if (this.coveredFrom > walk.dayFrom) return;
    const sessions = walk.sessions + (walk.dayHasPrints ? 1 : 0);
    const days = walk.days + 1;
    this.walk =
      sessions >= this.days || days >= this.days * HISTORY_DAYS_PER_SESSION
        ? null
        : { dayFrom: walk.dayFrom - DAY_MS, dayHasPrints: false, sessions, days };
  }
}

export class BigTradeView implements BigTradeSource {
  private readonly kept = new WeakMap<readonly BigTrade[], readonly BigTrade[]>();

  constructor(
    readonly feed: BigTradeFeed,
    readonly filter: BigTradeFilter,
  ) {}

  reference(): number {
    return this.filter.kind === 'size' ? this.filter.min : (this.feed.cutFor(this.filter.tier) ?? Number.NaN);
  }

  between(fromMs: number, toMs: number): readonly BigTrade[] {
    const all = this.feed.between(fromMs, toMs);
    let shown = this.kept.get(all);
    if (!shown) {
      const passing = all.filter((t) => passes(this.filter, t));
      shown = passing.length === all.length ? all : passing;
      this.kept.set(all, shown);
    }
    return shown;
  }
}
