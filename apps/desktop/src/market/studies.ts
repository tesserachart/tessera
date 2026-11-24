import { ALL_CHANGED, SeriesValues, type InputValue, type SeriesChange, type SeriesColumns } from '@tessera/chart';
import {
  decodeF64,
  msToNs,
  normalizeEpochMs,
  Runtime,
  type AggressorSource,
  type PrintsLoaded,
  type IndicatorObjects,
  type IndicatorSeries,
  type PrintBars,
  type ReachInput,
  type ReachOutput,
  type SeriesError,
  type SeriesUpdate,
  type SessionFilter,
  type Timeframe,
} from '@tessera/protocol';
import { Lifetime, retrying } from '../app/lifetime.ts';
import { onMarketServed } from '../app/health.ts';
import { appClient, servicesStore } from '../app/services.ts';
import { stableStringify } from '../app/stableJson.ts';
import { WarmPool, type PoolTimers } from '../app/warm.ts';
import { retryFeedError } from '../shell/deskWords.ts';
import { barSources, READ_RETRY, type BarSource, type BarSources } from './bars.ts';
import { Emitter } from './flow/hub.ts';
import { printBarsKey } from './instruments.ts';
import { printBarSources, type PrintBarSources } from './printBars.ts';

export interface StudyAsk {
  readonly instrument: string;
  readonly tf: Timeframe;
  readonly printBars?: PrintBars;
  readonly session?: 'rth';
  readonly indicator: string;
  readonly version?: number;
  readonly inputs: Readonly<Record<string, InputValue>>;
}

export interface StudyChart {
  readonly instrument?: string | undefined;
  readonly tf?: Timeframe | undefined;
  readonly printBars?: PrintBars | null | undefined;
  readonly session?: SessionFilter | undefined;
}

export function studyAsk(
  chart: StudyChart,
  study: Pick<StudyAsk, 'indicator' | 'inputs'> & { readonly version?: number | undefined },
): StudyAsk | null {
  const { instrument, tf, printBars, session } = chart;
  if (!instrument || !tf) return null;
  return {
    instrument,
    tf,
    ...(printBars ? { printBars } : {}),
    ...(session === 'rth' && !printBars ? { session } : {}),
    indicator: study.indicator,
    ...(study.version === undefined ? {} : { version: study.version }),
    inputs: study.inputs,
  };
}

export interface StudyStatus {
  readonly error: SeriesError | null;
  readonly aggressorSource: AggressorSource | null;
  readonly loaded: PrintsLoaded | null;
  readonly filling: boolean;
  readonly provider: string | null;
}

const NO_STATUS: StudyStatus = { error: null, aggressorSource: null, loaded: null, filling: false, provider: null };

export type ReachCall = (input: ReachInput) => Promise<ReachOutput>;

const runtimeReach: ReachCall = (input) => Runtime.invoke(appClient(), 'indicators.reach', input);

const STUDY_KEEP_MS = 5 * 60_000;
const STUDY_KEEP_MAX = 16;

function barsKey(ask: StudyAsk): string {
  return ask.printBars
    ? `${ask.instrument}|${printBarsKey(ask.printBars)}`
    : `${ask.instrument}|${ask.tf}|${ask.session ?? 'all'}`;
}

function studyKey(ask: StudyAsk): string {
  return stableStringify([barsKey(ask), ask.tf, ask.indicator, ask.version ?? null, ask.inputs]);
}

type ChartSource = Pick<BarSource, 'series' | 'attach'>;

type Reach = (first: number) => Promise<unknown>;

class ChartBars {
  readonly ready = new Emitter();
  private covered: number | null = null;
  private readonly calls = new Lifetime();
  private readonly detach: () => void;

  constructor(
    private readonly bars: ChartSource,
    private readonly release: () => void,
    private readonly reach: Reach | null,
  ) {
    this.detach = bars.attach({
      reset: () => {
        this.extend();
        this.ready.emit();
      },
      prepend: () => this.extend(),
      update: () => undefined,
      live: () => undefined,
      error: () => undefined,
      olderRefused: () => undefined,
      ended: () => undefined,
    });
  }

  get reaches(): boolean {
    return this.reach !== null;
  }

  reachesBefore(t: number): boolean {
    const first = this.firstBar();
    return this.reaches && first !== null && first < t;
  }

  firstBar(): number | null {
    const s = this.bars.series;
    return s.length > 0 ? s.time[0]! : null;
  }

