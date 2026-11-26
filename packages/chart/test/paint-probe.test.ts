import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowState, type Layer, type LayerHost, type PaintFrame, type RenderContext } from '../src/index.ts';
import { equityBars, headless } from './fixtures.ts';

class Marks implements Layer {
  readonly id = 'marks';
  readonly kind = 'study' as const;
  readonly surface = 'main' as const;
  readonly state = new FlowState();
  private prices: number[] = [];
  private host: LayerHost | null = null;

  attach(host: LayerHost): void {
    this.host = host;
  }

  set(prices: number[]): void {
    this.prices = prices;
    this.host?.invalidate('data');
  }

  draw(rc: RenderContext): void {
    rc.ctx.fillStyle = '#fff';
    for (const p of this.prices) rc.ctx.fillRect(rc.pane.x + 10, rc.price.yOf(p), 4, 4);
  }
}

let frames: PaintFrame[] = [];

beforeEach(() => {
  frames = [];
  globalThis.__TESSERA_PAINT_HOOK__ = (f) => frames.push(f);
});

afterEach(() => {
  globalThis.__TESSERA_PAINT_HOOK__ = undefined;
});

const marksIn = (f: PaintFrame) => f.layers.find((l) => l.id === 'marks');

describe('the paint probe', () => {
  it('reports each painted frame: the bars held and what each layer drew', () => {
    const chart = headless();
    const marks = new Marks();
    chart.addLayer(marks);
    chart.render(true);
    expect(frames.at(-1)!.bars.count).toBe(0);
    expect(marksIn(frames.at(-1)!)!.ops).toBe(0);
    const bars = equityBars(2);
    chart.setData('main', bars);
    marks.set([bars[5]!.c, bars[6]!.c]);
    chart.render(true);
    const f = frames.at(-1)!;
    expect(f.bars).toEqual({ count: bars.length, first: bars[0]!.t, last: bars.at(-1)!.t });
    expect(marksIn(f)!.ops).toBe(2);
    expect(f.layers.find((l) => l.id === 'candles')!.ops).toBeGreaterThan(0);
    chart.destroy();
  });

  it('keeps a layer’s print while its picture stays, and counts each data change it is given', () => {
    const chart = headless();
    const marks = new Marks();
    chart.addLayer(marks);
    const bars = equityBars(2);
    chart.setData('main', bars);
    marks.set([bars[5]!.c]);
    chart.render(true);
    const first = marksIn(frames.at(-1)!)!;
    chart.render(true);
    expect(marksIn(frames.at(-1)!)!.print).toBe(first.print);
    marks.set([bars[5]!.c, bars[9]!.c]);
    chart.render(true);
    const after = marksIn(frames.at(-1)!)!;
    expect(after.print).not.toBe(first.print);
    expect(after.data).toBe(first.data + 1);
    chart.destroy();
  });

  it('says whether an order-flow layer is still loading', () => {
    const chart = headless();
    const marks = new Marks();
    chart.addLayer(marks);
    marks.state.read(true);
    marks.state.notice = { text: 'Loading · 0 of 2 sessions', short: 'Loading 0/2', least: 'Loading…' };
    chart.render(true);
    expect(marksIn(frames.at(-1)!)).toMatchObject({ reading: true, notice: 'Loading · 0 of 2 sessions' });
    chart.destroy();
  });

  it('reports nothing for a chart made before a page set the hook', () => {
    globalThis.__TESSERA_PAINT_HOOK__ = undefined;
    const chart = headless();
    globalThis.__TESSERA_PAINT_HOOK__ = (f) => frames.push(f);
    chart.render(true);
    expect(frames).toEqual([]);
    chart.destroy();
  });
});
