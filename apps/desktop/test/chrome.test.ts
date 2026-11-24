import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyChrome } from '../src/app/chrome.ts';
import { setDensity, uiStore } from '../src/state/ui.ts';
import { read } from '../src/app/store.ts';
import { appCss } from './support/appCss.ts';

const html = document.documentElement;
const token = (name: string) => getComputedStyle(html).getPropertyValue(name).trim();

describe('the window’s chrome', () => {
  beforeAll(async () => {
    const style = document.createElement('style');
    style.textContent = await appCss();
    document.head.append(style);
  });
  afterEach(() => {
    setDensity('default');
    applyChrome(read(uiStore));
  });

  it('the row density setting reaches the tokens: rows and controls follow it', () => {
    const at = (d: 'compact' | 'default' | 'comfortable') => {
      setDensity(d);
      applyChrome(read(uiStore));
      return {
        control: Number.parseFloat(token('--spacing-control')),
        row: Number.parseFloat(token('--spacing-row')),
        attr: html.dataset.density ?? null,
      };
    };
    const normal = at('default');
    const compact = at('compact');
    const comfortable = at('comfortable');
    expect([normal.attr, compact.attr, comfortable.attr]).toEqual([null, 'compact', 'comfortable']);
    expect(compact.control).toBeLessThan(normal.control);
    expect(normal.control).toBeLessThan(comfortable.control);
    expect(compact.row).toBeLessThan(normal.row);
    expect(normal.row).toBeLessThan(comfortable.row);
    expect(at('default')).toEqual(normal);
  });
});
