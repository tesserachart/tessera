import { FootprintStore, type FootprintInput, type TimeSpan } from '@tessera/chart';
import {
  msToNs,
  normalizeEpochMs,
  Runtime,
  timeframeMs,
  type AggressorSource,
  type CompactFootprint,
  type FootprintOutput,
  type FootprintUpdate,
  type Timeframe,
} from '@tessera/protocol';
import { Lifetime, retrying } from '../../app/lifetime.ts';
import { onMarketServed } from '../../app/health.ts';
import { appClient } from '../../app/services.ts';
import { feedErrorWords, retryFeedError } from '../../shell/deskWords.ts';
import {
  DEFAULT_DAYS_TO_LOAD,
  Emitter,
  gapsOf,
  joinGaps,
  loadedOf,
  NO_GAPS,
  Refill,
  settledGapsOf,
  spliceGaps,
  type FlowStatus,
  type InstrumentFlow,
  type Loaded,
  withLoaded,
} from './hub.ts';

export const FOOTPRINT_PAGE = 200;
const FINEST_ROW_TICKS = 1;
const MAX_PAGES = 12;

function footprintInput(c: CompactFootprint): FootprintInput {
  return { t: normalizeEpochMs(c.t), row: c.row, cells: c.cells, deltaHigh: c.deltaHigh, deltaLow: c.deltaLow };
}

interface OlderQuestion {
  readonly from?: number;
  readonly to: number;
}

function firstOpenOf(out: FootprintOutput): number | null {
  return out.firstOpen === null ? null : normalizeEpochMs(out.firstOpen);
}

function reachOf(out: FootprintOutput, q: OlderQuestion): number {
  const open = firstOpenOf(out);
  if (out.truncated) return open ?? q.to + 1;
  return q.from ?? open ?? -Infinity;
}

export class FootprintFeed {
  readonly flow: InstrumentFlow;
  readonly tf: Timeframe;
  readonly days: number;
  readonly store: FootprintStore;
  readonly changed = new Emitter();
  aggressorSource: AggressorSource | null = null;
  exhausted = false;
  firstOpen: number | null = null;
  gaps: readonly TimeSpan[] = NO_GAPS;
  private readonly running = new Lifetime();
  private readonly refill = new Refill(this.running);
  private phase: 'loading' | 'live' | 'failed' = 'loading';
  private buffer: FootprintUpdate[] = [];
  private loads = 0;
  private reloading = false;
  private reloadAgain = false;
  private answered = false;
  private error: string | null = null;
  private streamError: string | null = null;
  private paging: Promise<void> | null = null;
  private wantFrom = Infinity;
  private loaded: Loaded | null = null;

  constructor(flow: InstrumentFlow, tf: Timeframe, days = DEFAULT_DAYS_TO_LOAD) {
    this.flow = flow;
    this.tf = tf;
    this.days = days;
    this.store = new FootprintStore(flow.grid);
  }

  get status(): FlowStatus {
    if (this.streamError !== null) return { reading: false, error: this.streamError };
    return withLoaded({ reading: !this.answered && this.error === null, error: this.error }, this.loaded);
  }

  start(): void {
    this.reloading = false;
    this.reloadAgain = false;
    this.streamError = null;
    this.follow();
    this.load();
  }

  stop(): void {
    this.running.end();
  }

  private follow(): void {
    this.running.topic(
      'market.footprint',
      { instrument: this.flow.instrument, tf: this.tf, rowTicks: FINEST_ROW_TICKS },
      (e) => {
        if (e._tag === 'Event' || e._tag === 'Active') this.streamTaken();
        if (e._tag === 'Event') {
          if (e.data.tf !== this.tf) return;
          if (this.phase === 'live') this.apply(e.data);
          else if (this.phase === 'loading') this.buffer.push(e.data);
        } else if (e._tag === 'Resubscribed') {
          this.streamTaken();
          this.load();
        } else if (e._tag === 'Gap') {
          this.reload();
        } else if (e._tag === 'Refused' || e._tag === 'Ended') {
          this.streamError = feedErrorWords(e.error);
          this.changed.emit();
        }
      },
      { invalid: 'log' },
    );
  }

