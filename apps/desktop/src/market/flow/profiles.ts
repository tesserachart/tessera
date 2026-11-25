import {
  addTpoPrints,
  type ProfileHours,
  type ProfileSource,
  type SessionProfileData,
  type TimeSpan,
  type TpoData,
} from '@tessera/chart';
import {
  msToNs,
  normalizeEpochMs,
  Runtime,
  type Level,
  type ProfileOutput,
  type ProfilePeriod,
  type TpoOutput,
  type VolumeProfileOutput,
} from '@tessera/protocol';
import { Lifetime, READ_AGAIN_MS, retrying } from '../../app/lifetime.ts';
import { onMarketServed } from '../../app/health.ts';
import { appClient } from '../../app/services.ts';
import { feedErrorWords, retryFeedError } from '../../shell/deskWords.ts';
import {
  DEFAULT_DAYS_TO_LOAD,
  Emitter,
  gapsOf,
  joinGaps,
  loadedOf,
  mostLoading,
  NO_GAPS,
  Refill,
  sameGaps,
  type FlowStatus,
  type InstrumentFlow,
  type Loaded,
  withLoaded,
} from './hub.ts';

const PAGE_PERIODS = 10;
const REFRESH_MS = 60_000;
export const OPEN_SPAN_REFRESH_MS = 5_000;
const SPAN_KEEP_MS = 120_000;

function readDue(held: Held, now: number): boolean {
  if (held.reading) return false;
  if (held.at === 0) return true;
  const age = held.error === null ? held.maxAge : Math.min(held.maxAge, READ_AGAIN_MS);
  return now - held.at >= age;
}
const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PERIOD_DAYS: Readonly<Record<ProfilePeriod, number>> = { session: 1, day: 1, week: 7, month: 31 };
const LEVEL_PREFIX: Readonly<Record<ProfilePeriod, readonly [string, string] | null>> = {
  session: ['', 'p'],
  day: null,
  week: ['w', 'pw'],
  month: ['m', 'pm'],
};

export function sessionLabel(tradeDate: string | null, fromMs: number, period: ProfilePeriod = 'session'): string {
  const d = tradeDate ? new Date(`${tradeDate}T12:00:00Z`) : new Date(fromMs);
  if (period === 'week') return `Wk ${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCDate())}`;
  if (period === 'month') return `${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCFullYear())}`;
  return WEEKDAYS[d.getUTCDay()] ?? '';
}

function tpoData(t: TpoOutput | undefined, tick: number): TpoData | null {
  if (!t) return null;
  const at = (price: number | null) => (price === null ? null : Math.round(price / tick));
  return {
    minutes: t.minutes,
    brackets: t.brackets.map(([start, letter, low, high]) => ({
      start: normalizeEpochMs(start),
      letter,
      lowTick: Math.round(low / tick),
      highTick: Math.round(high / tick),
    })),
    ibFrom: t.ibFrom === null ? null : normalizeEpochMs(t.ibFrom),
    ibLowTick: at(t.ibLow),
    ibHighTick: at(t.ibHigh),
  };
}

export function profileData(p: ProfileOutput, tick: number, period: ProfilePeriod = 'session'): SessionProfileData {
  const rowTicks = Math.max(1, Math.round(p.row / tick));
  const ticks = p.rows.map((r) => Math.round(r[0] / tick));
  const low = ticks.length ? Math.min(...ticks) : 0;
  const high = ticks.length ? Math.max(...ticks) : -rowTicks;
  const rows = Math.max(0, Math.round((high - low) / rowTicks) + 1);
  const volume = new Float64Array(rows);
  const buy = new Float64Array(rows);
  const sell = new Float64Array(rows);
  p.rows.forEach((r, k) => {
    const i = Math.round((ticks[k]! - low) / rowTicks);
    volume[i] = r[1];
    buy[i] = r[2];
    sell[i] = r[3];
  });
  const from = normalizeEpochMs(p.from);
  return {
    from,
    to: normalizeEpochMs(p.sessionEnd ?? p.to),
    label: sessionLabel(p.tradeDate, from, period),
    rowTicks,
    lowTick: low,
    rows,
    volume,
    buy,
    sell,
    levels: null,
    partial: p.gaps.length > 0,
    tpo: tpoData(p.tpo, tick),
  };
}

