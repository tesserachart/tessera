import { SeriesStore, type BarTuple } from '@tessera/chart';
import { Runtime, type GetPrintBarsInput, type PrintBars, type PrintBarsOutput } from '@tessera/protocol';
import { Lifetime, retrying } from '../app/lifetime.ts';
import { onMarketServed } from '../app/health.ts';
import { appClient, servicesStore } from '../app/services.ts';
import { WarmPool } from '../app/warm.ts';
import { retryFeedError } from '../shell/deskWords.ts';
import { READ_RETRY, toBarTuple, type BarsHead, type BarsSink, type HistoryEnd } from './bars.ts';
import { printBarsKey } from './instruments.ts';
import { FIRST_PRINT_BAR_SESSIONS, MAX_PRINT_BAR_SESSIONS } from './intervals.ts';

const PRINT_BARS_REFRESH_MS = 1_000;

export interface PrintBarsReader {
  read: (input: GetPrintBarsInput) => Promise<PrintBarsOutput>;
}

const runtimeReader: PrintBarsReader = {
  read: (input) => Runtime.invoke(appClient(), 'market.get_print_bars', input),
};

export type BarChange = { kind: 'reset' } | { kind: 'update'; bars: BarTuple[] } | { kind: 'same' };

export function changeOf(held: readonly BarTuple[], fresh: readonly BarTuple[]): BarChange {
  if (held.length === 0 || fresh.length < held.length) return { kind: 'reset' };
  const lastHeld = held.length - 1;
  for (let i = 0; i < lastHeld; i++) {
    if (!same(held[i]!, fresh[i]!)) return { kind: 'reset' };
  }
  const tail = fresh.slice(lastHeld);
  if (tail.length === 1 && same(tail[0]!, held[lastHeld]!)) return { kind: 'same' };
  if (tail[0]![0] !== held[lastHeld]![0]) return { kind: 'reset' };
  return { kind: 'update', bars: tail };
}

function same(a: BarTuple, b: BarTuple): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export class PrintBarSource {
  readonly instrument: string;
  readonly kind: PrintBars;
  readonly series = new SeriesStore(2048);
  head: BarsHead | null = null;
  error: Error | null = null;
  historyEnd: HistoryEnd | null = null;
  sessions = FIRST_PRINT_BAR_SESSIONS;
  private held: BarTuple[] = [];
  private widened: number | null = null;
  private readonly sinks = new Set<BarsSink>();
  private readonly reader: PrintBarsReader;
  private readonly life = new Lifetime();
  private reading = false;

  constructor(instrument: string, kind: PrintBars, reader: PrintBarsReader = runtimeReader) {
    this.instrument = instrument;
    this.kind = kind;
    this.reader = reader;
  }

  start(): void {
    this.fetch();
    this.life.every(PRINT_BARS_REFRESH_MS, () => this.fetch());
  }

  stop(): void {
    this.life.end();
    this.sinks.clear();
  }

  get settled(): boolean {
    return this.head !== null || this.error !== null;
  }

  attach(sink: BarsSink): () => void {
    this.sinks.add(sink);
    if (this.series.length > 0) sink.reset();
    if (this.head) sink.live(this.head, this.series.length);
    else if (this.error) sink.error(this.error);
    if (this.historyEnd) sink.ended(this.historyEnd);
    return () => {
      this.sinks.delete(sink);
    };
  }

  bars(): BarTuple[] {
    return [...this.held];
  }

  reload(): void {
    this.fetch();
  }

  pageOlder(): void {
    if (this.head === null || this.reading || this.historyEnd) return;
    if (this.sessions >= MAX_PRINT_BAR_SESSIONS) return this.end('sessions');
    this.sessions += 1;
    this.widened = this.held[0]?.[0] ?? null;
    this.fetch();
  }

  private end(end: HistoryEnd): void {
    if (this.historyEnd === end) return;
    this.historyEnd = end;
    for (const s of this.sinks) s.ended(end);
  }

  private fetch(): void {
    if (this.reading) return;
    this.reading = true;
    const live = this.life.live();
    const sessions = this.sessions;
    void retrying(() => this.reader.read({ instrument: this.instrument, bars: this.kind, sessions }), {
      again: retryFeedError,
      live,
      backoff: READ_RETRY,
      wake: onMarketServed,
    }).then(
      (out) => {
        this.reading = false;
        if (live()) this.apply(out);
      },
      (err: unknown) => {
        this.reading = false;
        if (!live()) return;
        this.error = err as Error;
        for (const s of this.sinks) s.error(this.error);
      },
    );
  }

  private apply(out: PrintBarsOutput): void {
    const fresh = out.candles.map(toBarTuple);
    const change = changeOf(this.held, fresh);
    const widenedFrom = this.widened;
    this.widened = null;
    if (widenedFrom !== null && (fresh[0]?.[0] ?? widenedFrom) >= widenedFrom) this.end('start');
    this.held = fresh;
    this.error = null;
    this.head = { instrument: out.instrument, priceDecimals: out.priceDecimals, provider: 'print-bars', contracts: [] };
    if (change.kind === 'reset') {
      this.series.setData(fresh);
      for (const s of this.sinks) s.reset();
    } else if (change.kind === 'update') {
      for (const bar of change.bars) {
        this.series.upsert(bar);
        for (const s of this.sinks) s.update(bar);
      }
    }
    for (const s of this.sinks) s.live(this.head, this.series.length);
  }
}

export class PrintBarSources {
  private readonly pool = new WarmPool<PrintBarSource>({ dispose: (s) => s.stop(), keepMs: 0, maxIdle: 0 });

  constructor(private readonly reader: PrintBarsReader = runtimeReader) {}

  acquire(instrument: string, bars: PrintBars): { source: PrintBarSource; release: () => void } {
    const { value, release } = this.pool.acquire(`${instrument}|${printBarsKey(bars)}`, () => {
      const source = new PrintBarSource(instrument, bars, this.reader);
      source.start();
      return source;
    });
    return { source: value, release };
  }

  clear(): void {
    this.pool.clear();
  }
}

let windowSources: PrintBarSources | null = null;

export function printBarSources(): PrintBarSources {
  if (!windowSources) {
    const sources = new PrintBarSources();
    windowSources = sources;
    const off = servicesStore.subscribe(() => {
      off();
      sources.clear();
      if (windowSources === sources) windowSources = null;
    });
  }
  return windowSources;
}
