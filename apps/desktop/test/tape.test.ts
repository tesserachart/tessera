import { AggTape, TickGrid, TradeTape } from '@tessera/chart';
import type { BigTrade, CompactTrade, TradesOutput, TradesUpdate } from '@tessera/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowHub, type Emitter, type InstrumentFlow } from '../src/market/flow/hub.ts';
import { rowTip, TapeController, type TapeActions, type TapeContext } from '../src/orderflow/tape/tapeController.ts';
import {
  DEFAULT_TAPE_PARAMS,
  filterWords,
  highlightSize,
  historyBefore,
  ordersOf,
  pillFor,
  printsOf,
  readTapeParams,
  MOST_BEHIND_MS,
  SCROLLBACK,
  stepMinSize,
  TapeClock,
  TapeList,
  TapePacer,
  tapeSize,
  tapeWords,
  type TapePill,
} from '../src/orderflow/tape/tapeModel.ts';
import { TapeView } from '../src/orderflow/tape/tapeView.ts';
import { fakeRuntime, type FakeRuntime } from './support/fakeRuntime.ts';
import { readsAgain } from './support/readsAgain.ts';
import { ns } from './support/time.ts';

const T0 = Date.parse('2026-10-02T14:42:00-04:00');

describe('tape params', () => {
  it('reads stored params, defaulting what is not valid', () => {
    expect(readTapeParams(undefined)).toEqual(DEFAULT_TAPE_PARAMS);
    expect(
      readTapeParams({
        minSize: 10,
        highlight: 50,
        side: 'sell',
        aggregate: false,
        millis: true,
        link: 'A',
        speed: 'slow',
      }),
    ).toEqual({
      ...DEFAULT_TAPE_PARAMS,
      minSize: 10,
      highlight: 50,
      side: 'sell',
      aggregate: false,
      millis: true,
      link: '1',
      speed: 'slow',
    });
    expect(readTapeParams({ minSize: -1, highlight: 'big', side: 'up', aggregate: 'yes', speed: 'warp' })).toEqual(
      DEFAULT_TAPE_PARAMS,
    );
    expect(readTapeParams({ minSize: null }).minSize).toBe(0);
  });

  it('shows every print by default, a fraction of a coin included', () => {
    expect(DEFAULT_TAPE_PARAMS.minSize).toBe(0);
    expect(DEFAULT_TAPE_PARAMS.speed).toBe('live');
    expect(readTapeParams({ minSize: 0.25 }).minSize).toBe(0.25);
  });

  it('says the filter in words only when one is on', () => {
    expect(filterWords({ minSize: 0, side: 'all' })).toBeNull();
    expect(filterWords({ minSize: 10, side: 'all' })).toBe('≥ 10');
    expect(filterWords({ minSize: 0, side: 'buy' })).toBe('Buys');
    expect(filterWords({ minSize: 1000, side: 'sell' })).toBe('Sells ≥ 1,000');
    expect(tapeWords({ minSize: 0, side: 'all', speed: 'live' })).toBeNull();
    expect(tapeWords({ minSize: 0, side: 'all', speed: 'slow' })).toBe('Slow');
    expect(tapeWords({ minSize: 25, side: 'buy', speed: 'fast' })).toBe('Buys ≥ 25 · Fast');
  });

  it('steps the min size along 1, 2, 5, 10, 25, 50 and on, from any typed size', () => {
    const up = [0];
    while (up.length < 12) up.push(stepMinSize(up.at(-1)!, 1));
    expect(up).toEqual([0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500]);
    expect(stepMinSize(2500, -11)).toBe(0);
    expect(stepMinSize(7, 1)).toBe(10);
    expect(stepMinSize(7, -1)).toBe(5);
    expect(stepMinSize(0.4, 1)).toBe(1);
    expect(stepMinSize(0.4, -1)).toBe(0);
    expect(stepMinSize(0, -1)).toBe(0);
    expect(stepMinSize(10, 4)).toBe(250);
  });

  it('highlights from the size set, or the big-trade threshold once read', () => {
    expect(highlightSize({ highlight: 25 }, 60)).toBe(25);
    expect(highlightSize({ highlight: 'auto' }, 60)).toBe(60);
    expect(highlightSize({ highlight: 'auto' }, null)).toBeNull();
  });

  it('writes sizes and New York times', () => {
    expect(tapeSize(3)).toBe('3');
    expect(tapeSize(1250)).toBe('1,250');
    expect(tapeSize(12_400)).toBe('12.4k');
    const clock = new TapeClock();
    expect(clock.parts(ns(Date.parse('2026-10-02T14:31:02.118-04:00')))).toEqual(['14:31:02', '.118']);
    expect(clock.parts(ns(Date.parse('2026-10-02T00:00:59.004-04:00')))).toEqual(['00:00:59', '.004']);
  });
});