function addLivePrints(
  s: SessionProfileData,
  prints: readonly (readonly [number, number, number])[],
  times: readonly number[],
): SessionProfileData {
  const added = addPrints(s, prints);
  if (!s.tpo) return added;
  return {
    ...added,
    tpo: addTpoPrints(
      s.tpo,
      s.from,
      prints.map(([tick], i) => [tick, times[i]!] as const),
    ),
  };
}

export function addPrints(
  s: SessionProfileData,
  prints: readonly (readonly [number, number, number])[],
): SessionProfileData {
  if (prints.length === 0) return s;
  let lo = s.rows > 0 ? s.lowTick : Infinity;
  let hi = s.rows > 0 ? s.lowTick + (s.rows - 1) * s.rowTicks : -Infinity;
  for (const [tick] of prints) {
    const row = Math.floor(tick / s.rowTicks) * s.rowTicks;
    if (row < lo) lo = row;
    if (row > hi) hi = row;
  }
  const rows = (hi - lo) / s.rowTicks + 1;
  const off = s.rows > 0 ? (s.lowTick - lo) / s.rowTicks : 0;
  const grow = (a: Float64Array) => {
    const b = new Float64Array(rows);
    b.set(a.subarray(0, s.rows), off);
    return b;
  };
  const volume = grow(s.volume);
  const buy = grow(s.buy);
  const sell = grow(s.sell);
  for (const [tick, size, side] of prints) {
    const i = (Math.floor(tick / s.rowTicks) * s.rowTicks - lo) / s.rowTicks;
    volume[i] = volume[i]! + size;
    if (side > 0) buy[i] = buy[i]! + size;
    else if (side < 0) sell[i] = sell[i]! + size;
  }
  return { ...s, lowTick: lo, rows, volume, buy, sell };
}

function mergeSessions(held: readonly SessionProfileData[], got: readonly SessionProfileData[]): SessionProfileData[] {
  const byFrom = new Map(held.map((s) => [s.from, s]));
  for (const s of got) byFrom.set(s.from, s);
  return [...byFrom.values()].sort((a, b) => a.from - b.from);
}

function sameLevels(a: SessionProfileData['levels'], b: SessionProfileData['levels']): boolean {
  return a?.poc === b?.poc && a?.vah === b?.vah && a?.val === b?.val;
}

function field(levels: readonly Level[], name: string): number | null {
  const l = levels.find((x) => x.group === 'vp' && x.key.endsWith(`.${name}`));
  return l?.price ?? null;
}

export function withoutRth(all: SessionProfileData, rth: SessionProfileData): SessionProfileData {
  const rowTicks = all.rowTicks;
  const volume = Float64Array.from(all.volume.subarray(0, all.rows));
  const buy = Float64Array.from(all.buy.subarray(0, all.rows));
  const sell = Float64Array.from(all.sell.subarray(0, all.rows));
  for (let r = 0; r < rth.rows; r++) {
    const tick = rth.lowTick + r * rth.rowTicks;
    const i = Math.floor((tick - all.lowTick) / rowTicks);
    if (i < 0 || i >= all.rows) continue;
    volume[i] = Math.max(0, volume[i]! - rth.volume[r]!);
    buy[i] = Math.max(0, buy[i]! - rth.buy[r]!);
    sell[i] = Math.max(0, sell[i]! - rth.sell[r]!);
  }
  return { ...all, to: rth.from, volume, buy, sell, levels: null, label: `${all.label} ETH` };
}

interface SessionsQuestion {
  readonly sessions: number;
  readonly to?: number;
}

interface SessionsAnswer {
  readonly all: VolumeProfileOutput;
  readonly rth: VolumeProfileOutput | null;
  readonly filling: boolean;
}

