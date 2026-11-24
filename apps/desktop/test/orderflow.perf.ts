import { BookStore, TickGrid, TradeTape } from '@tessera/chart';
import { describe, expect, it } from 'vitest';
import {
  centredOn,
  ladderRows,
  PriceLabels,
  type LadderFrameInput,
  type LadderRow,
} from '../src/orderflow/dom/ladderModel.ts';
import { LadderView } from '../src/orderflow/dom/ladderView.ts';
import {
  MOST_BEHIND_MS,
  printsOf,
  rowsPerSecond,
  TapeClock,
  TapeList,
  TapePacer,
} from '../src/orderflow/tape/tapeModel.ts';
import { TapeView } from '../src/orderflow/tape/tapeView.ts';
import { threadMs } from './support/cpu.ts';

const REPORT = process.env.TESSERA_PERF_REPORT === '1';
const LIMIT = REPORT ? 0.6 : 8;
const grid = new TickGrid(0.25, 2);
const MID = grid.toTick(20_640);

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { median: q(0.5), p95: q(0.95) };
}

async function writesDuring(root: Element, run: () => void): Promise<number> {
  let n = 0;
  const watch = new MutationObserver((m) => {
    n += m.length;
  });
  watch.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  run();
  await new Promise((res) => setTimeout(res, 0));
  watch.disconnect();
  return n;
}

describe('perf: the DOM ladder write (60 rows, a changing book)', () => {
  const book = new BookStore(grid);
  const levels = (k: number, side: 1 | -1) =>
    Array.from({ length: 40 }, (_, i) => [
      grid.toPrice(MID + side * (i + (side > 0 ? 1 : 0))),
      10 + ((i * 7 + k) % 90),
    ]);
  book.apply({ seq: 1, kind: 'snapshot', levels: 40, bids: levels(0, -1), asks: levels(0, 1) }, 0);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const view = new LadderView(root, root);
  view.setCount(60);
  let centre = MID;
  const input = (): LadderFrameInput => ({
    window: centredOn(centre, 1, 60, 1),
    count: 60,
    book,
    last: MID,
    volume: null,
    tags: [],
    average: null,
    toPrice: (x) => grid.toPrice(x),
    decimals: 2,
    tick: 0.25,
  });
  const paint = { hover: null, press: null, drag: null, volume: 'off' as const };
  const held: LadderRow[] = [];
  const labels = new PriceLabels();
  const rows = () => ladderRows(input(), held, labels);
  let seq = 1;
  const change = (k: number) => {
    seq++;
    book.apply({ seq, kind: 'delta', levels: 40, bids: [[grid.toPrice(MID - (k % 20)), 50 + k]], asks: [] }, seq * 25);
  };

  it('writes only what changed, within budget', async () => {
    view.render(rows(), paint, null);
    expect(await writesDuring(root, () => view.render(rows(), paint, null))).toBe(0);
    change(3);
    const one = await writesDuring(root, () => view.render(rows(), paint, null));
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThanOrEqual(4);
    centre = MID + 3;
    const moved = await writesDuring(root, () => view.render(rows(), paint, null));
    const fresh = await writesDuring(root, () => {
      centre = MID + 40;
      view.render(rows(), paint, null);
    });
    console.info(`[perf] domShift: 3 rows moved ${String(moved)} writes, a new window ${String(fresh)}`);
    expect(moved).toBeLessThan(fresh / 4);
    centre = MID;
    view.render(rows(), paint, null);
    const samples: number[] = [];
    for (let k = 0; k < 200; k++) {
      change(k);
      const t0 = threadMs();
      view.render(rows(), paint, null);
      samples.push(threadMs() - t0);
    }
    const s = stats(samples.slice(20));
    console.info(
      `[perf] domWrite median ${s.median.toFixed(3)} ms, p95 ${s.p95.toFixed(3)} ms (limit ${String(LIMIT)})`,
    );
    expect(REPORT ? s.p95 : s.median).toBeLessThan(LIMIT);
  });
});

