import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BigTradeCard } from '@tessera/chart';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bubbleTipAreas,
  cardLine,
  fillBubbleTip,
  placeBubbleTip,
  tipCoversBubble,
  type TipRect,
} from '../src/chart/bubbleTip.ts';
import { appCss } from './support/appCss.ts';

const css = (path: string) => readFileSync(join(import.meta.dirname, path), 'utf8');

const sweep: BigTradeCard = {
  side: 1,
  headline: ['Buy 151 @ 28,327.50–28,350.00', '81 levels'],
  detail: ['14:38:18', '147 fills in 1 ms', '7 orders', 'High tier', 'Absorbed, back 109 ticks in 7 s'],
};

async function openTip(cards: readonly BigTradeCard[]): Promise<HTMLElement> {
  const style = document.createElement('style');
  style.textContent = [await appCss(), css('../src/styles/indicators.css')].join('\n');
  document.head.append(style);
  const tip = document.createElement('div');
  tip.className = 't-tip chart-bubble-tip';
  tip.dataset.open = 'true';
  document.body.append(tip);
  fillBubbleTip(tip, cards);
  return tip;
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('the big-trade card', () => {
  it('is a solid surface, so nothing drawn under it shows through', async () => {
    const tip = await openTip([sweep]);
    const s = getComputedStyle(tip);
    const raise = getComputedStyle(document.documentElement).getPropertyValue('--color-raise').trim();
    expect(raise).toMatch(/^#[0-9a-f]{6}$/i);
    expect(s.backgroundColor.toLowerCase(), 'the opaque raised surface').toBe(raise.toLowerCase());
    expect(s.opacity).toBe('1');
  });

  it('reads as two lines: a bold headline with the side dot, then one quiet line', async () => {
    const tip = await openTip([sweep, { side: -1, headline: ['Sell 40 @ 5,800.00'], detail: ['14:38:19', '1 fill'] }]);
    const cards = [...tip.querySelectorAll('.bt-card')];
    expect(cards).toHaveLength(2);
    for (const card of cards)
      expect([...card.children].map((c) => c.className)).toEqual(['bt-card-head', 'bt-card-detail']);
    expect(tip.querySelectorAll('dl, dt, dd')).toHaveLength(0);
    const lines = [...tip.querySelectorAll('.bt-card-headline, .bt-card-detail')].map((e) =>
      e.textContent.replaceAll(' ', ' '),
    );
    expect(lines).toEqual([
      'Buy 151 @ 28,327.50–28,350.00 · 81 levels',
      '14:38:18 · 147 fills in 1 ms · 7 orders · High tier · Absorbed, back 109 ticks in 7 s',
      'Sell 40 @ 5,800.00',
      '14:38:19 · 1 fill',
    ]);
    expect(
      [...tip.querySelectorAll<HTMLElement>('.bt-card-dot')].map((d) => d.dataset.side),
      'the bubble colour',
    ).toEqual(['buy', 'sell']);
  });

  it('sizes to its words and never cuts them off', async () => {
    const tip = await openTip([sweep]);
    const s = getComputedStyle(tip);
    expect(s.width).not.toMatch(/^\d/);
    expect(s.overflow === '' || s.overflow === 'visible').toBe(true);
    expect(s.textOverflow === '' || s.textOverflow === 'clip').toBe(true);
    expect(s.overflowWrap, 'a word too long for a tiny chart still breaks rather than spills').toBe('anywhere');
  });

  it('breaks a line only between its parts, never inside one', () => {
    const line = cardLine(['Buy 151 @ 28,327.50–28,350.00', '81 levels']);
    expect(line.split(' ')).toEqual(['Buy 151 @ 28,327.50–28,350.00 ·', '81 levels']);
  });
});

describe('where the big-trade card sits', () => {
  const GAP = 8;
  const plot: TipRect = { x: 6, y: 6, w: 1288, h: 788 };
  const panes: TipRect = { x: 6, y: 6, w: 1288, h: 1000 };
  const cardSizes = [
    { w: 420, h: 38 },
    { w: 300, h: 120 },
    { w: 160, h: 60 },
  ];
  const radii = [2, 2.5, 6, 10, 14, 25];
  const xs = [-20, 0, 6, 10, 30, 200, 650, 1100, 1270, 1290, 1300, 1314];
  const ys = [-20, 0, 6, 10, 30, 60, 400, 760, 790, 800, 814];

  const within = (area: TipRect, at: { x: number; y: number }, size: { w: number; h: number }) =>
    at.x >= area.x && at.y >= area.y && at.x + size.w <= area.x + area.w && at.y + size.h <= area.y + area.h;

  it('stays inside the price pane and off the bubble, at every edge and every zoom', () => {
    let checked = 0;
    for (const size of cardSizes)
      for (const r of radii)
        for (const x of xs)
          for (const y of ys) {
            const b = { x, y, r };
            const at = placeBubbleTip(b, size, [plot, panes], GAP);
            expect(within(plot, at, size), JSON.stringify({ b, size, at })).toBe(true);
            expect(tipCoversBubble(at, size, b), JSON.stringify({ b, size, at })).toBe(false);
            checked++;
          }
    expect(checked).toBe(cardSizes.length * radii.length * xs.length * ys.length);
  });

  it('sits up and to the right of the bubble, clear of its price, when there is room', () => {
    const b = { x: 400, y: 400, r: 10 };
    const size = { w: 420, h: 38 };
    expect(placeBubbleTip(b, size, [plot], GAP)).toEqual({ x: b.x + b.r + GAP, y: b.y - b.r - size.h });
  });

  it('flips left at the right edge and below at the top', () => {
    const size = { w: 420, h: 38 };
    expect(placeBubbleTip({ x: 1200, y: 400, r: 10 }, size, [plot], GAP)).toEqual({
      x: 1200 - 10 - GAP - size.w,
      y: 400 - 10 - size.h,
    });
    expect(placeBubbleTip({ x: 400, y: 20, r: 10 }, size, [plot], GAP)).toEqual({ x: 400 + 10 + GAP, y: 30 });
  });

  it('spills into the panes below only when the price pane is too short', () => {
    const short: TipRect = { x: 6, y: 6, w: 1288, h: 60 };
    const size = { w: 300, h: 120 };
    const b = { x: 400, y: 30, r: 25 };
    const at = placeBubbleTip(b, size, [short, panes], GAP);
    expect(within(short, at, size)).toBe(false);
    expect(within(panes, at, size)).toBe(true);
    expect(tipCoversBubble(at, size, b)).toBe(false);
  });

  it('keeps clear of the price axis and the time axis', () => {
    const areas = bubbleTipAreas(
      {
        plot: { x: 0, y: 0, w: 1300, h: 800 },
        priceAxis: { x: 1300, y: 0, w: 70, h: 1012 },
        timeAxis: { x: 0, y: 1012, w: 1300, h: 28 },
      },
      6,
    );
    expect(areas).toEqual([
      { x: 6, y: 6, w: 1288, h: 788 },
      { x: 6, y: 6, w: 1288, h: 1000 },
    ]);
  });
});