class PeriodList {
  readonly flow: InstrumentFlow;
  readonly period: ProfilePeriod;
  readonly tpoMinutes: number | null;
  readonly changed = new Emitter();
  private wantCount = 1;
  private exhausted = false;
  private answered = false;
  private error: string | null = null;
  private olderError: string | null = null;
  private wantFrom = Infinity;
  private failedAt: number | null = null;
  private paging = false;
  private list: SessionProfileData[] = [];
  private readonly gapsBy = new Map<number, readonly TimeSpan[]>();
  private shownGaps: readonly TimeSpan[] = NO_GAPS;
  private newestRead: number | null = null;
  private oldestRead: number | null = null;
  private rth: SessionProfileData[] = [];
  private wantRth = false;
  private splitOf: {
    list: SessionProfileData[];
    rth: SessionProfileData[];
    split: SessionProfileData[];
    rthOnly: SessionProfileData[];
  } | null = null;
  private readonly splits = new WeakMap<
    SessionProfileData,
    { rth: SessionProfileData | undefined; parts: SessionProfileData[] }
  >();
  private levels: readonly Level[] = [];
  private releaseTrades: (() => void) | null = null;
  private offTrades: (() => void) | null = null;
  private readonly running = new Lifetime();
  private readonly refill = new Refill(this.running);
  private cursor = 0;
  private tapeEpoch = -1;
  private lastPrintNs = Infinity;
  private loading = false;
  private loaded: Loaded | null = null;

  constructor(
    flow: InstrumentFlow,
    period: ProfilePeriod = 'session',
    tpoMinutes: number | null = null,
    readonly days = DEFAULT_DAYS_TO_LOAD,
  ) {
    this.flow = flow;
    this.period = period;
    this.tpoMinutes = tpoMinutes;
  }

  get status(): FlowStatus {
    const error = this.error ?? this.olderError;
    return withLoaded({ reading: !this.answered && error === null, error }, this.loaded);
  }

  get gaps(): readonly TimeSpan[] {
    const joined = joinGaps(this.list.flatMap((s) => this.gapsBy.get(s.from) ?? NO_GAPS));
    if (!sameGaps(joined, this.shownGaps)) this.shownGaps = joined;
    return this.shownGaps;
  }

  start(): void {
    this.releaseTrades = this.flow.useTrades();
    this.offTrades = this.flow.tradesChanged.on(() => this.addLive());
    this.running.every(REFRESH_MS, () => this.refresh());
    this.load();
  }

  stop(): void {
    this.running.end();
    this.offTrades?.();
    this.releaseTrades?.();
    this.offTrades = null;
    this.releaseTrades = null;
  }

  sessions(hours: ProfileHours = 'all'): readonly SessionProfileData[] {
    if (hours === 'all') return this.list;
    if (!this.wantRth) {
      this.wantRth = true;
      this.oldestRead = null;
      this.exhausted = false;
      this.load();
    }
    const held = this.splitOf;
    if (held?.list === this.list && held.rth === this.rth) return hours === 'rth' ? held.rthOnly : held.split;
    const split: SessionProfileData[] = [];
    const rthOnly: SessionProfileData[] = [];
    for (const s of this.list) {
      const r = this.rth.find((x) => x.from >= s.from && x.from < s.to);
      const kept = this.splits.get(s);
      const parts =
        kept && kept.rth === r ? kept.parts : r ? [withoutRth(s, r), { ...r, label: `${s.label} RTH` }] : [s];
      this.splits.set(s, { rth: r, parts });
      split.push(...parts);
      if (r) rthOnly.push(parts[parts.length - 1]!);
    }
    this.splitOf = { list: this.list, rth: this.rth, split, rthOnly };
    return hours === 'rth' ? rthOnly : split;
  }

  setLevels(levels: readonly Level[]): void {
    if (levels === this.levels) return;
    this.levels = levels;
    this.applyLevels();
    this.changed.emit();
  }

