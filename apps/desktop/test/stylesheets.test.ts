import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORDER_TAG_H } from '@tessera/chart';
import { afterEach, describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(import.meta.dirname, '..', path), 'utf8');
const tokensCss = read('../../packages/ui/src/styles/tokens.css');
const shellCss = read('src/styles/shell.css');
const MAC_WINDOW_BUTTONS_W = 54;

function load(css: string) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
}

function place(className: string, attrs: Record<string, string> = {}) {
  const el = document.createElement('div');
  el.className = className;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('the stylesheets agree with the code and the config they size for', () => {
  it('draws an order tag as tall as the chart packs the tags', () => {
    load(tokensCss);
    load(read('src/styles/stage.css'));
    expect(getComputedStyle(place('ct-tag')).height).toBe(`${String(ORDER_TAG_H)}px`);
  });

  it('opens the layer strip over the drawing rail where a wrapped strip reaches it', () => {
    load(read('src/styles/stage.css'));
    load(read('src/styles/drawings.css'));
    const canvas = place('chart-canvas');
    const rail = document.createElement('div');
    rail.className = 'dt-rail';
    const strip = document.createElement('div');
    strip.className = 'layer-strip';
    canvas.append(rail, strip);
    expect(Number(getComputedStyle(strip).zIndex)).toBeGreaterThan(Number(getComputedStyle(rail).zIndex));
  });

  it('keeps the boot screen hidden until shell.css, which shows it, has loaded', () => {
    const page = new DOMParser().parseFromString(read('index.html'), 'text/html');
    load(page.querySelector('head > style')?.textContent ?? '');
    const boot = place('t-splash t-sh-splash', { id: 'boot' });
    expect(getComputedStyle(boot).display).toBe('none');
    load(shellCss);
    expect(getComputedStyle(boot).display).toBe('grid');
  });

  it('on a Mac, widens the rail so the traffic lights keep their inset on both sides', () => {
    const mac = JSON.parse(read('src-tauri/tauri.macos.conf.json')) as {
      app: { windows: { trafficLightPosition: { x: number } }[] };
    };
    const x = mac.app.windows[0]!.trafficLightPosition.x;
    load(shellCss);
    const shell = place('t-app t-shell', { 'data-chrome': 'mac' });
    expect(getComputedStyle(shell).getPropertyValue('--area-rail-w').trim()).toBe(
      `${String(2 * x + MAC_WINDOW_BUTTONS_W)}px`,
    );
  });
});
