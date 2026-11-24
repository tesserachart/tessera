import { CHART_MAX_BARS, SeriesStore, type BarTuple } from '@tessera/chart';
import {
  msToNs,
  normalizeEpochMs,
  Runtime,
  type BackoffOptions,
  type BarUpdate,
  type CandlesOutput,
  type CompactBar,
  type GetCandlesInput,
  type GetSessionsInput,
  type HistoryUpdate,
  type SessionFilter,
  type SessionsOutput,
  type Timeframe,
  isSessionTimeframe,
  timeframeMs,
} from '@tessera/protocol';
import { Lifetime, retrying } from '../app/lifetime.ts';
import { onMarketServed } from '../app/health.ts';
import { appClient, servicesStore } from '../app/services.ts';
import { toolCode } from '../app/tools.ts';
import { refusedByFeed, retryFeedError } from '../shell/deskWords.ts';
import { WarmPool, type PoolTimers } from '../app/warm.ts';
import { asksFrontMonths, contractSpans, withSpans, type ContractSpan } from './frontMonths.ts';
import { sessionsInput } from '../markets/sessions.ts';

export const READ_RETRY: BackoffOptions = { initialDelayMs: 1_000, maxDelayMs: 30_000, factor: 2, jitter: 0.3 };

function unanswered(err: unknown): boolean {
  return retryFeedError(err) && toolCode(err) !== 'unavailable';
}

const KEPT_FIRST_BARS = 5_000;

const PAGE_BARS = 2_000;

export const SNAPSHOT_BARS = 1_500;

const PAGE_RETRY_MS = 5_000;

const GAP_REFETCH_MS = 5_000;

const BARS_KEEP_MS = 5 * 60_000;

const BARS_KEEP_MAX = 8;

const RTH_TAIL_BARS = 2;

const RTH_TAIL_EVERY_MS = 2_000;

export const WARM_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h'];

export function toBarTuple(b: CompactBar): BarTuple {
  return b.length === 7
    ? [normalizeEpochMs(b[0]), b[1], b[2], b[3], b[4], b[5], b[6]]
    : [normalizeEpochMs(b[0]), b[1], b[2], b[3], b[4], b[5]];
}

export interface BarsHead {
  instrument: string;
  priceDecimals: number;
  provider: string;
  contracts: readonly ContractSpan[];
}

export type HistoryEnd = 'start' | 'refused' | 'cap' | 'sessions';

export interface BarsSink {
  reset(): void;
  update(bar: BarTuple): void;
  prepend(bars: readonly BarTuple[]): void;
  live(head: BarsHead, bars: number): void;
  error(error: Error): void;
  olderRefused(error: Error): void;
  ended(end: HistoryEnd): void;
}

export interface BarsReader {
  candles: (input: GetCandlesInput) => Promise<CandlesOutput>;
  sessions?: (input: GetSessionsInput) => Promise<SessionsOutput>;
}

const runtimeReader: BarsReader = {
  candles: (input) => Runtime.invoke(appClient(), 'market.get_candles', input),
  sessions: (input) => Runtime.invoke(appClient(), 'market.get_sessions', input),
};

type Span = { readonly from: number; readonly to: number };

type RthPlace = 'inside' | 'outside' | 'across';

class RegularHours {
  private windows: readonly Span[] = [];
  private known: Span | null = null;

  take(out: SessionsOutput): void {
    const ms = (w: { start: number; end: number }) => ({
      from: normalizeEpochMs(w.start),
      to: normalizeEpochMs(w.end),
    });
    this.windows = out.sessions.flatMap((s) => (s.rth ? [ms(s.rth)] : []));
    const first = out.sessions[0];
    const last = out.sessions.at(-1);
    this.known = first && last ? { from: normalizeEpochMs(first.open), to: normalizeEpochMs(last.close) } : null;
  }

  knows(t: number): boolean {
    return this.known !== null && t >= this.known.from && t < this.known.to;
  }

  place(from: number, to: number): RthPlace | null {
    if (!this.knows(from)) return null;
    for (const w of this.windows) {
      if (from >= w.from && to <= w.to) return 'inside';
      if (from < w.to && to > w.from) return 'across';
    }
    return 'outside';
  }
}

