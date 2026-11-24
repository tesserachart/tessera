import type { BarTuple, ChartApi } from '@tessera/chart';
import {
  timeframeMs,
  type ContractSpec,
  type DataSource,
  type PrintBars,
  type SessionFilter,
  type Timeframe,
} from '@tessera/protocol';
import { guessSessionOptions, sessionOptionsFor } from '../market/instruments.ts';
import {
  barSources,
  type BarSource,
  type BarSources,
  type BarsHead,
  type BarsSink,
  type HistoryEnd,
} from '../market/bars.ts';
import type { ContractSpan } from '../market/frontMonths.ts';
import { printBarsKey } from '../market/instruments.ts';
import { printBarSources } from '../market/printBars.ts';
import { onDisplayZone } from '../state/timeZone.ts';
import { OLDER_HISTORY_REFUSED, refusedByFeed } from '../shell/deskWords.ts';

type FeedSource = Pick<BarSource, 'head' | 'series' | 'settled' | 'bars' | 'attach' | 'pageOlder' | 'reload'>;

type FeedState = 'loading' | 'replacing' | 'failed' | 'drawn';

export type FeedChart = Pick<ChartApi, 'setData' | 'prepend' | 'update' | 'setOptions' | 'on'>;

export interface FeedMeta {
  instrument: string;
  tf: Timeframe;
  source: DataSource;
  precision: number;
  bars: number;
  contracts: readonly ContractSpan[];
}

export interface ChartFeedOptions {
  newest?: number;
  onMeta?: (meta: FeedMeta) => void;
  onError?: (error: Error | null) => void;
  onLoading?: (loading: boolean) => void;
  onHistoryStop?: (why: string | null) => void;
  onHistoryEnd?: (end: HistoryEnd | null) => void;
  sources?: BarSources;
  warm?: boolean;
}

const PAGE_AHEAD_SCREENS = 0.5;

export class ChartFeed {
  private readonly chart: FeedChart;
  private readonly opts: ChartFeedOptions;
  private current: {
    instrument: string;
    tf: Timeframe;
    spec: ContractSpec | null;
    bars: string | null;
    session: SessionFilter;
  } | null = null;
  private bound: { source: FeedSource; detach: () => void; release: () => void } | null = null;
  private warmed: { key: string; release: () => void } | null = null;
  private state: FeedState = 'loading';
  private failure: Error | null = null;
  private readonly offViewport: () => void;
  private readonly offZone: () => void;

  constructor(chart: FeedChart, options: ChartFeedOptions = {}) {
    this.chart = chart;
    this.opts = options;
    this.offViewport = chart.on('viewport', (v) => {
      if (v.from < 0 || this.opts.newest !== undefined) return;
      const screen = Math.max(1, v.to - v.from);
      if (v.from <= screen * PAGE_AHEAD_SCREENS) this.bound?.source.pageOlder();
    });
    this.offZone = onDisplayZone(() => {
      this.refreshOptions();
    });
  }

  load(
    instrument: string,
    tf: Timeframe,
    spec: ContractSpec | null = null,
    printBars: PrintBars | null = null,
    session: SessionFilter = 'all',
  ): void {
    const cur = this.current;
    const bars = printBars ? printBarsKey(printBars) : null;
    const same = cur?.instrument === instrument && cur.tf === tf && cur.bars === bars && cur.session === session;
    if (same && cur.spec === spec) return;
    this.current = { instrument, tf, spec, bars, session };
    if (this.bound && same) {
      this.refreshOptions();
      return;
    }
    this.unbind();
    this.failure = null;
    this.opts.onHistoryStop?.(null);
    this.opts.onHistoryEnd?.(null);
    const sameMarket = cur?.instrument === instrument;
    if (!sameMarket) this.unwarm();
    const { source, release }: { source: FeedSource; release: () => void } = printBars
      ? printBarSources().acquire(instrument, printBars)
      : (this.opts.sources ?? barSources()).acquire(instrument, tf, session);
    if (sameMarket && this.state === 'drawn' && source.settled) {
      this.state = 'replacing';
    } else {
      if (this.state === 'drawn') this.chart.setData('main', []);
      this.enter('loading');
    }
    const sink: BarsSink = {
      reset: () => this.reset(source),
      update: (bar) => {
        if (this.state === 'drawn') this.chart.update('main', bar);
      },
      prepend: (bars) => {
        if (this.state === 'drawn' && this.opts.newest === undefined) this.chart.prepend('main', bars);
      },
      live: (head, bars) => this.live(source, head, bars),
      error: (error) => this.fail(source, error),
      olderRefused: () => this.opts.onHistoryStop?.(OLDER_HISTORY_REFUSED),
      ended: (end) => this.opts.onHistoryEnd?.(end),
    };
    this.bound = { source, release, detach: () => undefined };
    this.bound.detach = source.attach(sink);
  }

