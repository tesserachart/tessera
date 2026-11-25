import {
  AGG_CAPACITY,
  AggTape,
  BookStore,
  groupingKey,
  TickGrid,
  TradeTape,
  type Grouping,
  type TimeSpan,
} from '@tessera/chart';
import {
  computeBackoffDelay,
  normalizeEpochMs,
  Runtime,
  type AggressorSource,
  type BackoffOptions,
  type BigTradeThreshold,
  type DataSource,
  type DepthUpdate,
  type PrintGap,
  type PrintsLoaded,
  type SubscriptionEvent,
  type Timeframe,
  type TradesUpdate,
} from '@tessera/protocol';
import { Lifetime } from '../../app/lifetime.ts';
import { appClient } from '../../app/services.ts';
import { WarmPool } from '../../app/warm.ts';
import { feedErrorWords } from '../../shell/deskWords.ts';
import { BigTradeFeed, LiveBigTrades } from './bigTrades.ts';
import { FootprintFeed } from './footprints.ts';
import { ProfileFeed } from './profiles.ts';

export interface FlowClock {
  now(): number;
}

export class Emitter<T = void> {
  private readonly listeners = new Set<(value: T) => void>();

  on(cb: (value: T) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(value: T): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(value);
      } catch (err) {
        console.error('[flow] listener failed', err);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

export interface FlowSource {
  source: DataSource | null;
  aggressorSource: AggressorSource | null;
}

export interface FlowStatus {
  readonly reading: boolean;
  readonly error: string | null;
  readonly loaded?: Loaded | null;
}

export interface Loaded {
  readonly loaded: PrintsLoaded;
  readonly filling: boolean;
}

export const DEFAULT_DAYS_TO_LOAD = 2;

export function loadedOf(answer: { readonly loaded: PrintsLoaded; readonly filling: boolean }): Loaded | null {
  return answer.loaded.held < answer.loaded.sessions ? { loaded: answer.loaded, filling: answer.filling } : null;
}

export function withLoaded(status: FlowStatus, loaded: Loaded | null): FlowStatus {
  return loaded ? { ...status, loaded } : status;
}

function missing(l: Loaded): boolean {
  return l.loaded.held < l.loaded.sessions;
}

export function mostLoading(all: readonly (Loaded | null | undefined)[]): Loaded | null {
  const known = all.filter((l): l is Loaded => l !== null && l !== undefined);
  return (
    known.find((l) => l.filling && missing(l)) ?? known.find((l) => l.loaded.refused && missing(l)) ?? known[0] ?? null
  );
}

export const NO_GAPS: readonly TimeSpan[] = [];

export function gapsOf(gaps: readonly PrintGap[]): TimeSpan[] {
  return gaps.map((g) => ({ from: normalizeEpochMs(g.from), to: normalizeEpochMs(g.to) }));
}

export function settledGapsOf(answer: {
  readonly gaps: readonly PrintGap[];
  readonly filling: boolean;
}): TimeSpan[] | null {
  return answer.filling ? null : gapsOf(answer.gaps);
}

export function joinGaps(spans: readonly TimeSpan[]): readonly TimeSpan[] {
  if (spans.length === 0) return NO_GAPS;
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const joined: TimeSpan[] = [];
  for (const s of sorted) {
    const last = joined.at(-1);
    if (last && s.from <= last.to) joined[joined.length - 1] = { from: last.from, to: Math.max(last.to, s.to) };
    else joined.push(s);
  }
  return joined;
}

export function spliceGaps(
  held: readonly TimeSpan[],
  from: number,
  to: number,
  fresh: readonly TimeSpan[],
): readonly TimeSpan[] {
  const kept: TimeSpan[] = [];
  for (const g of held) {
    if (g.to <= from || g.from >= to) {
      kept.push(g);
      continue;
    }
    if (g.from < from) kept.push({ from: g.from, to: from });
    if (g.to > to) kept.push({ from: to, to: g.to });
  }
  return joinGaps([...kept, ...fresh]);
}

export function sameGaps(a: readonly TimeSpan[], b: readonly TimeSpan[]): boolean {
  return a.length === b.length && a.every((g, k) => g.from === b[k]!.from && g.to === b[k]!.to);
}

const SESSION_AGAIN: BackoffOptions = { initialDelayMs: 1_000, maxDelayMs: 5_000, factor: 1.5, jitter: 0.2 };

export function sessionAgainMs(attempt: number): number {
  return computeBackoffDelay(attempt, SESSION_AGAIN);
}

export class Refill {
  private readonly asking = new Map<string, () => boolean>();

  constructor(private readonly running: Lifetime) {}

  ask<A extends { readonly filling: boolean }>(
    key: string,
    question: () => Promise<A>,
    settled: (answer: A) => void,
    progress?: (answer: A) => void,
  ): void {
    if (this.asking.get(key)?.() === true) return;
    const live = this.running.live();
    let open = true;
    const asking = () => open && live();
    this.asking.set(key, asking);
    const end = () => {
      open = false;
      if (this.asking.get(key) === asking) this.asking.delete(key);
    };
    const again = (attempt: number) =>
      this.running.after(sessionAgainMs(attempt), () =>
        this.running.run(
          question,
          (answer) => {
            if (answer.filling) {
              progress?.(answer);
              again(attempt + 1);
              return;
            }
            end();
            settled(answer);
          },
          end,
        ),
      );
    again(1);
  }
}

export class Uses {
  private n = 0;
  private lingering: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly start: () => void,
    private readonly stop: () => void,
    private readonly keepMs = 0,
  ) {}

  use(): () => void {
    if (this.lingering !== null) {
      clearTimeout(this.lingering);
      this.lingering = null;
    } else if (this.n === 0) this.start();
    this.n++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.n > 0) return;
      if (this.keepMs <= 0) this.stop();
      else
        this.lingering = setTimeout(() => {
          this.lingering = null;
          this.stop();
        }, this.keepMs);
    };
  }

  end(): void {
    if (this.lingering === null) return;
    clearTimeout(this.lingering);
    this.lingering = null;
    this.stop();
  }

  get count(): number {
    return this.n;
  }

  get running(): boolean {
    return this.n > 0 || this.lingering !== null;
  }
}