function tape() {
  const t = new TradeTape(new TickGrid(0.25, 2), 1024);
  const agg = new AggTape(t, 1024);
  let seq = 0;
  t.applySnapshot({ seq: 0, trades: [] });
  const add = (prints: number[][]) => {
    seq += prints.length;
    t.apply({ seq, trades: prints });
    agg.sync();
  };
  return { t, agg, add };
}

describe('the list', () => {
  it('keeps prints newest first and reads only what is new', () => {
    const { t, add } = tape();
    const list = new TapeList();
    const src = printsOf(t);
    add([
      [ns(T0), 5812, 1, 1],
      [ns(T0 + 1), 5812.25, 3, -1],
    ]);
    list.sync(src);
    expect(list.length).toBe(2);
    expect(list.row(0)).toMatchObject({ price: 5812.25, size: 3, side: -1, key: 'l1' });
    expect(list.row(1)).toMatchObject({ price: 5812, size: 1, side: 1 });
    add([[ns(T0 + 2), 5812.5, 7, 1]]);
    expect(list.sync(src)).toBe(true);
    expect(list.row(0)?.size).toBe(7);
    expect(list.sync(src)).toBe(false);
  });

  it('filters by size and side, rebuilding when the filter changes', () => {
    const { t, add } = tape();
    const list = new TapeList();
    const src = printsOf(t);
    add([
      [ns(T0), 5812, 1, 1],
      [ns(T0 + 1), 5812.25, 12, -1],
      [ns(T0 + 2), 5812.25, 30, 1],
    ]);
    list.setFilter({ minSize: 10, side: 'all' });
    list.sync(src);
    expect([list.row(0)?.size, list.row(1)?.size]).toEqual([30, 12]);
    list.setFilter({ minSize: 10, side: 'sell' });
    list.sync(src);
    expect(list.length).toBe(1);
    expect(list.row(0)?.size).toBe(12);
  });

  it('shows an order once it closes and an open one that reaches the min size as it grows', () => {
    const { agg, add } = tape();
    const list = new TapeList();
    const src = ordersOf(agg);
    list.setFilter({ minSize: 5, side: 'all' });
    add([[ns(T0), 5812, 3, 1, 9]]);
    list.sync(src);
    expect(list.length).toBe(0);
    add([[ns(T0 + 1), 5812.25, 3, 1, 9]]);
    list.sync(src);
    expect(list.length).toBe(1);
    expect(list.row(0)).toMatchObject({ size: 6, prints: 2 });
    expect(list.row(0)?.price).toBe(5812.25);
    expect(list.row(0)?.average).toBeCloseTo(5812.125);
    add([[ns(T0 + 2), 5811.75, 8, -1, 10]]);
    list.sync(src);
    expect(list.length).toBe(2);
    expect(list.row(0)).toMatchObject({ size: 8, side: -1 });
    expect(list.row(1)).toMatchObject({ size: 6, prints: 2 });
  });

  it('holds still while frozen and counts what arrives', () => {
    const { t, add } = tape();
    const list = new TapeList();
    const src = printsOf(t);
    add([[ns(T0), 5812, 1, 1]]);
    list.sync(src);
    list.freeze();
    add([
      [ns(T0 + 1), 5812.25, 2, 1],
      [ns(T0 + 2), 5812.5, 3, 1],
    ]);
    list.sync(src);
    expect(list.length).toBe(1);
    expect(list.row(0)?.size).toBe(1);
    expect(list.fresh).toBe(2);
    list.resume();
    expect(list.fresh).toBe(0);
    expect(list.row(0)?.size).toBe(3);
  });

  it('follows the live rows with history only while nothing between them was lost', () => {
    const { t, add } = tape();
    const list = new TapeList();
    const src = printsOf(t);
    add([[ns(T0), 5812, 1, 1]]);
    list.sync(src);
    list.setHistory([
      { ns: ns(T0 - 2000), price: 5811, average: 5811, size: 4, side: -1, prints: 1 },
      { ns: ns(T0 - 1000), price: 5811.5, average: 5811.5, size: 5, side: 1, prints: 1 },
    ]);
    expect(list.length).toBe(3);
    expect(list.row(1)).toMatchObject({ price: 5811.5, size: 5 });
    expect(list.row(2)?.key.startsWith('h')).toBe(true);
    list.setFilter({ minSize: 5, side: 'all' });
    list.sync(src);
    expect(list.length).toBe(1);
    for (let k = 0; k < 1100; k++) add([[ns(T0 + 10 + k), 5812, 6, 1]]);
    list.sync(src);
    expect(list.length).toBe(1024);
    expect(list.row(list.length - 1)?.key.startsWith('l')).toBe(true);
  });

  it('finds the print a bubble names, by its first print or by time', () => {
    const { t, agg, add } = tape();
    add([
      [ns(T0), 5812, 1, 1, 1],
      [ns(T0 + 5), 5812.25, 40, -1, 2],
      [ns(T0 + 5), 5812, 10, -1, 2],
      [ns(T0 + 9), 5812.5, 2, 1, 3],
    ]);
    const orders = new TapeList();
    orders.sync(ordersOf(agg));
    expect(orders.find('live:1', T0 + 5, 50)).toBe(1);
    const prints = new TapeList();
    prints.sync(printsOf(t));
    expect(prints.find('live:1', T0 + 5, 50)).toBe(2);
    expect(prints.find(`h:${String(ns(T0 + 9))}`, T0 + 9, 2)).toBe(0);
    expect(prints.find('h:1', T0 + 60_000, 2)).toBeNull();
    expect(prints.posOf('l2')).toBe(1);
  });

  it('drops history rows at or after the first live print, past the doubles a nanosecond time rounds to', () => {
    const first = JSON.parse('1791052920123456789') as number;
    const row = (ns: number, price: number) => ({ ns, price, average: price, size: 1, side: 1, prints: 1 });
    const history = [row(first - 4096, 5811.75), row(first, 5812), row(first, 5812)];
    expect(historyBefore(history, first)).toEqual([history[0]]);
    expect(historyBefore(history, null)).toBe(history);
    const clean = history.slice(0, 1);
    expect(historyBefore(clean, first)).toBe(clean);
  });

  it('lets a paced list show the waiting rows oldest first, as it is told to', () => {
    const { t, add } = tape();
    const list = new TapeList();
    const src = printsOf(t);
    add([[ns(T0), 5812, 1, 1]]);
    list.sync(src);
    list.setPaced(true);
    add([
      [ns(T0 + 1), 5812.25, 2, 1],
      [ns(T0 + 2), 5812.5, 3, 1],
      [ns(T0 + 3), 5812.75, 4, 1],
    ]);
    list.sync(src);
    expect(list.length).toBe(1);
    expect(list.waiting).toBe(3);
    list.reveal(1);
    expect([list.row(0)?.size, list.row(1)?.size]).toEqual([2, 1]);
    expect(list.waiting).toBe(2);
    list.freeze();
    expect(list.fresh).toBe(2);
    expect(list.row(0)?.size).toBe(2);
    list.resume();
    expect(list.waiting).toBe(0);
    expect(list.row(0)?.size).toBe(4);
    list.setPaced(false);
    add([[ns(T0 + 4), 5813, 5, 1]]);
    list.sync(src);
    expect(list.row(0)?.size).toBe(5);
  });

  it('keeps a paced order shown while it grows, and shows every row at once when the filter changes', () => {
    const { agg, add } = tape();
    const list = new TapeList();
    const src = ordersOf(agg);
    list.setPaced(true);
    add([[ns(T0), 5812, 3, 1, 9]]);
    list.sync(src);
    expect(list.length).toBe(1);
    add([[ns(T0 + 1), 5812.25, 3, 1, 9]]);
    list.sync(src);
    expect(list.waiting).toBe(0);
    expect(list.row(0)).toMatchObject({ size: 6, prints: 2 });
    add([
      [ns(T0 + 2), 5811.75, 8, -1, 10],
      [ns(T0 + 3), 5812, 9, 1, 11],
    ]);
    list.sync(src);
    expect(list.waiting).toBe(2);
    list.setFilter({ minSize: 5, side: 'all' });
    list.sync(src);
    expect(list.waiting).toBe(0);
    expect(list.length).toBe(3);
  });

  it('keeps at most the scrollback', () => {
    const t = new TradeTape(new TickGrid(0.25, 2), 32_768);
    t.applySnapshot({ seq: 0, trades: [] });
    const prints = Array.from({ length: SCROLLBACK + 500 }, (_, k) => [ns(T0 + k), 5812, 1, 1]);
    t.apply({ seq: prints.length, trades: prints });
    const list = new TapeList();
    list.sync(printsOf(t));
    expect(list.length).toBe(SCROLLBACK);
  });
});