  private applyLevels(): void {
    const prefix = LEVEL_PREFIX[this.period];
    if (!prefix) return;
    let list = this.list;
    const put = (from: number | undefined, p: string) => {
      const k = list.findIndex((s) => s.from === from);
      const s = list[k];
      if (!s) return;
      const poc = field(this.levels, `${p}poc`);
      const vah = field(this.levels, `${p}vah`);
      const val = field(this.levels, `${p}val`);
      const levels = poc !== null && vah !== null && val !== null ? { poc, vah, val } : null;
      if (sameLevels(s.levels, levels)) return;
      if (list === this.list) list = [...list];
      list[k] = { ...s, levels };
    };
    const current = Math.max(this.newestRead ?? -Infinity, this.list.at(-1)?.from ?? -Infinity);
    put(current, prefix[0]);
    put(this.list.findLast((s) => s.from < current)?.from, prefix[1]);
    this.list = list;
  }

  private refresh(): void {
    const last = this.list.at(-1);
    const current = last !== undefined && last.from >= (this.newestRead ?? -Infinity);
    this.load(current && this.flow.clock.now() < last.to ? 1 : PAGE_PERIODS);
  }

  private load(sessions = PAGE_PERIODS): void {
    if (this.loading) return;
    this.loading = true;
    void this.read(sessions);
  }

  private async read(sessions: number): Promise<void> {
    const live = this.running.live();
    const loaded = this.running.hold(() => {
      this.loading = false;
    });
    try {
      const answer = await this.question(live, { sessions }, (err) => retryFeedError(err) && live());
      if (!live()) return;
      this.answered = true;
      this.error = null;
      this.takeNewest(answer);
      if (answer.filling)
        this.refill.ask(
          `sessions:${String(sessions)}`,
          () => this.question(this.running.live(), { sessions }),
          (settled) => this.takeNewest(settled),
          (filling) => {
            this.loaded = loadedOf(filling.all);
            this.changed.emit();
          },
        );
    } catch (e) {
      if (!live()) return;
      this.error = feedErrorWords(e);
      this.changed.emit();
    } finally {
      loaded();
    }
    if (live()) this.page();
  }

  private takeNewest(answer: SessionsAnswer): void {
    this.loaded = loadedOf(answer.all);
    const drawn = this.take(answer);
    const newest = answer.all.profiles[answer.all.profiles.length - 1];
    const newestFrom = newest ? normalizeEpochMs(newest.from) : null;
    if (newestFrom !== null) this.newestRead = Math.max(this.newestRead ?? -Infinity, newestFrom);
    if (newestFrom === null || drawn.has(newestFrom)) {
      this.lastPrintNs = newest?.lastPrint ?? -Infinity;
      this.cursor = this.flow.tape.lowerBound(this.lastPrintNs + 1);
      this.tapeEpoch = this.flow.tape.epoch;
    }
    this.applyLevels();
    this.addLive();
    this.changed.emit();
  }

  private async question(
    live: () => boolean,
    q: SessionsQuestion,
    again: (err: unknown) => boolean = retryFeedError,
  ): Promise<SessionsAnswer> {
    const all = await this.ask(live, q, again);
    const rth = this.wantRth && live() ? await this.ask(live, { ...q, session: 'rth' }) : null;
    return { all, rth, filling: all.filling || (rth?.filling ?? false) };
  }

  private ask(
    live: () => boolean,
    input: SessionsQuestion & { session?: 'rth' },
    again: (err: unknown) => boolean = retryFeedError,
  ) {
    return retrying(
      () =>
        Runtime.invoke(appClient(), 'market.get_volume_profile', {
          instrument: this.flow.instrument,
          mode: this.period,
          ...(input.session ? { session: input.session } : {}),
          sessions: input.sessions,
          ...(input.to === undefined ? {} : { to: msToNs(input.to) }),
          ...(this.tpoMinutes === null ? {} : { tpoMinutes: this.tpoMinutes }),
          rowTicks: 1,
          maxRows: 500,
          daysToLoad: this.days,
        }),
      { again, live, wake: onMarketServed },
    );
  }