function feedErrorAfter(signal: Runtime.TopicSignal<unknown>, current: string | null): string | null {
  if (signal._tag === 'Ended' || signal._tag === 'Refused') return feedErrorWords(signal.error);
  return signal._tag === 'Event' ? null : current;
}

const FLOW_KEEP_MS = 2 * 60_000;

const FLOW_KEEP_MAX = 2;

export class InstrumentFlow {
  readonly instrument: string;
  readonly grid: TickGrid;
  readonly book: BookStore;
  readonly tape: TradeTape;
  readonly agg: AggTape;
  readonly bigs = new LiveBigTrades();
  readonly bookChanged = new Emitter();
  readonly tradesChanged = new Emitter();
  readonly statusChanged = new Emitter();
  readonly info: FlowSource = { source: null, aggressorSource: null };
  threshold: BigTradeThreshold | null = null;
  depthError: string | null = null;
  tradesError: string | null = null;
  private segment: number | undefined;
  readonly clock: FlowClock;
  private readonly bookStream = new Lifetime();
  private readonly tradeStream = new Lifetime();
  private readonly reads = new Lifetime();
  private readonly footprintFeeds = new Map<string, { feed: FootprintFeed; uses: Uses }>();
  private readonly profileFeeds = new Map<number, { feed: ProfileFeed; uses: Uses }>();
  private readonly bigFeeds = new Map<string, { feed: BigTradeFeed; uses: Uses }>();
  private readonly groupedAggs = new Map<string, { agg: AggTape; users: number }>();
  private thresholdDay = '';
  private thresholdLoading = false;
  readonly bookUses: Uses;
  readonly tradeUses: Uses;
  private readonly keepMs: number;

  constructor(instrument: string, tick: number, decimals: number, clock: FlowClock, keepMs = 0) {
    this.instrument = instrument;
    this.grid = new TickGrid(tick, decimals);
    this.book = new BookStore(this.grid);
    this.tape = new TradeTape(this.grid);
    this.agg = new AggTape(this.tape);
    this.clock = clock;
    this.keepMs = keepMs;
    this.bookUses = new Uses(
      () => this.followBook(),
      () => this.bookStream.end(),
      keepMs,
    );
    this.tradeUses = new Uses(
      () => this.followTrades(),
      () => this.tradeStream.end(),
      keepMs,
    );
  }