describe('the tape speed', () => {
  const paced = () => {
    const { t, add } = tape();
    const list = new TapeList();
    const src = printsOf(t);
    list.sync(src);
    list.setPaced(true);
    let at = 0;
    const burst = (n: number) => {
      add(Array.from({ length: n }, () => [ns(T0 + at++), 5812, 1, 1]));
      list.sync(src);
    };
    return { list, burst };
  };

  it('shows a lone print at once and spaces a burst out at the speed', () => {
    const { list, burst } = paced();
    const pacer = new TapePacer();
    burst(1);
    pacer.step(list, 0, 4);
    expect(list.length).toBe(1);
    burst(3);
    pacer.step(list, 16, 4);
    expect(list.length).toBe(1);
    pacer.step(list, 250, 4);
    expect(list.length).toBe(2);
    pacer.step(list, 400, 4);
    expect(list.length).toBe(2);
    pacer.step(list, 500, 4);
    pacer.step(list, 750, 4);
    expect(list.length).toBe(4);
    expect(list.waiting).toBe(0);
  });

  it('shows the first print of a burst at once after a quiet spell, without saving up for the rest', () => {
    const { list, burst } = paced();
    const pacer = new TapePacer();
    burst(1);
    pacer.step(list, 0, 4);
    burst(5);
    pacer.step(list, 10_000, 4);
    expect(list.length).toBe(2);
    expect(list.waiting).toBe(4);
  });

  it('is never more than its most behind under a print rate above its speed', () => {
    const { list, burst } = paced();
    const pacer = new TapePacer();
    let behind = 0;
    for (let now = 0; now <= 10_000; now += 16) {
      burst(2);
      pacer.step(list, now, 3);
      behind = Math.max(behind, list.waiting);
    }
    const perFrame = 2;
    const framesBehind = MOST_BEHIND_MS / 16 + 1;
    expect(behind).toBeLessThanOrEqual(perFrame * framesBehind);
    expect(list.waiting).toBeGreaterThan(0);
  });

  it('shows rows evenly while it catches up, not in the lumps they came in', () => {
    const { list, burst } = paced();
    const pacer = new TapePacer();
    pacer.step(list, 0, 3);
    const shown: number[] = [];
    for (let now = 16; now <= 6_000; now += 16) {
      if (now % 1_008 === 0) burst(60);
      const before = list.length;
      pacer.step(list, now, 3);
      shown.push(list.length - before);
    }
    expect(Math.max(...shown)).toBeLessThanOrEqual(2);
  });
});