describe('perf: the Time & Sales write (a print a frame)', () => {
  it('writes the new row and moves the rest, within budget', async () => {
    const tape = new TradeTape(grid, 32_768);
    tape.applySnapshot({ seq: 0, trades: [] });
    let seq = 0;
    let ns = Date.parse('2026-10-02T14:42:00-04:00') * 1e6;
    const print = (k: number) => {
      seq++;
      ns += 37_000_000;
      tape.apply({ seq, trades: [[ns, grid.toPrice(MID + (k % 7) - 3), 1 + (k % 13), k % 2 ? 1 : -1]] });
    };
    for (let k = 0; k < 100; k++) print(k);
    const viewport = document.createElement('div');
    const content = document.createElement('div');
    viewport.appendChild(content);
    document.body.appendChild(viewport);
    Object.defineProperty(viewport, 'clientHeight', { value: 40 * 20 });
    const view = new TapeView(viewport, content);
    const list = new TapeList();
    const src = printsOf(tape);
    const clock = new TapeClock();
    const paint = { highlight: 10, focus: null, marked: null, millis: true, aggregate: false, decimals: 2 };
    list.sync(src);
    view.render(list, 20, clock, paint);
    print(100);
    list.sync(src);
    const writes = await writesDuring(content, () => view.render(list, 20, clock, paint));
    const rows = 41;
    expect(writes).toBeLessThanOrEqual(10 + rows * 2 + 2);
    const samples: number[] = [];
    for (let k = 0; k < 300; k++) {
      print(k);
      list.sync(src);
      const t0 = threadMs();
      view.render(list, 20, clock, paint);
      samples.push(threadMs() - t0);
    }
    const s = stats(samples.slice(30));
    console.info(
      `[perf] tapeWrite median ${s.median.toFixed(3)} ms, p95 ${s.p95.toFixed(3)} ms (limit ${String(LIMIT)})`,
    );
    expect(REPORT ? s.p95 : s.median).toBeLessThan(LIMIT);
  });
});

describe('perf: the Time & Sales under a heavy print rate (40 prints a frame)', () => {
  const run = (speed: 'live' | 'fast') => {
    const tape = new TradeTape(grid, 32_768);
    tape.applySnapshot({ seq: 0, trades: [] });
    let seq = 0;
    let ns = Date.parse('2026-10-02T14:42:00-04:00') * 1e6;
    const frame = (k: number) =>
      Array.from({ length: 40 }, (_, j) => {
        seq++;
        ns += 400_000;
        const n = k * 40 + j;
        return [ns, grid.toPrice(MID + (n % 7) - 3), 1 + ((n * 7) % 31), n % 3 ? 1 : -1];
      });
    const viewport = document.createElement('div');
    const content = document.createElement('div');
    viewport.appendChild(content);
    document.body.appendChild(viewport);
    Object.defineProperty(viewport, 'clientHeight', { value: 40 * 20 });
    const view = new TapeView(viewport, content);
    const list = new TapeList();
    list.setFilter({ minSize: 10, side: 'all' });
    const pacer = new TapePacer();
    const perSecond = rowsPerSecond(speed);
    list.setPaced(perSecond !== null);
    const src = printsOf(tape);
    const clock = new TapeClock();
    const paint = { highlight: 25, focus: null, marked: null, millis: true, aggregate: false, decimals: 2 };
    const samples: number[] = [];
    for (let k = 0; k < 400; k++) {
      tape.apply({ seq: seq + 40, trades: frame(k) });
      const t0 = threadMs();
      list.sync(src);
      if (perSecond !== null) pacer.step(list, k * 16.7, perSecond);
      view.render(list, 20, clock, paint);
      samples.push(threadMs() - t0);
    }
    viewport.remove();
    return { s: stats(samples.slice(40)), waiting: list.waiting };
  };

  it('filters, paces and writes each frame within budget, never more than 2 s behind', () => {
    for (const speed of ['live', 'fast'] as const) {
      const { s, waiting } = run(speed);
      console.info(
        `[perf] tapeHeavy ${speed} median ${s.median.toFixed(3)} ms, p95 ${s.p95.toFixed(3)} ms (limit ${String(LIMIT)})`,
      );
      expect(REPORT ? s.p95 : s.median).toBeLessThan(LIMIT);
      expect(waiting).toBeLessThanOrEqual(40 * (MOST_BEHIND_MS / 16.7 + 1));
    }
  });
});