  useBook(): () => void {
    return this.bookUses.use();
  }

  private followBook(): void {
    this.book.reset();
    const stop = this.bookStream.topic(
      'market.depth',
      { instrument: this.instrument },
      (e) => {
        this.noteFeed('depthError', e);
        if (e._tag !== 'Ended' && !this.onBook(e)) {
          stop();
          this.followBook();
        }
      },
      { invalid: 'log' },
    );
  }

  private onBook(e: SubscriptionEvent<DepthUpdate>): boolean {
    if (e._tag === 'Gap') return false;
    if (e._tag === 'Resubscribed') this.book.reset();
    if (e._tag !== 'Event') return true;
    const u = e.data;
    if (e.meta.seq === 0) this.book.reset();
    this.info.source = u.source;
    const r = this.book.apply(u, this.clock.now());
    if (r === 'gap') return false;
    if (r === 'applied' || r === 'alive') this.bookChanged.emit();
    return true;
  }

  private noteFeed(feed: 'depthError' | 'tradesError', signal: Runtime.TopicSignal<unknown>): void {
    const error = feedErrorAfter(signal, this[feed]);
    if (error === this[feed]) return;
    this[feed] = error;
    this.statusChanged.emit();
  }

  useTrades(): () => void {
    return this.tradeUses.use();
  }

  private followTrades(): void {
    const stop = this.tradeStream.topic(
      'market.trades',
      { instruments: [this.instrument] },
      (e) => {
        this.noteFeed('tradesError', e);
        if (e._tag !== 'Ended' && !this.onTrades(e)) {
          stop();
          this.followTrades();
        }
      },
      { invalid: 'log' },
    );
  }

  private onTrades(e: SubscriptionEvent<TradesUpdate>): boolean {
    if (e._tag === 'Gap') return false;
    if (e._tag !== 'Event') return true;
    const u = e.data;
    const reconnected = u.segment !== undefined && this.segment !== undefined && u.segment !== this.segment;
    if (u.segment !== undefined) this.segment = u.segment;
    const snapshot = e.meta.seq === 0 || reconnected;
    this.info.source = u.source;
    if (u.aggressorSource) this.info.aggressorSource = u.aggressorSource;
    const batch = { seq: u.seq, trades: u.trades };
    if (reconnected) this.tape.reset();
    const r = snapshot ? this.tape.applySnapshot(batch) : this.tape.apply(batch);
    if (r === 'gap') return false;
    if (snapshot) this.bigs.reset();
    const found = u.bigTrades?.length ?? 0;
    if (found > 0) this.bigs.apply(u.bigTrades!, this.tape);
    if (r === 'applied') {
      this.agg.sync();
      for (const g of this.groupedAggs.values()) g.agg.sync();
    }
    if (r === 'applied' || found > 0) this.tradesChanged.emit();
    return true;
  }

  loadThreshold(): void {
    const day = new Date(this.clock.now()).toISOString().slice(0, 10);
    if (this.thresholdLoading || (this.threshold && this.thresholdDay === day)) return;
    this.thresholdLoading = true;
    const loaded = this.reads.hold(() => {
      this.thresholdLoading = false;
    });
    this.reads.run(
      () =>
        Runtime.invoke(appClient(), 'market.get_trades', {
          instrument: this.instrument,
          minSize: 'auto',
          aggregate: true,
          limit: 1,
        }),
      (out) => {
        this.threshold = out.threshold;
        this.thresholdDay = day;
        if (out.aggressorSource) this.info.aggressorSource = out.aggressorSource;
        this.tradesChanged.emit();
        loaded();
      },
      loaded,
    );
  }

  useFootprints(tf: Timeframe, days = DEFAULT_DAYS_TO_LOAD): { feed: FootprintFeed; release: () => void } {
    const key = `${tf}|${String(days)}`;
    let entry = this.footprintFeeds.get(key);
    if (!entry) {
      const feed = new FootprintFeed(this, tf, days);
      const made: { feed: FootprintFeed; uses: Uses } = {
        feed,
        uses: new Uses(
          () => feed.start(),
          () => {
            feed.stop();
            this.footprintFeeds.delete(key);
          },
          this.keepMs,
        ),
      };
      this.footprintFeeds.set(key, made);
      entry = made;
    }
    return { feed: entry.feed, release: entry.uses.use() };
  }