export class BarSource {
  readonly instrument: string;
  readonly tf: Timeframe;
  readonly session: SessionFilter;
  readonly series = new SeriesStore(2048);
  head: BarsHead | null = null;
  live = false;
  error: Error | null = null;
  olderRefused: Error | null = null;
  historyEnd: HistoryEnd | null = null;
  private readonly sinks = new Set<BarsSink>();
  private readonly reader: BarsReader;
  private readonly market = new Lifetime();
  private readonly read = new Lifetime();
  private buffer: BarUpdate[] = [];
  private lastRefetch = 0;
  private keptFrom: number | null = null;
  private keptAsked: { first: number; from: number } | null = null;
  private fetching = false;
  private fetchAgain = false;
  private reading = false;
  private exhausted = false;
  private pageRetryAt = 0;
  private started = false;
  private shown = false;
  private readonly rth: RegularHours | null;
  private readingHours = false;
  private tailAt = 0;
  private tailing = false;

  constructor(instrument: string, tf: Timeframe, reader: BarsReader = runtimeReader, session: SessionFilter = 'all') {
    this.instrument = instrument;
    this.tf = tf;
    this.reader = reader;
    this.session = session;
    this.rth = session === 'rth' ? new RegularHours() : null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.rth) this.readHours();
    this.follow();
    if (this.tf !== '1s') this.readKeptFirst();
    this.fetch();
  }

  stop(): void {
    this.read.end();
    this.market.end();
    this.sinks.clear();
    this.buffer = [];
    this.live = false;
  }

  get settled(): boolean {
    return this.live || this.error !== null;
  }

  attach(sink: BarsSink): () => void {
    if (!this.shown) {
      this.shown = true;
      if (this.tf !== '1s') this.followHistory();
    }
    this.sinks.add(sink);
    if (this.series.length > 0) sink.reset();
    if (this.live && this.head) sink.live(this.head, this.series.length);
    else if (this.error) sink.error(this.error);
    if (this.olderRefused) sink.olderRefused(this.olderRefused);
    if (this.historyEnd) sink.ended(this.historyEnd);
    return () => {
      this.sinks.delete(sink);
    };
  }

  bars(): BarTuple[] {
    const s = this.series;
    const out = new Array<BarTuple>(s.length);
    for (let i = 0; i < s.length; i++) {
      const bv = s.buyVolume[i]!;
      out[i] = Number.isNaN(bv)
        ? [s.time[i]!, s.open[i]!, s.high[i]!, s.low[i]!, s.close[i]!, s.volume[i]!]
        : [s.time[i]!, s.open[i]!, s.high[i]!, s.low[i]!, s.close[i]!, s.volume[i]!, bv];
    }
    return out;
  }

  reload(): void {
    this.fetch();
  }

  pageOlder(): void {
    const first = this.firstHeld();
    if (first === null || !this.live || this.reading || this.exhausted) return;
    if (this.series.length >= CHART_MAX_BARS) return this.end('cap');
    if (Date.now() < this.pageRetryAt) return;
    this.older(first, { limit: Math.min(PAGE_BARS, CHART_MAX_BARS - this.series.length), cachedOnly: false });
  }

  private each(fn: (sink: BarsSink) => void): void {
    for (const sink of [...this.sinks]) {
      try {
        fn(sink);
      } catch (err) {
        console.error(`[bars] a chart of ${this.instrument} ${this.tf} failed to take its bars`, err);
      }
    }
  }

  private end(end: HistoryEnd): void {
    this.exhausted = true;
    if (this.historyEnd === end) return;
    this.historyEnd = end;
    this.each((s) => s.ended(end));
  }

  private fail(error: Error): void {
    this.error = error;
    this.each((s) => s.error(error));
  }

  private follow(): void {
    this.market.topic(
      'market.bars',
      { instrument: this.instrument, tf: this.tf },
      (e) => {
        if (e._tag === 'Event') {
          if (e.data.tf !== this.tf) return;
          if (this.fetching) this.buffer.push(e.data);
          if (!this.live) return;
          const bar = this.shownBar(e.data);
          if (bar && this.series.upsert(bar)) this.each((s) => s.update(bar));
        } else if (e._tag === 'Resubscribed') {
          this.fetch();
        } else if (e._tag === 'Gap') {
          const now = Date.now();
          if (now - this.lastRefetch < GAP_REFETCH_MS) return;
          this.lastRefetch = now;
          this.fetch();
        } else if (e._tag === 'Refused' || e._tag === 'Ended') {
          this.fail(e.error);
        }
      },
      { invalid: 'log' },
    );
  }

  private followHistory(): void {
    this.market.topic(
      'market.history',
      { instrument: this.instrument, tf: this.tf },
      (e) => {
        if (e._tag !== 'Event') return;
        const h: HistoryUpdate = e.data;
        this.keptFrom = h.from === null ? null : normalizeEpochMs(h.from);
        this.readKept();
      },
      { invalid: 'log' },
    );
  }

  private readKeptFirst(): void {
    const live = this.market.live();
    this.reader.candles({ ...this.ask(), limit: KEPT_FIRST_BARS, cachedOnly: true }).then(
      (out) => {
        if (!live() || this.live || out.bars.length === 0) return;
        this.head = {
          instrument: out.instrument,
          priceDecimals: out.priceDecimals,
          provider: out.provider,
          contracts: contractSpans(out.contracts),
        };
        this.series.setData(out.bars.map(toBarTuple));
        this.each((s) => s.reset());
      },
      () => undefined,
    );
  }

  private fetch(): void {
    if (this.fetching) {
      this.fetchAgain = true;
      return;
    }
    this.fetching = true;
    const live = this.read.live();
    const done = this.read.hold(() => {
      this.fetching = false;
      this.buffer = [];
    });
    const attempt = async () => {
      try {
        return await this.reader.candles({ ...this.ask(), limit: SNAPSHOT_BARS });
      } catch (err) {
        if (live() && !unanswered(err)) this.fail(err as Error);
        throw err;
      }
    };
    const fetched = () => {
      done();
      if (!this.fetchAgain) return;
      this.fetchAgain = false;
      this.fetch();
    };
    this.read.run(
      () => retrying(attempt, { again: retryFeedError, live, backoff: READ_RETRY, wake: onMarketServed }),
      (out) => {
        this.apply(out);
        fetched();
      },
      fetched,
    );
  }

  private apply(out: CandlesOutput): void {
    const fresh = out.bars.map(toBarTuple);
    const s = this.series;
    const first = fresh[0]?.[0];
    const older: BarTuple[] = [];
    if (s.length > 0 && first !== undefined && first <= s.time[s.length - 1]!) {
      for (let i = 0; i < s.length && s.time[i]! < first; i++) {
        const bv = s.buyVolume[i]!;
        older.push(
          Number.isNaN(bv)
            ? [s.time[i]!, s.open[i]!, s.high[i]!, s.low[i]!, s.close[i]!, s.volume[i]!]
            : [s.time[i]!, s.open[i]!, s.high[i]!, s.low[i]!, s.close[i]!, s.volume[i]!, bv],
        );
      }
    }
    s.setData(older.length > 0 ? older.concat(fresh) : fresh);
    const pending = this.buffer;
    this.buffer = [];
    for (const ev of pending) {
      const bar = this.rth ? this.inRth(toBarTuple(ev.bar), false) : toBarTuple(ev.bar);
      if (bar) s.upsert(bar);
    }
    const held = older.length > 0 ? (this.head?.contracts ?? []).filter((c) => c.from < first!) : [];
    this.head = {
      instrument: out.instrument,
      priceDecimals: out.priceDecimals,
      provider: out.provider,
      contracts: withSpans(held, contractSpans(out.contracts)),
    };
    this.live = true;
    this.error = null;
    const head = this.head;
    this.each((sink) => {
      sink.reset();
      sink.live(head, s.length);
    });
    this.readKept();
  }

  private ask(): GetCandlesInput {
    return {
      instrument: this.instrument,
      tf: this.tf,
      ...(this.session === 'rth' ? { session: 'rth' as const } : {}),
      ...(asksFrontMonths(this.tf) ? { frontMonths: true } : {}),
    };
  }

  private shownBar(u: BarUpdate): BarTuple | null {
    const bar = toBarTuple(u.bar);
    return this.rth ? this.inRth(bar, true) : bar;
  }

  private inRth(bar: BarTuple, readAcross: boolean): BarTuple | null {
    const rth = this.rth!;
    const t = bar[0];
    const place = isSessionTimeframe(this.tf) ? 'across' : rth.place(t, t + timeframeMs(this.tf));
    if (place === 'inside') return bar;
    if (place === null) this.readHours();
    if (place !== 'outside' && readAcross) this.readTail();
    return null;
  }

  private readHours(): void {
    const read = this.reader.sessions;
    if (!read || this.readingHours) return;
    this.readingHours = true;
    const done = this.market.hold(() => {
      this.readingHours = false;
    });
    this.market.run(
      () => read(sessionsInput(this.instrument, Date.now())),
      (out) => {
        done();
        this.rth?.take(out);
      },
      () => done(),
    );
  }

  private readTail(): void {
    const now = Date.now();
    if (this.tailing || this.fetching || now - this.tailAt < RTH_TAIL_EVERY_MS) return;
    this.tailing = true;
    this.tailAt = now;
    const done = this.market.hold(() => {
      this.tailing = false;
    });
    this.market.run(
      () => this.reader.candles({ ...this.ask(), limit: RTH_TAIL_BARS }),
      (out) => {
        done();
        for (const bar of out.bars.map(toBarTuple)) {
          if (this.series.upsert(bar)) this.each((s) => s.update(bar));
        }
      },
      () => done(),
    );
  }

  private firstHeld(): number | null {
    return this.series.length > 0 ? this.series.time[0]! : null;
  }

  private readKept(): void {
    const from = this.keptFrom;
    const first = this.firstHeld();
    if (!this.live || this.reading || from === null || first === null) return;
    if (from >= first || this.series.length >= CHART_MAX_BARS) return;
    if (this.keptAsked?.first === first && this.keptAsked.from === from) return;
    this.keptAsked = { first, from };
    this.older(first, { limit: CHART_MAX_BARS - this.series.length, cachedOnly: true });
  }

  private older(first: number, ask: { limit: number; cachedOnly: boolean }): void {
    this.reading = true;
    const done = this.market.hold(() => {
      this.reading = false;
    });
    this.market.run(
      () =>
        this.reader.candles({
          ...this.ask(),
          to: msToNs(first - 1),
          limit: ask.limit,
          ...(ask.cachedOnly ? { cachedOnly: true } : {}),
        }),
      (out) => {
        done();
        const bars = out.bars.map(toBarTuple);
        const added = this.series.prepend(bars);
        if (added === 0 && !ask.cachedOnly) this.end('start');
        if (added > 0) {
          const taken = bars.filter((b) => b[0] < first);
          this.each((s) => s.prepend(taken));
          if (out.contracts && this.head) {
            const head = { ...this.head, contracts: withSpans(this.head.contracts, contractSpans(out.contracts)) };
            this.head = head;
            this.each((s) => s.live(head, this.series.length));
          }
          this.readKept();
        }
      },
      (err) => {
        done();
        if (ask.cachedOnly) return;
        const code = toolCode(err);
        if (refusedByFeed(err)) {
          const refused = err as Error;
          this.olderRefused = refused;
          this.each((s) => s.olderRefused(refused));
          this.end('refused');
        } else if (code === 'invalid_input' || code === 'unsupported' || code === 'not_found') {
          this.end('start');
        } else {
          this.pageRetryAt = Date.now() + PAGE_RETRY_MS;
        }
      },
    );
  }
}