  private streamTaken(): void {
    if (this.streamError === null) return;
    this.streamError = null;
    this.changed.emit();
  }

  private apply(u: FootprintUpdate): void {
    if (this.put(u)) this.changed.emit();
  }

  private put(u: FootprintUpdate): boolean {
    this.aggressorSource = u.bar.aggressorSource;
    const r = this.store.apply({ bar: footprintInput(u.bar), closed: u.closed, partial: u.partial });
    if (r !== 'reload') return true;
    this.reload();
    return false;
  }

  private latest() {
    return Runtime.invoke(appClient(), 'market.get_footprint', {
      instrument: this.flow.instrument,
      tf: this.tf,
      rowTicks: FINEST_ROW_TICKS,
      limit: FOOTPRINT_PAGE,
      daysToLoad: this.days,
    });
  }

  private load(): void {
    const n = ++this.loads;
    this.phase = 'loading';
    this.buffer = [];
    this.error = null;
    this.changed.emit();
    const live = this.running.live();
    const current = () => live() && n === this.loads;
    this.running.run(
      () => retrying(() => this.latest(), { again: (err) => retryFeedError(err) && current(), live: current }),
      (out) => {
        if (current()) this.setHistory(out, n);
      },
      (e) => {
        if (!current()) return;
        this.phase = 'failed';
        this.buffer = [];
        this.error = feedErrorWords(e);
        this.changed.emit();
      },
    );
  }

  private setHistory(out: FootprintOutput, n: number): void {
    this.store.setHistory(out.bars.map(footprintInput), out.lastBarOpen);
    const last = out.bars[out.bars.length - 1];
    if (last) this.aggressorSource = last.aggressorSource;
    this.gaps = joinGaps(settledGapsOf(out) ?? NO_GAPS);
    this.firstOpen = firstOpenOf(out);
    this.exhausted = this.firstOpen === null;
    this.loaded = loadedOf(out);
    this.phase = 'live';
    const pending = this.buffer;
    this.buffer = [];
    for (const u of pending) this.put(u);
    this.answered = true;
    this.error = null;
    this.changed.emit();
    if (out.filling) this.refillLatest(n);
    if (this.wantFrom < Infinity) void this.ensureFrom(this.wantFrom);
  }

  private takeLatest(out: FootprintOutput, n: number, refill = true): void {
    this.loaded = loadedOf(out);
    out.bars.forEach((b, k) => {
      const open = out.lastBarOpen && k === out.bars.length - 1;
      this.store.apply({ bar: footprintInput(b), closed: !open, partial: false });
    });
    const settled = settledGapsOf(out);
    if (settled) this.gaps = spliceGaps(this.gaps, firstOpenOf(out) ?? -Infinity, Infinity, settled);
    this.error = null;
    this.changed.emit();
    if (out.filling && refill) this.refillLatest(n);
  }

  private refillLatest(n: number): void {
    this.refill.ask(
      `latest:${String(n)}`,
      () => retrying(() => this.latest(), { again: retryFeedError, live: this.running.live() }),
      (out) => {
        if (n === this.loads) this.takeLatest(out, n);
      },
      (out) => {
        if (n === this.loads) this.takeLatest(out, n, false);
      },
    );
  }

  private reload(): void {
    if (this.phase !== 'live') return;
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    this.reloading = true;
    const n = this.loads;
    const live = this.running.live();
    const done = () => {
      this.reloading = false;
      if (!this.reloadAgain) return;
      this.reloadAgain = false;
      this.reload();
    };
    this.running.run(
      () => retrying(() => this.latest(), { again: retryFeedError, live: () => live() && n === this.loads }),
      (out) => {
        if (n === this.loads) this.takeLatest(out, n);
        done();
      },
      (e) => {
        if (n === this.loads) {
          this.error = feedErrorWords(e);
          this.changed.emit();
        }
        done();
      },
    );
  }

