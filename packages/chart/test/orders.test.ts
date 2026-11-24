import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  BracketsLayer,
  LevelsLayer,
  ORDER_STYLES,
  ORDER_TAG_H,
  ORDER_TAG_GAP,
  ORDER_TAG_LANE_GAP,
  ORDER_TAG_MIN_W,
  ORDER_TAG_MORE_W,
  layoutOrderTags,
  OrderLinesLayer,
  orderTagRows,
  type OrderLineSpec,
} from '../src/index.ts';
import { equityBars, headless } from './fixtures.ts';

type Ctx = { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function matching(chart: ReturnType<typeof headless>, y: number, x0: number, n: number, colour: string): number {
  const ctx = chart.canvases.overlay.getContext('2d') as Ctx;
  const want = hex(colour);
  let hits = 0;
  for (let k = 0; k < n; k++) {
    const [r, g, b, a] = ctx.getImageData(Math.round(x0 + k), Math.round(y), 1, 1).data;
    if (a! > 0 && Math.abs(r! - want[0]!) < 40 && Math.abs(g! - want[1]!) < 40 && Math.abs(b! - want[2]!) < 40) {
      hits++;
    }
  }
  return hits;
}

describe('OrderLinesLayer', () => {
  it('draws working orders solid in mist and drafts dashed in the agent colour (the v5 line grammar)', () => {
    const chart = headless();
    const bars = equityBars(3);
    chart.setData('main', bars);
    const layer = new OrderLinesLayer({ id: 'orders' });
    chart.addLayer(layer);
    const last = bars[bars.length - 1]!;
    const sell = last.h;
    const draft = last.l;
    const lines: OrderLineSpec[] = [
      { id: 'o', price: sell, side: 'sell', label: 'Sell limit', qty: 100, note: 'working', draft: false },
      { id: 'd', price: draft, side: 'buy', label: 'Buy limit 487.25', qty: 25, note: 'draft', draft: true },
    ];
    layer.setLines(lines);
    chart.render(true);
    const c = chart.coords();
    const x0 = c.plot.x + c.plot.w * 0.3;
    const solid = matching(chart, c.yOfPrice(sell), x0, 40, ORDER_STYLES.working.line);
    expect(solid).toBe(40);
    const dashed = matching(chart, c.yOfPrice(draft), x0, 40, chart.theme.agent);
    expect(dashed).toBeGreaterThan(10);
    expect(dashed).toBeLessThan(40);
    const rc = { price: { yOf: c.yOfPrice } };
    expect(layer.hitTest(0, c.yOfPrice(draft), rc as never)?.objectId).toBe('d');
    chart.destroy();
  });

  it('labels each line at its axis end: a tick in the line colour, the quantity, then the words', () => {
    const texts: { text: string; x: number }[] = [];
    const chart = headless({
      createCanvas: (w, h) => {
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        const fillText = ctx.fillText.bind(ctx);
        ctx.fillText = (text: string, x: number, y: number) => {
          texts.push({ text, x });
          fillText(text, x, y);
        };
        return canvas;
      },
    });
    const bars = equityBars(3);
    chart.setData('main', bars);
    const layer = new OrderLinesLayer({ id: 'orders' });
    chart.addLayer(layer);
    const price = bars[bars.length - 1]!.l;
    layer.setLines([
      { id: 'd', price, side: 'buy', qty: 2, label: 'Buy limit 487.25', note: 'draft', draft: true, role: 'entry' },
    ]);
    chart.render(true);
    const c = chart.coords();
    const qty = texts.find((t) => t.text === '2')!;
    const text = texts.find((t) => t.text === 'Buy limit 487.25 · draft')!;
    expect(text.x).toBeGreaterThan(qty.x);
    expect(text.x).toBeGreaterThan(c.plot.x + c.plot.w / 2);
    expect(matching(chart, c.yOfPrice(price), qty.x - 8, 6, chart.theme.agent)).toBeGreaterThan(0);
    chart.destroy();
  });

  it('keeps drafts in the autoscaled range, but not working orders', () => {
    const layer = new OrderLinesLayer({
      id: 'orders',
      lines: [
        { id: 'o', price: 400, side: 'sell', label: 'Sell 1 stop', draft: false },
        { id: 'd', price: 480, side: 'buy', label: 'Buy 1 at 480.00', draft: true },
        { id: 's', price: 470, side: 'sell', label: 'Stop 470.00', draft: true },
      ],
    });
    expect(layer.autoscaleRange()).toEqual([470, 480]);
    layer.setLines([{ id: 'o', price: 400, side: 'sell', label: 'Sell 1 stop', draft: false }]);
    expect(layer.autoscaleRange()).toBeNull();
  });

  it('moves level labels clear of draft labels, and drops axis prices under tags', () => {
    const texts: { text: string; y: number }[] = [];
    const chart = headless({
      width: 520,
      createCanvas: (w, h) => {
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        const fillText = ctx.fillText.bind(ctx);
        ctx.fillText = (text: string, x: number, y: number) => {
          texts.push({ text, y });
          fillText(text, x, y);
        };
        return canvas;
      },
    });
    const bars = equityBars(2, 7, 487);
    chart.setData('main', bars);
    const settled = () => {
      chart.render(true);
      texts.length = 0;
      chart.render(true);
    };
    settled();
    const last = bars[bars.length - 1]!.c;
    const tick = texts.map((t) => t.text).find((t) => /^\d+\.\d\d$/.test(t) && Math.abs(Number(t) - last) > 1)!;
    expect(texts.filter((t) => t.text === tick)).toHaveLength(1);

    const flip = Number(tick);
    chart.addLayer(new LevelsLayer({ id: 'gex', levels: [{ id: 'gf', price: flip, label: 'Gamma Flip' }] }));
    const orders = new OrderLinesLayer({ id: 'orders' });
    chart.addLayer(orders);
    orders.setLines([{ id: 's', price: flip - 0.05, side: 'sell', label: 'Stop', note: 'on fill', draft: true }]);
    settled();
    expect(texts.filter((t) => t.text === tick)).toHaveLength(1);
    const yOf = (text: string) => texts.find((t) => t.text === text)!.y;
    expect(texts.map((t) => t.text)).toContain('Stop · on fill');
    expect(Math.abs(yOf('Gamma Flip') - yOf('Stop · on fill'))).toBeGreaterThanOrEqual(18);
    chart.destroy();
  });

  it('moves a level label clear of the rows the order tags take, and lays the tags out as the overlay does', () => {
    const texts: { text: string; y: number }[] = [];
    const chart = headless({
      width: 520,
      createCanvas: (w, h) => {
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        const fillText = ctx.fillText.bind(ctx);
        ctx.fillText = (text: string, x: number, y: number) => {
          texts.push({ text, y });
          fillText(text, x, y);
        };
        return canvas;
      },
    });
    const bars = equityBars(2, 7, 487);
    chart.setData('main', bars);
    const last = bars[bars.length - 1]!;
    const flip = last.c;
    chart.addLayer(new LevelsLayer({ id: 'gex', levels: [{ id: 'gf', price: flip, label: 'Gamma Flip' }] }));
    const tags = new BracketsLayer({ id: 'brackets' });
    chart.addLayer(tags);
    chart.render(true);
    const c = chart.coords();
    const alone = texts.find((t) => t.text === 'Gamma Flip')!.y;
    tags.setScene({ lines: [], zones: [], tags: [{ id: 'tp', price: flip + 0.01, priority: 2 }] });
    texts.length = 0;
    chart.render(true);
    const [row] = orderTagRows([{ id: 'tp', price: flip + 0.01, priority: 2 }], c.yOfPrice, c.plot);
    const moved = texts.find((t) => t.text === 'Gamma Flip')!.y;
    expect(moved).not.toBe(alone);
    expect(Math.abs(moved - row!)).toBeGreaterThanOrEqual(ORDER_TAG_H / 2 + 7 - 0.5);
    const two = orderTagRows(
      [
        { id: 'a', price: flip, priority: 3 },
        { id: 'b', price: flip, priority: 2 },
        { id: 'c', price: flip, priority: 2, fanned: true },
      ],
      c.yOfPrice,
      c.plot,
    );
    expect(two[0]).toBeCloseTo(c.yOfPrice(flip));
    expect(two[1]).toBeCloseTo(c.yOfPrice(flip));
    expect(two[2]).toBeCloseTo(c.yOfPrice(flip));
    chart.destroy();
  });
});

describe('order tag layout', () => {
  const plot = { x: 20, y: 10, w: 720, h: 480 };
  const yOf = (price: number) => price;

  it('keeps nearly identical prices exact and separates their full clickable boxes horizontally', () => {
    const tags = [
      { id: 'position', price: 180, priority: 3, width: 184 },
      { id: 'entry', price: 180.75, priority: 2, width: 172 },
      { id: 'stop', price: 182, priority: 1, width: 160 },
      { id: 'target', price: 360, priority: 1, width: 180 },
    ];
    const layout = layoutOrderTags(tags, yOf, plot);
    expect(layout.map((tag) => tag.y)).toEqual(tags.map((tag) => tag.price));
    expect(layout.every((tag) => !tag.overflow && !tag.clipped)).toBe(true);
    expect(layout[0]!.right).toBe(plot.x + plot.w - 6);
    expect(layout[3]!.lane).toBe(layout[0]!.lane);
    for (let i = 0; i < layout.length; i++) {
      for (let j = i + 1; j < layout.length; j++) {
        const a = layout[i]!;
        const b = layout[j]!;
        if (Math.abs(a.y - b.y) >= ORDER_TAG_H + ORDER_TAG_GAP) continue;
        expect(
          a.right + ORDER_TAG_LANE_GAP <= b.right - b.width || b.right + ORDER_TAG_LANE_GAP <= a.right - a.width,
        ).toBe(true);
      }
    }
  });

  it('uses priority rather than input order and retains a separate expanded-leg lane', () => {
    const layout = layoutOrderTags(
      [
        { id: 'stop', price: 200, priority: 1, width: 140 },
        { id: 'position', price: 200, priority: 3, width: 190 },
        { id: 'leg', price: 400, priority: 1, width: 130, fanned: true },
      ],
      yOf,
      plot,
    );
    expect(layout[1]!.lane).toBe(0);
    expect(layout[0]!.lane).toBe(1);
    expect(layout[2]!.lane).toBe(1);
    expect(layout.map((tag) => tag.y)).toEqual([200, 200, 400]);
  });

  it('compresses labels to the available plot width without shrinking their control minimum', () => {
    const narrow = { ...plot, w: 350 };
    const layout = layoutOrderTags(
      [0, 1, 2].map((n) => ({
        id: String(n),
        price: 200 + n,
        priority: 1,
        width: 190,
      })),
      yOf,
      narrow,
    );
    expect(layout.every((tag) => tag.clipped && !tag.overflow)).toBe(true);
    for (const tag of layout) {
      expect(tag.width).toBeGreaterThanOrEqual(ORDER_TAG_MIN_W);
      expect(tag.right - tag.width).toBeGreaterThanOrEqual(narrow.x + 6 - 0.001);
      expect(tag.right).toBeLessThanOrEqual(narrow.x + narrow.w - 6);
    }
    expect(layout.map((tag) => tag.y)).toEqual([200, 201, 202]);
  });

  it('reports excess lanes for the chooser and keeps its strip clear without dropping a price', () => {
    const narrow = { ...plot, w: 300 };
    const tags = [0, 1, 2, 3, 4].map((n) => ({ id: String(n), price: 240, priority: n, width: 180 }));
    const layout = layoutOrderTags(tags, yOf, narrow);
    const visible = layout.filter((tag) => !tag.overflow);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.index).toBe(4);
    expect(layout.filter((tag) => tag.overflow).map((tag) => tag.index)).toEqual([0, 1, 2, 3]);
    expect(visible[0]!.right - visible[0]!.width).toBeGreaterThanOrEqual(
      narrow.x + 6 + ORDER_TAG_MORE_W + ORDER_TAG_LANE_GAP,
    );
    expect(layout.map((tag) => tag.y)).toEqual(tags.map((tag) => tag.price));
  });

  it('keeps a dragged tag in the lane it had before the drag, and nothing else moves as it passes', () => {
    const tags = [
      { id: 'position', price: 200, priority: 3, width: 180 },
      { id: 'stop', price: 210, priority: 1, width: 160 },
      { id: 'target', price: 160, priority: 1, width: 170 },
    ];
    const before = layoutOrderTags(tags, yOf, plot);
    expect(before[1]!.lane).toBe(1);
    expect(before[2]!.lane).toBe(0);
    for (const price of [204, 190, 172, 160]) {
      const during = layoutOrderTags(
        tags.map((tag) => (tag.id === 'stop' ? { ...tag, price, packPrice: 210 } : tag)),
        yOf,
        plot,
      );
      expect(during[1]!.y).toBe(price);
      expect(during.map((tag) => [tag.lane, tag.right, tag.width])).toEqual(
        before.map((tag) => [tag.lane, tag.right, tag.width]),
      );
    }
  });

  it('puts a preview in the first lane clear at its price without moving the real tags', () => {
    const tags = [
      { id: 'position', price: 200, priority: 3, width: 180 },
      { id: 'stop', price: 210, priority: 1, width: 160 },
    ];
    const before = layoutOrderTags(tags, yOf, plot);
    const ghost = (price: number) =>
      layoutOrderTags([...tags, { id: 'ghost', price, priority: 2, width: 150, floating: true }], yOf, plot);
    for (const price of [100, 182, 196, 214]) {
      const with_ = ghost(price);
      expect(with_.slice(0, 2)).toEqual(before);
      expect(with_[2]!.y).toBe(price);
    }
    expect(ghost(100)[2]!.lane).toBe(0);
    expect(ghost(182)[2]!.lane).toBe(1);
    expect(ghost(182)[2]!.right).toBe(before[1]!.right);
    expect(ghost(205)[2]!.lane).toBe(0);
    expect(ghost(214)[2]!.lane).toBe(0);
  });

  it('pins only offscreen prices and handles a plot too small for any order label', () => {
    const tags = [-10, 11, 490, 600].map((price) => ({ id: String(price), price, priority: 1, width: 180 }));
    const rows = orderTagRows(tags, yOf, plot);
    expect(rows[0]).toBeGreaterThan(plot.y);
    expect(rows[1]).toBe(11);
    expect(rows[2]).toBe(490);
    expect(rows[3]).toBeLessThan(plot.y + plot.h);
    const layout = layoutOrderTags(tags, yOf, { ...plot, w: 12 });
    expect(layout.every((tag) => tag.overflow && tag.width === 0)).toBe(true);
    expect(layout.every((tag) => Number.isFinite(tag.right))).toBe(true);
    expect(layoutOrderTags([], yOf, plot)).toEqual([]);
  });
});
