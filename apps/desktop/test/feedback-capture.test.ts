import { describe, expect, it } from 'vitest';
import type { Box } from '../src/feedback/freeze.ts';
import { timeSlicer } from '../src/feedback/pace.ts';
import { drawnProperties, slimmer } from '../src/feedback/slim.ts';
import { planTiles } from '../src/feedback/tiles.ts';

const box = (left: number, top: number, size = 4): Box => ({
  left,
  top,
  right: left + size,
  bottom: top + size,
  inline: false,
});

describe('the window picture', () => {
  it('cuts the window into tiles that cover it exactly, each within its budget where it can be', () => {
    const boxes = [...Array.from({ length: 400 }, (_, i) => box((i % 20) * 5, Math.floor(i / 20) * 5)), box(700, 500)];
    const tiles = planTiles(boxes, 800, 600, 50);
    expect(tiles.reduce((area, t) => area + t.width * t.height, 0)).toBe(800 * 600);
    for (const [i, a] of tiles.entries()) {
      for (const b of tiles.slice(i + 1)) {
        const overlap =
          a.left < b.left + b.width &&
          b.left < a.left + a.width &&
          a.top < b.top + b.height &&
          b.top < a.top + a.height;
        expect(overlap).toBe(false);
      }
    }
    expect(tiles.length).toBeGreaterThan(4);
    expect(planTiles(boxes, 800, 600, 1_000)).toEqual([{ left: 0, top: 0, width: 800, height: 600 }]);
  });

  it('keeps only what a child would not inherit or start with', () => {
    const parent = document.createElement('div');
    parent.style.setProperty('color', 'rgb(1, 2, 3)');
    parent.style.setProperty('font-size', '13px');
    parent.style.setProperty('display', 'flex');
    const child = document.createElement('span');
    child.style.setProperty('color', 'rgb(1, 2, 3)');
    child.style.setProperty('font-size', '11px');
    child.style.setProperty('display', 'block');
    child.style.setProperty('border-top-color', 'rgb(1, 2, 3)');
    child.style.setProperty('opacity', '1');
    parent.append(child);
    const defaults = new Map([
      ['display', 'block'],
      ['opacity', '1'],
    ]);
    slimmer(() => defaults).children(parent);
    expect(child.style.getPropertyValue('color')).toBe('');
    expect(child.style.getPropertyValue('font-size')).toBe('11px');
    expect(child.style.getPropertyValue('border-top-color')).toBe('');
    expect(child.style.getPropertyValue('opacity')).toBe('');
    expect(child.style.getPropertyValue('display')).toBe('block');
  });

  it('copies no custom properties and no logical twins of physical ones', () => {
    const names = drawnProperties([
      'color',
      '--hatch',
      'margin-inline-start',
      'margin-left',
      'inline-size',
      'width',
    ] as unknown as CSSStyleDeclaration);
    expect(names).toEqual(['color', 'margin-left', 'width']);
  });

  it('gives the page a turn only once its slice of time is spent', async () => {
    let now = 0;
    const realNow = performance.now.bind(performance);
    performance.now = () => now;
    try {
      let turns = 0;
      const slice = timeSlicer(8, () => {
        turns++;
        return Promise.resolve();
      });
      now = 5;
      expect(slice()).toBeUndefined();
      now = 9;
      await slice();
      expect(turns).toBe(1);
      now = 12;
      expect(slice()).toBeUndefined();
    } finally {
      performance.now = realNow;
    }
  });
});