  ensureFrom(fromMs: number): Promise<void> {
    this.wantFrom = Math.min(this.wantFrom, fromMs);
    if (this.phase !== 'live' || this.exhausted) return Promise.resolve();
    if (this.paging) return this.paging;
    const first = this.firstOpen;
    if (first === null || first <= this.wantFrom) return Promise.resolve();
    let done!: () => void;
    const paging = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.paging = paging;
    const over = this.running.hold(() => {
      this.paging = null;
      done();
    });
    const live = this.running.live();
    void this.page(live, first).then(() => {
      over();
      if (live()) this.changed.emit();
    });
    return paging;
  }

  private older(live: () => boolean, q: OlderQuestion) {
    return retrying(
      () =>
        Runtime.invoke(appClient(), 'market.get_footprint', {
          instrument: this.flow.instrument,
          tf: this.tf,
          rowTicks: FINEST_ROW_TICKS,
          limit: FOOTPRINT_PAGE,
          daysToLoad: this.days,
          ...(q.from === undefined ? {} : { from: msToNs(q.from) }),
          to: msToNs(q.to),
        }),
      { again: retryFeedError, live, wake: onMarketServed },
    );
  }

  private async spans(
    live: () => boolean,
    first: number,
    stage: (out: FootprintOutput, q: OlderQuestion, oldest: number | null) => void,
  ): Promise<void> {
    const span = FOOTPRINT_PAGE * timeframeMs(this.tf);
    const n = Math.ceil((first - this.wantFrom) / span);
    if (n < 2 || n > MAX_PAGES) return;
    const outs = await Promise.all(
      Array.from({ length: n }, (_, k) => {
        const q = { from: Math.max(this.wantFrom, first - (k + 1) * span), to: first - 1 - k * span };
        return this.older(live, q).then((out) => ({ out, q }));
      }),
    );
    for (const { out, q } of outs) {
      stage(out, q, reachOf(out, q));
      if (out.truncated) return;
    }
  }

  private async page(live: () => boolean, from: number): Promise<void> {
    const loads = this.loads;
    const staged: FootprintInput[] = [];
    const filling: OlderQuestion[] = [];
    const run: { gaps: readonly TimeSpan[]; first: number | null; room: number } = {
      gaps: this.gaps,
      first: from,
      room: this.store.capacity - this.store.length,
    };
    const stage = (out: FootprintOutput, q: OlderQuestion, oldest: number | null) => {
      staged.push(...out.bars.map(footprintInput));
      run.room -= out.bars.length;
      const settled = settledGapsOf(out);
      if (settled) run.gaps = spliceGaps(run.gaps, reachOf(out, q), q.to + 1, settled);
      else filling.push(q);
      run.first = oldest;
    };
    const commit = () => {
      if (loads !== this.loads) return;
      this.store.addOlder(staged);
      this.gaps = run.gaps;
      this.firstOpen = run.first;
      this.exhausted = run.first === null;
      for (const q of filling) this.refillOlder(q, loads);
    };
    try {
      await this.spans(live, from, stage);
      if (!live()) return;
      for (let page = 0; page < MAX_PAGES && run.first !== null && run.first > this.wantFrom && run.room > 0; page++) {
        const q = { to: run.first - 1 };
        const out = await this.older(live, q);
        if (!live()) return;
        const oldest = firstOpenOf(out);
        stage(out, q, oldest !== null && oldest <= q.to ? oldest : null);
      }
      commit();
      this.error = null;
    } catch (e) {
      if (!live()) return;
      commit();
      this.error = feedErrorWords(e);
    }
  }

  private refillOlder(q: OlderQuestion, loads: number): void {
    this.refill.ask(
      `older:${String(q.from ?? '')}:${String(q.to)}`,
      () => this.older(this.running.live(), q),
      (out) => {
        if (loads !== this.loads) return;
        this.store.addOlder(out.bars.map(footprintInput));
        this.gaps = spliceGaps(this.gaps, reachOf(out, q), q.to + 1, gapsOf(out.gaps));
        this.changed.emit();
      },
    );
  }
}
