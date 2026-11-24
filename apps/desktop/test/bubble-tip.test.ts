import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fillBubbleTip } from '../src/chart/bubbleTip.ts';
import { appCss } from './support/appCss.ts';

const css = (path: string) => readFileSync(join(import.meta.dirname, path), 'utf8');

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('the big-trade card', () => {
  it('is a solid surface, so nothing drawn under it shows through', async () => {
    const style = document.createElement('style');
    style.textContent = [await appCss(), css('../src/styles/indicators.css')].join('\n');
    document.head.append(style);
    const tip = document.createElement('div');
    tip.className = 't-tip chart-bubble-tip';
    tip.dataset.open = 'true';
    document.body.append(tip);
    fillBubbleTip(tip, [{ side: 1, sideWords: 'Buy · lifted the offer', rows: [['Size', '109 contracts']] }]);
    const s = getComputedStyle(tip);
    const raise = getComputedStyle(document.documentElement).getPropertyValue('--color-raise').trim();
    expect(raise).toMatch(/^#[0-9a-f]{6}$/i);
    expect(s.backgroundColor.toLowerCase(), 'the opaque raised surface').toBe(raise.toLowerCase());
    expect(s.opacity).toBe('1');
  });
});
