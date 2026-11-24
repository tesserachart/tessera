import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installInputModality, installResizeQuiet, useKeyboardToggle, usePresence } from '../src/motion.ts';

describe('usePresence: a surface leaves as calmly as it came', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is open while present, closed while its exit plays, then gone', () => {
    const { result, rerender } = renderHook(({ on }) => usePresence(on, 150), { initialProps: { on: false } });
    expect(result.current).toBeNull();
    rerender({ on: true });
    expect(result.current).toBe('open');
    rerender({ on: false });
    expect(result.current).toBe('closed');
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(result.current).toBe('closed');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeNull();
  });

  it('takes the surface back at once when it reopens mid-exit', () => {
    const { result, rerender } = renderHook(({ on }) => usePresence(on, 150), { initialProps: { on: true } });
    rerender({ on: false });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ on: true });
    expect(result.current).toBe('open');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe('open');
  });
});

describe('a surface toggled from the keyboard skips its motion', () => {
  const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const point = () => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));

  it('leaves in the same render with an exit of 0', () => {
    const { result, rerender } = renderHook(({ on, ms }) => usePresence(on, ms), {
      initialProps: { on: true, ms: 0 },
    });
    expect(result.current).toBe('open');
    rerender({ on: false, ms: 0 });
    expect(result.current).toBeNull();
  });

  it('knows whether the latest toggle came from a key or a pointer; a bare modifier is not one', () => {
    const uninstall = installInputModality(window);
    try {
      const { result, rerender } = renderHook(({ on }) => useKeyboardToggle(on), { initialProps: { on: false } });
      expect(result.current).toBe(false);
      key('Control');
      key('0');
      rerender({ on: true });
      expect(result.current).toBe(true);
      point();
      rerender({ on: true });
      expect(result.current).toBe(true);
      rerender({ on: false });
      expect(result.current).toBe(false);
      key('Escape');
      point();
      key('Shift');
      rerender({ on: true });
      expect(result.current).toBe(false);
    } finally {
      uninstall();
    }
  });
});

describe('installResizeQuiet: nothing transitions during a resize drag', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const press = (el: Element, type: string) =>
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1 }));

  it('marks <html> from a splitter or a dock sash press until the pointer lets go', () => {
    const uninstall = installResizeQuiet(document);
    document.body.innerHTML = '<div class="ui-splitter"></div><div class="dv-sash"></div><button>b</button>';
    const [splitter, sash, button] = [...document.body.children];
    const resizing = () => 'resizing' in document.documentElement.dataset;

    press(button!, 'pointerdown');
    expect(resizing()).toBe(false);
    press(splitter!, 'pointerdown');
    expect(resizing()).toBe(true);
    press(splitter!, 'pointerup');
    expect(resizing()).toBe(false);
    press(sash!, 'pointerdown');
    expect(resizing()).toBe(true);
    press(document.body, 'pointercancel');
    expect(resizing()).toBe(false);

    press(sash!, 'pointerdown');
    uninstall();
    expect(resizing()).toBe(false);
    press(sash!, 'pointerdown');
    expect(resizing()).toBe(false);
  });
});