describe('the pill', () => {
  const base = { frozen: false, fresh: 0, held: false, dropped: null, flash: null };
  it('counts what arrived while frozen and says nothing while live', () => {
    expect(pillFor(base)).toBeNull();
    expect(pillFor({ ...base, frozen: true })).toBeNull();
    expect(pillFor({ ...base, frozen: true, fresh: 1238 })).toEqual({ kind: 'fresh', text: '1,238 new' });
    expect(pillFor({ ...base, frozen: true, held: true })).toEqual({ kind: 'paused', text: 'Paused' });
  });
  it('says when a closed market opens again, behind anything the trader is doing', () => {
    const closed = 'Closed · opens Sun 18:00 ET';
    expect(pillFor({ ...base, closed })).toEqual({ kind: 'note', text: closed });
    expect(pillFor({ ...base, closed, frozen: true, held: true })).toEqual({ kind: 'paused', text: 'Paused' });
    expect(pillFor({ ...base, closed, dropped: 'Rithmic dropped.' })?.text).toBe('Rithmic dropped.');
  });
  it('says why the feed stopped', () => {
    expect(pillFor({ ...base, dropped: 'Rithmic dropped. Reconnecting, 3rd try.' })?.text).toBe(
      'Rithmic dropped. Reconnecting, 3rd try.',
    );
  });
});

const ES = 'ESZ6.CME';
const ROW_H = 20;
const ROWS = 10;
const source = { provider: 'rithmic-test' };