  covers(first: number): void {
    this.covered = this.covered === null ? first : Math.max(this.covered, first);
    this.extend();
  }

  stop(): void {
    this.detach();
    this.calls.end();
    this.release();
  }

  private extend(): void {
    const first = this.firstBar();
    const reach = this.reach;
    if (!reach || first === null || this.covered === null || first >= this.covered) return;
    this.covered = first;
    const live = this.calls.live();
    this.calls.run(
      () => retrying(() => reach(first), { again: retryFeedError, live, backoff: READ_RETRY, wake: onMarketServed }),
      () => undefined,
      (err) => console.error('[studies] reaching older bars failed', err),
    );
  }
}

function columnsOf(u: SeriesUpdate, rows: number): SeriesColumns {
  const columns: Record<string, Float64Array | null> = {};
  for (const c of u.columns) {
    const values = c.values === null ? null : decodeF64(c.values);
    if (values && values.length !== rows) {
      throw new RangeError(
        `${u.indicator} column ${c.key} has ${String(values.length)} values for ${String(rows)} bars`,
      );
    }
    columns[c.key] = values;
  }
  return columns;
}

export class StudySource {
  readonly ask: StudyAsk;
  readonly values = new SeriesValues();
  readonly changed = new Emitter<SeriesChange>();
  status: StudyStatus = NO_STATUS;
  objects: IndicatorObjects | null = null;
  private readonly series = new Lifetime();
  private following = false;
  private from: number | null = null;
  private resumed = false;
  private rev: number | null = null;
  private offReady: (() => void) | null = null;

  constructor(
    ask: StudyAsk,
    private readonly chart: ChartBars,
    private readonly releaseChart: () => void,
  ) {
    this.ask = ask;
  }

  get reading(): boolean {
    return this.rev === null && this.values.firstTime === null && this.status.error === null;
  }

  start(): void {
    this.offReady = this.chart.ready.on(() => {
      if (!this.following) this.subscribe();
    });
    this.subscribe();
  }

  stop(): void {
    this.offReady?.();
    this.series.end();
    this.following = false;
    this.releaseChart();
  }

  private subscribe(): void {
    const { indicator, version, inputs, instrument, tf, printBars, session } = this.ask;
    const from = this.chart.firstBar();
    if (from === null && printBars) return;
    this.series.end();
    this.following = true;
    this.from = from;
    this.resumed = false;
    this.rev = null;
    this.series.topic(
      'indicators.series',
      {
        indicator,
        ...(version === undefined ? {} : { version }),
        inputs,
        instrument,
        tf,
        ...(from === null ? {} : { from: msToNs(from) }),
        ...(printBars ? { printBars } : {}),
        ...(session ? { session } : {}),
      },
      (e) => {
        if (e._tag === 'Event') this.apply(e.data);
        else if (e._tag === 'Resubscribed') this.resume();
        else if (e._tag === 'Gap') this.subscribe();
        else if (e._tag === 'Refused' || e._tag === 'Ended') this.fail({ message: e.error.message, line: null });
      },
      { invalid: 'log' },
    );
  }

  private resume(): void {
    if (!this.chart.reaches && this.chart.firstBar() !== this.from) {
      this.subscribe();
      return;
    }
    this.rev = null;
    this.resumed = true;
  }

  private apply(u: SeriesUpdate): void {
    const held = this.rev;
    if (held !== null && u.rev <= held) return;
    if (u.replaces.kind === 'span') {
      if (held === null) return;
      if (u.rev > held + 1) {
        this.subscribe();
        return;
      }
    }
    const time = decodeF64(u.time);
    const columns = columnsOf(u, time.length);
    this.rev = u.rev;
    const resumed = this.resumed;
    this.resumed = false;
    let change = ALL_CHANGED;
    if (u.error) {
      this.values.clear();
      this.objects = null;
    } else if (u.replaces.kind === 'all') {
      const first = time.length > 0 ? time[0]! : null;
      const reachedAgain = resumed && first !== null && this.chart.reachesBefore(first);
      if (reachedAgain) this.values.replaceSpan(first, Infinity, time, columns);
      else this.values.replaceAll(time, columns);
      this.objects = u.objects;
      if (first !== null) this.chart.covers(first);
    } else {
      const from = normalizeEpochMs(u.replaces.from);
      const to = normalizeEpochMs(u.replaces.to);
      this.values.replaceSpan(from, to, time, columns);
      if (u.objects) this.objects = u.objects;
      change = { kind: 'span', from, to };
    }
    this.status = {
      error: u.error,
      aggressorSource: u.aggressorSource,
      loaded: u.loaded,
      filling: u.filling,
      provider: u.provider,
    };
    this.changed.emit(change);
  }

