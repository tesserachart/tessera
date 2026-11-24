import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';
import { tileWindowSearch } from '@tessera/bridge';
import { MOTION } from '@tessera/ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { introElapsed, useDropBoot } from '../src/shell/boot.ts';
import { SPLASH_SPLIT_MS, SplashExit } from '../src/shell/Splash.tsx';
import viteConfig from '../vite.config.ts';

function paintBootScreen(search = ''): void {
  const plugin = viteConfig.plugins
    ?.flat()
    .find((p): p is Plugin => typeof p === 'object' && p !== null && 'name' in p && p.name === 'tessera-boot-splash');
  const transform = plugin?.transformIndexHtml as (html: string) => string;
  const page = transform(readFileSync(join(import.meta.dirname, '../index.html'), 'utf8'));
  const parsed = new DOMParser().parseFromString(page, 'text/html');
  history.replaceState(null, '', `/${search}`);
  const html = document.documentElement;
  for (const a of [...html.attributes]) html.removeAttribute(a.name);
  for (const a of [...parsed.documentElement.attributes]) html.setAttribute(a.name, a.value);
  for (const script of parsed.querySelectorAll('script')) {
    if (!script.hasAttribute('src')) runInThisContext(script.textContent);
    script.remove();
  }
  document.body.innerHTML = parsed.body.innerHTML;
}

const paintedStill = () => document.documentElement.dataset.intro === 'played';

function App() {
  useDropBoot();
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

describe('the boot screen index.html paints before the app loads', () => {
  it('times the intro from the seam loop it carries', () => {
    paintBootScreen();
    vi.spyOn(Element.prototype, 'getAnimations').mockReturnValue([{ currentTime: 900 } as Animation]);
    expect(introElapsed()).toBeGreaterThanOrEqual(900);
  });

  it('is dropped once the app renders', () => {
    paintBootScreen();
    expect(document.getElementById('boot')).not.toBeNull();
    render(<App />);
    expect(document.getElementById('boot')).toBeNull();
  });

  it('splits at ready for as long as the tokens’ --dur-split', () => {
    const tokens = readFileSync(join(import.meta.dirname, '../../../packages/ui/src/styles/tokens.css'), 'utf8');
    expect(SPLASH_SPLIT_MS).toBe(Number(/--dur-split:\s*(\d+)ms/.exec(tokens)?.[1]));
  });
});

describe('the intro plays once an app session', () => {
  it('on the launch, while a reload of that session and a pop-out window paint the boot frame still', () => {
    paintBootScreen();
    expect(paintedStill()).toBe(false);
    paintBootScreen();
    expect(paintedStill()).toBe(true);
    sessionStorage.clear();
    paintBootScreen(tileWindowSearch({ kind: 'chart', id: 'chart-2', title: 'NQ 5m' }));
    expect(paintedStill()).toBe(true);
  });

  it('a launch waits out the intro before the doors part', () => {
    vi.useFakeTimers();
    paintBootScreen();
    render(<SplashExit you="1234" analyst="Codex" />);
    expect(screen.getByText('Codex')).toBeTruthy();
    act(() => vi.advanceTimersByTime(MOTION.fadeMs + 40));
    expect(document.querySelector('.t-sh-splash')).not.toBeNull();
  });

  it('a reload goes to the desk as soon as it is connected, without replaying the arrival', () => {
    vi.useFakeTimers();
    paintBootScreen();
    paintBootScreen();
    render(<SplashExit you="1234" analyst="Codex" />);
    expect(screen.queryByText('Codex')).toBeNull();
    act(() => vi.advanceTimersByTime(MOTION.fadeMs + 40));
    expect(document.querySelector('.t-sh-splash, .t-split')).toBeNull();
  });
});