  useProfiles(days = DEFAULT_DAYS_TO_LOAD): { feed: ProfileFeed; release: () => void } {
    let entry = this.profileFeeds.get(days);
    if (!entry) {
      const feed = new ProfileFeed(this, days);
      const made = {
        feed,
        uses: new Uses(
          () => feed.start(),
          () => {
            feed.stop();
            if (this.profileFeeds.get(days) === made) this.profileFeeds.delete(days);
          },
          this.keepMs,
        ),
      };
      this.profileFeeds.set(days, made);
      entry = made;
    }
    return { feed: entry.feed, release: entry.uses.use() };
  }

  useAgg(grouping: Grouping): { agg: AggTape; release: () => void } {
    const key = groupingKey(grouping);
    if (key === groupingKey(this.agg.grouping)) return { agg: this.agg, release: () => undefined };
    let entry = this.groupedAggs.get(key);
    if (!entry) {
      entry = { agg: new AggTape(this.tape, AGG_CAPACITY, grouping), users: 0 };
      entry.agg.sync();
      this.groupedAggs.set(key, entry);
    }
    const used = entry;
    used.users++;
    let released = false;
    return {
      agg: used.agg,
      release: () => {
        if (released) return;
        released = true;
        if (--used.users === 0) this.groupedAggs.delete(key);
      },
    };
  }

  useBigTrades(grouping: Grouping, days = DEFAULT_DAYS_TO_LOAD): { feed: BigTradeFeed; release: () => void } {
    const key = `${groupingKey(grouping)}|${String(days)}`;
    let entry = this.bigFeeds.get(key);
    if (!entry) {
      const feed = new BigTradeFeed(this, grouping, days);
      const made: { feed: BigTradeFeed; uses: Uses } = {
        feed,
        uses: new Uses(
          () => feed.start(),
          () => {
            feed.stop();
            this.bigFeeds.delete(key);
          },
          this.keepMs,
        ),
      };
      this.bigFeeds.set(key, made);
      entry = made;
    }
    return { feed: entry.feed, release: entry.uses.use() };
  }

  dispose(): void {
    for (const uses of [
      this.bookUses,
      this.tradeUses,
      ...[...this.footprintFeeds.values(), ...this.bigFeeds.values(), ...this.profileFeeds.values()].map((e) => e.uses),
    ])
      uses.end();
    this.bookStream.end();
    this.tradeStream.end();
    this.reads.end();
    for (const e of this.footprintFeeds.values()) e.feed.stop();
    for (const e of this.bigFeeds.values()) e.feed.stop();
    for (const e of this.profileFeeds.values()) e.feed.stop();
    this.footprintFeeds.clear();
    this.bigFeeds.clear();
    this.groupedAggs.clear();
    this.profileFeeds.clear();
  }
}

export class FlowHub {
  readonly clock: FlowClock;
  private readonly keepMs: number;
  private readonly pool: WarmPool<InstrumentFlow>;

  constructor(clock: FlowClock, keep: { keepMs?: number; maxIdle?: number } = {}) {
    this.clock = clock;
    this.keepMs = keep.keepMs ?? FLOW_KEEP_MS;
    this.pool = new WarmPool<InstrumentFlow>({
      dispose: (flow) => flow.dispose(),
      keepMs: this.keepMs,
      maxIdle: keep.maxIdle ?? FLOW_KEEP_MAX,
    });
  }

  acquire(instrument: string, tick: number, decimals: number): { flow: InstrumentFlow; release: () => void } {
    const { value, release } = this.pool.acquire(
      `${instrument}|${String(tick)}`,
      () => new InstrumentFlow(instrument, tick, decimals, this.clock, this.keepMs),
    );
    return { flow: value, release };
  }

  get size(): number {
    return this.pool.size;
  }
}

const hubs = new WeakMap<FlowClock, FlowHub>();

export function flowHub(clock: FlowClock): FlowHub {
  let hub = hubs.get(clock);
  if (!hub) {
    hub = new FlowHub(clock);
    hubs.set(clock, hub);
  }
  return hub;
}