const keyOf = (instrument: string, tf: Timeframe, session: SessionFilter) => `${instrument}|${tf}|${session}`;

function ofKey(key: string): { instrument: string; tf: Timeframe; session: SessionFilter } {
  const [session, tf, ...instrument] = key.split('|').reverse();
  return { instrument: instrument.reverse().join('|'), tf: tf as Timeframe, session: session as SessionFilter };
}

export class BarSources {
  private readonly pool: WarmPool<BarSource>;

  constructor(options: { keepMs?: number; maxIdle?: number; reader?: BarsReader; timers?: PoolTimers } = {}) {
    this.pool = new WarmPool<BarSource>({
      make: (key) => {
        const { instrument, tf, session } = ofKey(key);
        const source = new BarSource(instrument, tf, options.reader, session);
        source.start();
        return source;
      },
      dispose: (source) => source.stop(),
      keepMs: options.keepMs ?? BARS_KEEP_MS,
      maxIdle: options.maxIdle ?? BARS_KEEP_MAX,
      ...(options.timers ? { timers: options.timers } : {}),
    });
  }

  acquire(
    instrument: string,
    tf: Timeframe,
    session: SessionFilter = 'all',
  ): { source: BarSource; release: () => void } {
    const { value, release } = this.pool.acquire(keyOf(instrument, tf, session));
    return { source: value, release };
  }

  warm(instrument: string, shown: Timeframe | null, session: SessionFilter = 'all'): () => void {
    const held = WARM_TIMEFRAMES.filter((tf) => tf !== shown).map((tf) => this.acquire(instrument, tf, session));
    return () => {
      for (const h of held) h.release();
    };
  }

  get size(): number {
    return this.pool.size;
  }

  get idle(): number {
    return this.pool.idle;
  }

  clear(): void {
    this.pool.clear();
  }
}

let windowSources: BarSources | null = null;

export function barSources(): BarSources {
  if (!windowSources) {
    const sources = new BarSources();
    windowSources = sources;
    const off = servicesStore.subscribe(() => {
      off();
      sources.clear();
      if (windowSources === sources) windowSources = null;
    });
  }
  return windowSources;
}