  ensureFrom(fromMs: number, count: number): void {
    this.wantFrom = Math.min(this.wantFrom, fromMs);
    this.wantCount = Math.max(this.wantCount, count);
    this.page();
  }

  private take(answer: SessionsAnswer): Set<number> {
    const tick = this.flow.grid.tick;
    const shown = (p: ProfileOutput) => !answer.filling || p.gaps.length === 0;
    const drawn: SessionProfileData[] = [];
    for (const p of answer.all.profiles.filter(shown)) {
      const s = profileData(p, tick, this.period);
      this.gapsBy.set(s.from, gapsOf(p.gaps));
      drawn.push(s);
    }
    if (drawn.length > 0) this.list = mergeSessions(this.list, drawn);
    const rthDrawn = answer.rth?.profiles.filter(shown).map((p) => profileData(p, tick, this.period)) ?? [];
    if (rthDrawn.length > 0) this.rth = mergeSessions(this.rth, rthDrawn);
    for (const p of answer.all.profiles)
      this.oldestRead = Math.min(this.oldestRead ?? Infinity, normalizeEpochMs(p.from));
    return new Set(drawn.map((s) => s.from));
  }

  private nextOlder(): number | null {
    const first = this.oldestRead;
    if (first === null || this.exhausted || first <= this.wantFrom || this.list.length >= this.wantCount) return null;
    return first - 1;
  }

  private page(): void {
    if (this.paging || this.loading || this.failedAt === this.wantFrom) return;
    if (this.nextOlder() === null) return;
    this.paging = true;
    const live = this.running.live();
    const over = this.running.hold(() => {
      this.paging = false;
    });
    void this.readOlder(live).then(() => {
      over();
      if (live()) this.changed.emit();
    });
  }

  private async readOlder(live: () => boolean): Promise<void> {
    try {
      for (let to = this.nextOlder(); to !== null; to = this.nextOlder()) {
        const periods = Math.ceil((to - this.wantFrom) / (PERIOD_DAYS[this.period] * DAY_MS));
        const left = this.wantCount - this.list.length;
        const q = { sessions: Math.min(PAGE_PERIODS, left, Math.max(1, periods)), to };
        const before = this.oldestRead;
        const answer = await this.question(live, q);
        if (!live()) return;
        this.olderError = null;
        this.takeOlder(answer);
        if (answer.filling)
          this.refill.ask(
            `older:${String(to)}`,
            () => this.question(this.running.live(), q),
            (settled) => this.takeOlder(settled),
          );
        if (this.oldestRead === before) this.exhausted = true;
      }
    } catch (e) {
      if (!live()) return;
      this.olderError = feedErrorWords(e);
      this.failedAt = this.wantFrom;
      this.running.after(READ_AGAIN_MS, () => {
        this.failedAt = null;
        this.page();
      });
    }
  }

  private takeOlder(answer: SessionsAnswer): void {
    this.take(answer);
    this.applyLevels();
    this.changed.emit();
  }

  private addLive(): void {
    const tape = this.flow.tape;
    const k = this.list.length - 1;
    const s = this.list[k];
    if (!s || this.loading) return;
    if (tape.epoch !== this.tapeEpoch || this.cursor < tape.start) {
      this.tapeEpoch = tape.epoch;
      this.cursor = tape.end;
      this.load(1);
      return;
    }
    const endNs = s.to * 1e6;
    const prints: [number, number, number][] = [];
    const times: number[] = [];
    for (let i = this.cursor; i < tape.end; i++) {
      const ns = tape.nsAt(i);
      if (ns <= this.lastPrintNs) continue;
      if (ns >= endNs) break;
      prints.push([tape.tickAt(i), tape.sizeAt(i), tape.sideAt(i)]);
      times.push(ns / 1e6);
    }
    this.cursor = tape.end;
    if (prints.length > 0) {
      this.list = [...this.list];
      this.list[k] = addLivePrints(s, prints, times);
      const rk = this.rth.length - 1;
      const r = this.rth[rk];
      if (r && times.length > 0) {
        const inside = prints.flatMap((p, i) => (times[i]! >= r.from && times[i]! < r.to ? [i] : []));
        if (inside.length > 0) {
          this.rth = [...this.rth];
          this.rth[rk] = addLivePrints(
            r,
            inside.map((i) => prints[i]!),
            inside.map((i) => times[i]!),
          );
        }
      }
      this.changed.emit();
    }
  }
}