  private fail(error: SeriesError): void {
    this.values.clear();
    this.objects = null;
    this.status = { ...this.status, error };
    this.changed.emit(ALL_CHANGED);
  }
}

export interface StudySourcesOptions {
  readonly bars?: BarSources;
  readonly printBars?: PrintBarSources;
  readonly reach?: ReachCall;
  readonly keepMs?: number;
  readonly maxIdle?: number;
  readonly timers?: PoolTimers;
}

export class StudySources {
  private readonly studies: WarmPool<StudySource>;
  private readonly charts = new WarmPool<ChartBars>({ dispose: (c) => c.stop(), keepMs: 0, maxIdle: 0 });
  private readonly bars: () => BarSources;
  private readonly printBars: () => PrintBarSources;
  private readonly call: ReachCall;

  constructor(options: StudySourcesOptions = {}) {
    const { bars, printBars, timers } = options;
    this.studies = new WarmPool<StudySource>({
      dispose: (s) => s.stop(),
      keepMs: options.keepMs ?? STUDY_KEEP_MS,
      maxIdle: options.maxIdle ?? STUDY_KEEP_MAX,
      ...(timers ? { timers } : {}),
    });
    this.bars = bars ? () => bars : barSources;
    this.printBars = printBars ? () => printBars : printBarSources;
    this.call = options.reach ?? runtimeReach;
  }

  acquire(ask: StudyAsk): { source: StudySource; release: () => void } {
    const { value, release } = this.studies.acquire(studyKey(ask), () => {
      const chart = this.charts.acquire(barsKey(ask), () => this.chartOf(ask));
      const source = new StudySource(ask, chart.value, chart.release);
      source.start();
      return source;
    });
    return { source: value, release };
  }

  get size(): number {
    return this.studies.size;
  }

  get idle(): number {
    return this.studies.idle;
  }

  clear(): void {
    this.studies.clear();
    this.charts.clear();
  }

  private chartOf(ask: StudyAsk): ChartBars {
    const { instrument, tf, printBars, session } = ask;
    if (printBars) {
      const { source, release } = this.printBars().acquire(instrument, printBars);
      return new ChartBars(source, release, null);
    }
    const { source, release } = this.bars().acquire(instrument, tf, session);
    return new ChartBars(source, release, (first) =>
      this.call({ instrument, tf, from: msToNs(first), ...(session ? { session } : {}) }),
    );
  }
}

let windowStudies: StudySources | null = null;

function studySources(): StudySources {
  if (!windowStudies) {
    const sources = new StudySources();
    windowStudies = sources;
    const off = servicesStore.subscribe(() => {
      off();
      sources.clear();
      if (windowStudies === sources) windowStudies = null;
    });
  }
  return windowStudies;
}

export interface StudyView {
  linked(source: StudySource | null): void;
  changed(source: StudySource, change: SeriesChange): void;
}

export class StudyLink {
  private held: { key: string; source: StudySource; release: () => void; off: () => void } | null = null;

  constructor(
    private readonly view: StudyView,
    private readonly sources: () => StudySources = studySources,
  ) {}

  get source(): StudySource | null {
    return this.held?.source ?? null;
  }

  follow(ask: StudyAsk | null): void {
    const key = ask ? studyKey(ask) : null;
    if (key === (this.held?.key ?? null)) return;
    this.unlink();
    if (ask && key) {
      const { source, release } = this.sources().acquire(ask);
      const offChanged = source.changed.on((change) => this.view.changed(source, change));
      this.held = { key, source, release, off: offChanged };
    }
    this.view.linked(this.held?.source ?? null);
  }

  dispose(): void {
    this.follow(null);
  }

  private unlink(): void {
    const held = this.held;
    this.held = null;
    if (!held) return;
    held.off();
    held.release();
  }
}

export function seriesValuesOf(series: IndicatorSeries): SeriesValues {
  const values = new SeriesValues();
  values.replaceAll(
    Float64Array.from(series.time, normalizeEpochMs),
    Object.fromEntries(series.plots.map((p) => [p.key, Float64Array.from(p.values, (v) => v ?? Number.NaN)])),
  );
  return values;
}