const history = (over: Partial<TradesOutput> = {}): TradesOutput => ({
  instrument: ES,
  priceDecimals: 2,
  columns: [],
  trades: [[ns(T0 - 60_000), 5810, 4, -1]],
  aggregated: true,
  prints: [1],
  last: [5810],
  threshold: { size: 25, floor: 25, orders: 0, sessions: 0 },
  aggressorSource: 'exchange',
  gaps: [],
  filling: false,
  truncated: false,
  provider: 'rithmic-test',
  ...over,
});

const next = (changed: Emitter) =>
  new Promise<void>((resolve) => {
    const off = changed.on(() => {
      off();
      resolve();
    });
  });

interface Rig {
  rt: FakeRuntime;
  flow: InstrumentFlow;
  ctrl: TapeController;
  viewport: HTMLDivElement;
  content: HTMLDivElement;
  ctx: TapeContext;
  pill: () => TapePill | null;
  loading: () => boolean | null;
  marks: ReturnType<typeof vi.fn>;
  print: (price: number, size: number, side: number, order?: number) => Promise<void>;
  judgeLast: () => Promise<void>;
  answer: (out: TradesOutput) => void;
  refuse: (message: string) => Promise<void>;
}

async function rig({ held = false }: { held?: boolean } = {}): Promise<Rig> {
  let answer = history();
  const rt = fakeRuntime({ answers: held ? {} : { 'market.get_trades': () => answer } });
  const now = { t: T0 };
  const hub = new FlowHub({ now: () => now.t });
  const { flow } = hub.acquire('ES', 0.25, 2);
  flow.useTrades();
  const sub = await vi.waitFor(() => rt.sub('market.trades'));
  const viewport = document.createElement('div');
  const content = document.createElement('div');
  viewport.appendChild(content);
  document.body.appendChild(viewport);
  Object.defineProperty(viewport, 'clientHeight', { value: ROWS * ROW_H });
  const ctx: TapeContext = {
    params: { ...DEFAULT_TAPE_PARAMS, aggregate: false },
    decimals: 2,
    dropped: () => null,
    closed: null,
  };
  let pill: TapePill | null = null;
  let loading: boolean | null = null;
  const marks = vi.fn();
  const actions: TapeActions = {
    pill: (p) => {
      pill = p;
    },
    loading: (on) => {
      loading = on;
    },
    mark: marks,
  };
  const ctrl = new TapeController(
    new TapeView(viewport, content),
    () => ctx,
    actions,
    () => ROW_H,
  );
  ctrl.setFlow(flow);
  let seq = 0;
  const send = (u: TradesUpdate, at?: number) => {
    const took = next(flow.tradesChanged);
    sub.event(u, at);
    return took;
  };
  await send({ instrument: ES, seq: 0, trades: [], source, aggressorSource: null }, 0);
  if (!held) {
    ctrl.frame();
    await new Promise((res) => setTimeout(res, 0));
  }
  return {
    rt,
    flow,
    ctrl,
    viewport,
    content,
    ctx,
    pill: () => pill,
    loading: () => loading,
    marks,
    print: (price, size, side, order) => {
      seq++;
      now.t += 10;
      const p: CompactTrade =
        order === undefined ? [ns(now.t), price, size, side] : [ns(now.t), price, size, side, order];
      return send({ instrument: ES, seq, trades: [p], source, aggressorSource: 'exchange' });
    },
    judgeLast: () => {
      const t = flow.tape;
      const i = t.end - 1;
      const big: BigTrade = {
        t: ns(t.msAt(i)),
        durationNs: 0,
        side: t.sideAt(i) > 0 ? 'buy' : 'sell',
        size: t.sizeAt(i),
        price: t.priceAt(i),
        firstPrice: t.priceAt(i),
        lastPrice: t.priceAt(i),
        levels: 1,
        rangeTicks: 0,
        prints: 1,
        orders: 1,
        tier: 'medium',
        outcome: null,
        seq,
      };
      return send({ instrument: ES, seq, trades: [], source, aggressorSource: 'exchange', bigTrades: [big] });
    },
    answer: (out) => {
      answer = out;
    },
    refuse: (message) => {
      const told = next(flow.statusChanged);
      sub.refuse(message);
      return told;
    },
  };
}