interface Held {
  q: Question;
  maxAge: number;
  data: SessionProfileData | null;
  gaps: readonly TimeSpan[];
  at: number;
  asked: number;
  reading: boolean;
  answered: boolean;
  error: string | null;
  loaded: Loaded | null;
}

interface Question {
  mode: 'composite' | 'range';
  period?: ProfilePeriod;
  count?: number;
  from?: number;
  to?: number | null;
  rth: boolean;
}

function spanKey(from: number, to: number | null, rth: boolean): string {
  return `${String(from)}|${to === null ? 'now' : String(to)}|${rth ? 'rth' : 'all'}`;
}

export class ProfileFeed implements ProfileSource {
  readonly flow: InstrumentFlow;
  readonly changed = new Emitter();
  private readonly lists = new Map<string, { list: PeriodList; off: () => void }>();
  private readonly composites = new Map<string, Held>();
  private readonly spans = new Map<string, Held>();
  private readonly running = new Lifetime();
  private readonly refill = new Refill(this.running);
  private levels: readonly Level[] = [];
  private started = false;
  private shownGaps: readonly TimeSpan[] = NO_GAPS;

  constructor(
    flow: InstrumentFlow,
    readonly days = DEFAULT_DAYS_TO_LOAD,
  ) {
    this.flow = flow;
  }

  start(): void {
    this.started = true;
    for (const { list } of this.lists.values()) list.start();
    this.running.every(OPEN_SPAN_REFRESH_MS, () => this.refreshSpans());
  }

  stop(): void {
    this.started = false;
    this.running.end();
    for (const { list, off } of this.lists.values()) {
      off();
      list.stop();
    }
    this.lists.clear();
  }

  get status(): FlowStatus {
    const held = [...this.composites.values(), ...this.spans.values()];
    const lists = [...this.lists.values()].map((l) => l.list.status);
    const error = lists.find((s) => s.error)?.error ?? held.find((h) => h.error)?.error ?? null;
    const reading = lists.some((s) => s.reading) || held.some((h) => !h.answered && h.error === null);
    const loaded = mostLoading([...lists.map((s) => s.loaded), ...held.map((h) => h.loaded)]);
    return withLoaded({ reading: reading && error === null, error }, loaded);
  }

  get gaps(): readonly TimeSpan[] {
    const all = [
      ...[...this.lists.values()].flatMap((l) => l.list.gaps),
      ...[...this.composites.values(), ...this.spans.values()].flatMap((h) => h.gaps),
    ];
    const joined = joinGaps(all);
    if (!sameGaps(joined, this.shownGaps)) this.shownGaps = joined;
    return this.shownGaps;
  }

  periods(period: ProfilePeriod, hours: ProfileHours = 'all', tpoMinutes?: number): readonly SessionProfileData[] {
    return this.list(period, tpoMinutes).sessions(hours);
  }

  ensureFrom(period: ProfilePeriod, fromMs: number, count: number, tpoMinutes?: number): void {
    this.list(period, tpoMinutes).ensureFrom(fromMs, count);
  }

  composite(n: number, period: ProfilePeriod, hours: ProfileHours): SessionProfileData | null {
    const rth = hours === 'rth';
    const count = Math.max(1, Math.round(n));
    const key = `${period}:${String(count)}:${rth ? 'rth' : 'all'}`;
    const held = this.ask(this.composites, key, { mode: 'composite', period, count, rth }, REFRESH_MS);
    const data = held.data;
    if (data && !rth && count === 5 && period === 'session') {
      const poc = field(this.levels, 'cpoc');
      const vah = field(this.levels, 'cvah');
      const val = field(this.levels, 'cval');
      if (poc !== null && vah !== null && val !== null) return { ...data, levels: { poc, vah, val } };
    }
    return data;
  }