  reload(): void {
    this.bound?.source.reload();
  }

  private enter(state: FeedState): void {
    this.state = state;
    this.opts.onLoading?.(state === 'loading');
  }

  private get awaiting(): boolean {
    return this.state === 'loading' || this.state === 'replacing';
  }

  private reset(source: FeedSource): void {
    if (this.awaiting && !source.settled) return;
    this.draw(source);
  }

  private fail(source: FeedSource, error: Error): void {
    if (this.awaiting) {
      if (source.series.length > 0) {
        this.draw(source);
      } else {
        if (this.state === 'replacing') this.chart.setData('main', []);
        this.failure = error;
        this.enter('failed');
      }
    }
    if (this.state === 'drawn' && source.series.length > 0 && refusedByFeed(error)) {
      this.opts.onHistoryStop?.(OLDER_HISTORY_REFUSED);
      return;
    }
    this.opts.onError?.(error);
  }

  private draw(source: FeedSource): void {
    const failed = this.state === 'failed' ? this.failure : null;
    this.failure = null;
    if (source.head) this.applyOptions(source.head);
    const n = this.opts.newest;
    const keep = { keepView: this.state === 'drawn' };
    if (n === undefined || source.series.length <= n) {
      this.chart.setData('main', source.series, keep);
    } else {
      const all: BarTuple[] = source.bars();
      this.chart.setData('main', all.slice(all.length - n), keep);
    }
    if (this.state === 'replacing') this.state = 'drawn';
    else if (this.state !== 'drawn') this.enter('drawn');
    if (failed && source.series.length > 0 && refusedByFeed(failed)) {
      this.opts.onError?.(null);
      this.opts.onHistoryStop?.(OLDER_HISTORY_REFUSED);
    }
  }

  private live(source: FeedSource, head: BarsHead, bars: number): void {
    const cur = this.current;
    if (!cur) return;
    if (this.awaiting && source.settled) this.draw(source);
    this.opts.onMeta?.({
      instrument: head.instrument,
      tf: cur.tf,
      source: { provider: head.provider },
      precision: head.priceDecimals,
      bars,
      contracts: head.contracts,
    });
    this.warm(cur);
  }

  private warm(cur: { instrument: string; tf: Timeframe; bars: string | null; session: SessionFilter }): void {
    if (!this.opts.warm) return;
    const shown = cur.bars === null ? cur.tf : null;
    const key = `${cur.instrument}|${shown ?? ''}|${cur.session}`;
    if (this.warmed?.key === key) return;
    const release = (this.opts.sources ?? barSources()).warm(cur.instrument, shown, cur.session);
    this.warmed?.release();
    this.warmed = { key, release };
  }

  private unwarm(): void {
    this.warmed?.release();
    this.warmed = null;
  }

  private refreshOptions(): void {
    const head = this.bound?.source.head;
    if (head && this.state !== 'replacing') this.applyOptions(head);
  }

  private applyOptions(head: BarsHead): void {
    const cur = this.current;
    if (!cur) return;
    this.chart.setOptions({
      priceFormat: { precision: head.priceDecimals, minMove: cur.spec?.tickSize ?? 10 ** -head.priceDecimals },
      sessions: cur.spec ? sessionOptionsFor(cur.spec.sessions) : guessSessionOptions(head.instrument),
      timeframeMs: timeframeMs(cur.tf),
    });
  }

  private unbind(): void {
    const b = this.bound;
    this.bound = null;
    if (!b) return;
    b.detach();
    b.release();
  }

  dispose(): void {
    this.unbind();
    this.unwarm();
    this.offViewport();
    this.offZone();
    this.current = null;
  }
}