const rows = (r: Rig) =>
  [...r.content.querySelectorAll<HTMLElement>('.r')]
    .filter((e) => e.style.display !== 'none')
    .sort((a, b) => Number(a.dataset.pos) - Number(b.dataset.pos));

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the T&S live loop', () => {
  it('shows no prints until the history before them answers, then the live and older prints at once', async () => {
    const r = await rig({ held: true });
    await r.print(5812, 30, 1);
    await r.print(5812.25, 40, -1);
    r.ctrl.frame();
    expect(r.loading()).toBe(true);
    expect(rows(r)).toHaveLength(0);
    r.rt.pending('market.get_trades').ok(history());
    await new Promise((res) => setTimeout(res, 0));
    r.ctrl.frame();
    expect(r.loading()).toBe(false);
    const shown = rows(r);
    expect(shown[0]!.querySelector('.px')!.textContent).toBe('5,812.25');
    expect(shown.at(-1)!.querySelector('.px')!.textContent).toBe('5,810.00');
  });

  it('writes the newest print on top, sizes coloured by the aggressor, big ones washed', async () => {
    const r = await rig();
    await r.print(5812, 30, 1);
    await r.print(5812.25, 40, -1);
    r.ctrl.frame();
    await new Promise((res) => setTimeout(res, 0));
    r.ctrl.frame();
    let [top] = rows(r);
    expect(top!.querySelector('.px')!.textContent).toBe('5,812.25');
    expect(top!.querySelector('.sz')!.textContent).toBe('40');
    expect(top!.classList.contains('is-sell')).toBe(true);
    expect(top!.classList.contains('is-big')).toBe(false);
    await r.judgeLast();
    r.ctrl.frame();
    const after = rows(r);
    top = after[0];
    const next = after[1];
    expect(top!.classList.contains('is-big')).toBe(true);
    expect(next!.classList.contains('is-buy')).toBe(true);
    expect(next!.classList.contains('is-big')).toBe(false);
    expect(top!.querySelector<HTMLElement>('.bar')!.style.transform).toBe('scaleX(1)');
    const last = rows(r).at(-1)!;
    expect(last.querySelector('.px')!.textContent).toBe('5,810.00');
  });

  it('holds still under the pointer, counts what arrives, and resumes on leave at the newest print', async () => {
    const r = await rig();
    await r.print(5812, 3, 1);
    r.ctrl.frame();
    r.viewport.dispatchEvent(new MouseEvent('pointerenter'));
    await r.print(5812.25, 4, 1);
    await r.print(5812.5, 5, 1);
    r.ctrl.frame();
    expect(rows(r)[0]!.querySelector('.sz')!.textContent).toBe('3');
    expect(r.pill()).toEqual({ kind: 'fresh', text: '2 new' });
    r.viewport.dispatchEvent(new MouseEvent('pointerleave'));
    r.ctrl.frame();
    expect(rows(r)[0]!.querySelector('.sz')!.textContent).toBe('5');
    expect(r.pill()).toBeNull();
  });

  it('holds still under its row menu, whose overlay takes the pointer, until the pointer moves outside after it', async () => {
    const r = await rig();
    await r.print(5812, 3, 1);
    r.ctrl.frame();
    r.viewport.dispatchEvent(new MouseEvent('pointerenter'));
    r.ctrl.menuOpened();
    r.viewport.dispatchEvent(new MouseEvent('pointerleave'));
    await r.print(5812.25, 4, 1);
    r.ctrl.frame();
    expect(rows(r)[0]!.querySelector('.sz')!.textContent).toBe('3');
    expect(r.pill()).toEqual({ kind: 'fresh', text: '1 new' });
    vi.spyOn(r.viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, ROWS * ROW_H));
    r.ctrl.menuClosed();
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 40 }));
    r.ctrl.frame();
    expect(r.ctrl.paused).toBe(true);
    r.viewport.dispatchEvent(new MouseEvent('pointerleave'));
    r.ctrl.frame();
    expect(rows(r)[0]!.querySelector('.sz')!.textContent).toBe('4');
    r.ctrl.menuOpened();
    await r.print(5812.5, 5, 1);
    r.ctrl.frame();
    expect(rows(r)[0]!.querySelector('.sz')!.textContent).toBe('4');
    r.ctrl.menuClosed();
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 400, clientY: 40 }));
    r.ctrl.frame();
    expect(r.ctrl.paused).toBe(false);
    expect(rows(r)[0]!.querySelector('.sz')!.textContent).toBe('5');
  });

  it('dropping the tape clears the last instrument’s prints so a new name cannot wear them', async () => {
    const r = await rig();
    await r.print(5812, 30, 1);
    r.ctrl.frame();
    expect(r.content.textContent).toContain('5,812.00');
    r.ctrl.setFlow(null);
    r.ctrl.frame();
    expect(rows(r)).toHaveLength(0);
    expect(rows(r).some((e) => e.textContent.includes('5,812.00'))).toBe(false);
  });

  it('paces a burst at the tape speed and shows the newest at once when asked', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const r = await rig();
    r.ctx.params = { ...r.ctx.params, speed: 'slow' };
    r.ctrl.frame();
    const before = rows(r).length;
    await r.print(5812, 30, 1);
    await r.print(5812.25, 40, -1);
    await r.print(5812.5, 50, 1);
    now.mockReturnValue(16);
    r.ctrl.frame();
    expect(rows(r)).toHaveLength(before + 1);
    expect(rows(r)[0]!.querySelector('.sz')!.textContent).toBe('30');
    now.mockReturnValue(200);
    r.ctrl.frame();
    expect(rows(r)).toHaveLength(before + 1);
    now.mockReturnValue(360);
    r.ctrl.frame();
    expect(rows(r)[0]!.querySelector('.sz')!.textContent).toBe('40');
    r.ctrl.resume();
    r.ctrl.frame();
    expect(rows(r)).toHaveLength(before + 3);
    expect(rows(r)[0]!.querySelector('.sz')!.textContent).toBe('50');
  });

  it('shows every print at once on Live', async () => {
    const r = await rig();
    r.ctrl.frame();
    const before = rows(r).length;
    await r.print(5812, 30, 1);
    await r.print(5812.25, 40, -1);
    await r.print(5812.5, 50, 1);
    r.ctrl.frame();
    expect(rows(r)).toHaveLength(before + 3);
  });

  it('toggles with Space and says it is paused', async () => {
    const r = await rig();
    await r.print(5812, 3, 1);
    r.ctrl.toggle();
    r.ctrl.frame();
    expect(r.pill()).toEqual({ kind: 'paused', text: 'Paused' });
    r.ctrl.toggle();
    r.ctrl.frame();
    expect(r.pill()).toBeNull();
  });

  it('scrolls to the print a bubble names, outlines it and pauses', async () => {
    const r = await rig();
    for (let k = 0; k < 30; k++) await r.print(5812, 2, 1, k);
    await r.print(5813, 60, -1, 99);
    const big = r.flow.tape.end - 1;
    for (let k = 0; k < 30; k++) await r.print(5812, 2, 1, 200 + k);
    r.ctrl.frame();
    const ok = r.ctrl.focusPrint({
      instrument: 'ES',
      t: r.flow.tape.msAt(big),
      price: 5813,
      size: 60,
      side: -1,
      ref: `live:${String(big)}`,
    });
    expect(ok).toBe(true);
    expect(r.ctrl.paused).toBe(true);
    expect(r.ctrl.focused).toBe(`l${String(big)}`);
    r.ctrl.frame();
    expect(r.viewport.scrollTop).toBe(30 * ROW_H - (ROWS * ROW_H - ROW_H) / 2);
    const focused = rows(r).find((e) => e.classList.contains('is-focus'));
    expect(focused?.querySelector('.sz')!.textContent).toBe('60');
  });

  it('says when the print is not in the list', async () => {
    const r = await rig();
    r.ctx.params = { ...r.ctx.params, minSize: 100 };
    await r.print(5813, 60, -1);
    r.ctrl.frame();
    expect(r.ctrl.focusPrint({ instrument: 'ES', t: T0 + 10, price: 5813, size: 60, side: -1, ref: 'live:0' })).toBe(
      false,
    );
    r.ctrl.frame();
    expect(r.pill()).toEqual({ kind: 'note', text: 'The filter hides that print' });
  });

  it('marks a clicked row on the chart and clears it when told', async () => {
    const r = await rig();
    await r.print(5812.5, 3, 1);
    r.ctrl.frame();
    const top = rows(r)[0]!;
    top.querySelector('.px')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(r.marks).toHaveBeenCalledWith(expect.objectContaining({ price: 5812.5, size: 3 }));
    r.ctrl.frame();
    expect(rows(r)[0]!.classList.contains('is-marked')).toBe(true);
    r.ctrl.clearMark();
    r.ctrl.frame();
    expect(rows(r)[0]!.classList.contains('is-marked')).toBe(false);
  });

  it('says why the prints stopped, and drops the words once they come again', async () => {
    const r = await rig();
    await r.refuse('Rithmic dropped. Reconnecting, 3rd try.');
    r.ctrl.frame();
    expect(r.pill()).toEqual({ kind: 'note', text: 'Rithmic dropped. Reconnecting, 3rd try.' });
    await r.print(5812, 3, 1);
    r.ctrl.frame();
    expect(r.pill()).toBeNull();
  });

  it('moves the rows already written when a print arrives, writing only the new one', async () => {
    const r = await rig();
    await r.print(5812, 3, 1);
    await r.print(5812.25, 4, 1);
    r.ctrl.frame();
    const before = rows(r);
    const second = before[0]!;
    let writes = 0;
    const watch = new MutationObserver((m) => {
      writes += m.length;
    });
    watch.observe(second, { childList: true, subtree: true, characterData: true });
    await r.print(5812.5, 5, 1);
    r.ctrl.frame();
    const after = rows(r);
    expect(after[1]).toBe(second);
    expect(second.style.transform).toBe(`translateY(${String(ROW_H)}px)`);
    expect(after[0]!.querySelector('.sz')!.textContent).toBe('5');
    await new Promise((res) => setTimeout(res, 0));
    expect(writes).toBe(0);
    watch.disconnect();
  });

  it('reads an aggregated history row at its last price, its average kept for the tooltip', async () => {
    const r = await rig();
    r.ctx.params = { ...r.ctx.params, aggregate: true };
    r.answer(history({ trades: [[ns(T0 - 60_000), 5810.1, 10, 1]], prints: [4], last: [5810.25], threshold: null }));
    await r.print(5812, 3, 1);
    r.ctrl.frame();
    await new Promise((res) => setTimeout(res, 0));
    r.ctrl.frame();
    const row = r.ctrl.list.row(r.ctrl.list.length - 1)!;
    expect(row).toMatchObject({ price: 5810.25, average: 5810.1, prints: 4 });
    expect(rows(r).at(-1)!.querySelector('.px')!.textContent).toBe('5,810.25');
    expect(rowTip(row, 2)).toBe('Average 5,810.10 · 4 prints');
    expect(rowTip({ ...row, prints: 1 }, 2)).toBeNull();
  });

  it('reads the history again while the runtime is still filling it, then shows the settled prints', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const r = await rig({ held: true });
      r.ctrl.frame();
      r.rt.pending('market.get_trades').ok(history({ trades: [], prints: [], last: [], filling: true }));
      await vi.advanceTimersByTimeAsync(0);
      r.ctrl.frame();
      expect(rows(r), 'nothing held yet: the last session is still being read').toHaveLength(0);
      await readsAgain(1);
      (await vi.waitFor(() => r.rt.pending('market.get_trades'))).ok(history());
      await vi.advanceTimersByTimeAsync(0);
      r.ctrl.frame();
      expect(rows(r).map((e) => e.querySelector('.px')!.textContent)).toEqual(['5,810.00']);
      await readsAgain(2);
      const historyReads = r.rt
        .toolCalls('market.get_trades')
        .filter((c) => (c.input as { limit: number }).limit === 5000);
      expect(historyReads, 'a settled answer is not asked again').toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads history before the live tape once per filter', async () => {
    const r = await rig();
    await r.print(5812, 3, 1);
    r.ctrl.frame();
    r.ctrl.frame();
    const historyReads = () =>
      r.rt.toolCalls('market.get_trades').filter((c) => (c.input as { limit: number }).limit === 5000);
    await vi.waitFor(() => expect(historyReads()).toHaveLength(1));
    r.ctx.params = { ...r.ctx.params, minSize: 5 };
    r.ctrl.frame();
    await vi.waitFor(() => expect(historyReads()).toHaveLength(2));
    expect(historyReads()[1]!.input).toMatchObject({ minSize: 5 });
    r.ctrl.frame();
    r.ctrl.frame();
    await new Promise((res) => setTimeout(res, 0));
    expect(historyReads()).toHaveLength(2);
  });
});

describe('the chart mark', () => {
  it('clears on the next press outside a tape row', async () => {
    const { markTime, onMarkTime } = await import('../src/market/flow/events.ts');
    const seen: unknown[] = [];
    const off = onMarkTime((m) => seen.push(m));
    markTime({ instrument: 'ES', t: T0, price: 5812 });
    const row = document.createElement('div');
    row.className = 't-tape';
    row.innerHTML = '<div class="r"><span>x</span></div>';
    document.body.appendChild(row);
    row.querySelector('span')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(seen).toEqual([{ instrument: 'ES', t: T0, price: 5812 }]);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(seen).toEqual([{ instrument: 'ES', t: T0, price: 5812 }, null]);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(seen.length).toBe(2);
    off();
  });
});