  span(from: number, to: number | null, hours: ProfileHours): SessionProfileData | null {
    const rth = hours === 'rth';
    const key = spanKey(from, to, rth);
    const open = to === null || to > this.flow.clock.now() - REFRESH_MS;
    return this.ask(this.spans, key, { mode: 'range', from, to, rth }, open ? OPEN_SPAN_REFRESH_MS : Infinity).data;
  }

  setLevels(levels: readonly Level[]): void {
    if (levels === this.levels) return;
    this.levels = levels;
    for (const { list } of this.lists.values()) list.setLevels(levels);
    this.changed.emit();
  }

  private list(period: ProfilePeriod, tpoMinutes?: number): PeriodList {
    const key = tpoMinutes === undefined ? period : `${period}|tpo${String(tpoMinutes)}`;
    const held = this.lists.get(key);
    if (held) return held.list;
    const list = new PeriodList(this.flow, period, tpoMinutes ?? null, this.days);
    list.setLevels(this.levels);
    const off = list.changed.on(() => this.changed.emit());
    this.lists.set(key, { list, off });
    if (this.started) list.start();
    return list;
  }

  private ask(map: Map<string, Held>, key: string, q: Question, maxAge: number): Held {
    const now = this.flow.clock.now();
    let held = map.get(key);
    if (!held) {
      held = {
        q,
        maxAge,
        data: null,
        gaps: NO_GAPS,
        at: 0,
        asked: now,
        reading: false,
        answered: false,
        error: null,
        loaded: null,
      };
      map.set(key, held);
    }
    held.asked = now;
    held.maxAge = maxAge;
    if (readDue(held, now)) this.read(map, key, held);
    return held;
  }

  private question(q: Question): Promise<VolumeProfileOutput> {
    return Runtime.invoke(appClient(), 'market.get_volume_profile', {
      instrument: this.flow.instrument,
      mode: q.mode,
      ...(q.period === undefined || q.period === 'session' ? {} : { period: q.period }),
      ...(q.count === undefined ? {} : { count: q.count }),
      ...(q.from === undefined ? {} : { from: msToNs(q.from) }),
      ...(q.to === undefined || q.to === null ? {} : { to: msToNs(q.to) }),
      ...(q.rth ? { session: 'rth' as const } : {}),
      rowTicks: 1,
      maxRows: 500,
      daysToLoad: this.days,
    });
  }

  private read(map: Map<string, Held>, key: string, held: Held): void {
    const q = held.q;
    held.reading = true;
    const ask = () => this.question(q);
    const take = (out: VolumeProfileOutput) => {
      const p = out.profiles[out.profiles.length - 1];
      held.data = p ? profileData(p, this.flow.grid.tick, q.period ?? 'session') : null;
      held.gaps = p ? gapsOf(p.gaps) : NO_GAPS;
      held.loaded = loadedOf(out);
      held.at = this.flow.clock.now();
      held.answered = true;
      held.error = null;
      this.changed.emit();
    };
    this.running.run(
      ask,
      (out) => {
        held.reading = false;
        take(out);
        if (out.filling)
          this.refill.ask(`${q.mode}:${key}`, ask, take, (filling) => {
            held.loaded = loadedOf(filling);
            this.changed.emit();
          });
      },
      (e) => {
        held.reading = false;
        held.at = this.flow.clock.now();
        held.error = map.get(key) === held ? feedErrorWords(e) : null;
        this.changed.emit();
      },
    );
  }

  private refreshSpans(): void {
    const now = this.flow.clock.now();
    for (const map of [this.spans, this.composites])
      for (const [key, held] of map) {
        if (now - held.asked > SPAN_KEEP_MS) map.delete(key);
        else if (readDue(held, now)) this.read(map, key, held);
      }
  }
}
