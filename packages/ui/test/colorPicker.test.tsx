import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ColorPicker,
  TooltipProvider,
  hexFromCss,
  hexFromHsva,
  hsvaFromHex,
  isHexColor,
  normalizeHex,
  type ColorChange,
  type ColorSwatch,
} from '../src/index.ts';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const BOX = { left: 100, top: 50, width: 200, height: 100 };

function sized(el: HTMLElement): HTMLElement {
  el.getBoundingClientRect = () =>
    ({ ...BOX, x: BOX.left, y: BOX.top, right: BOX.left + BOX.width, bottom: BOX.top + BOX.height }) as DOMRect;
  return el;
}

function drag(el: HTMLElement, points: readonly [number, number][]) {
  const at = ([fx, fy]: [number, number]) => ({
    clientX: BOX.left + fx * BOX.width,
    clientY: BOX.top + fy * BOX.height,
    button: 0,
    pointerId: 1,
  });
  fireEvent.pointerDown(el, at(points[0]!));
  for (const p of points.slice(1)) fireEvent.pointerMove(el, at(p));
  fireEvent.pointerUp(el, at(points[points.length - 1]!));
}

function Picker({
  start = '#05070c',
  opacity,
  swatches,
  onReset,
  error,
  spy,
}: {
  start?: string;
  opacity?: number;
  swatches?: readonly ColorSwatch[];
  onReset?: () => void;
  error?: string;
  spy?: (color: string, change: ColorChange) => void;
}) {
  const [value, setValue] = useState<string | null>(start);
  const [alpha, setAlpha] = useState(opacity);
  return (
    <TooltipProvider>
      <ColorPicker
        label="Background"
        value={value}
        alpha
        {...(alpha !== undefined ? { opacity: alpha } : {})}
        {...(swatches ? { swatches } : {})}
        onChange={(c, change) => {
          spy?.(c, change);
          setValue(c);
          if (alpha !== undefined) setAlpha(change.opacity);
        }}
        error={error ?? null}
        {...(onReset ? { onReset, resetLabel: "Back to Tessera's" } : {})}
      />
      <output aria-label="value">{value}</output>
      <output aria-label="opacity">{alpha}</output>
    </TooltipProvider>
  );
}

const open = () => fireEvent.click(screen.getByRole('button', { name: /^Background:/ }));
const shown = () => screen.getByRole('status', { name: 'value' }).textContent;
const slider = (name: string) => sized(screen.getByRole('slider', { name }));

describe('colour maths', () => {
  it('reads hex colours in every form the runtime takes and keeps them long and lowercase', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('abc')).toBe('#aabbcc');
    expect(normalizeHex('#11223344')).toBe('#11223344');
    expect(normalizeHex('#112233ff')).toBe('#112233');
    expect(normalizeHex('#1234')).toBe('#11223344');
    expect(normalizeHex('red')).toBeNull();
    expect(isHexColor('#12345')).toBe(false);
  });

  it('turns any hex into hue, saturation, brightness and opacity and back without drift', () => {
    expect(hsvaFromHex('#ff0000')).toEqual({ h: 0, s: 1, v: 1, a: 1 });
    expect(hsvaFromHex('#00ff0080')).toMatchObject({ h: 120, s: 1, v: 1 });
    expect(hsvaFromHex('#808080', 200)).toMatchObject({ h: 200, s: 0 });
    for (const hex of ['#05070c', '#64b4f5', '#e68c41', '#d2b06c80', '#000000', '#ffffff', '#123456'])
      expect(hexFromHsva(hsvaFromHex(hex)!)).toBe(hex);
  });

  it('reads the rgba a theme palette may hand over', () => {
    expect(hexFromCss('rgba(100, 180, 245, 0.5)')).toBe('#64b4f580');
    expect(hexFromCss('rgb(5,7,12)')).toBe('#05070c');
    expect(hexFromCss('var(--up)')).toBeNull();
  });
});

describe('ColorPicker', () => {
  it('picks a colour by dragging the field, live, as one gesture, and remembers it once let go', () => {
    const spy = vi.fn();
    render(<Picker start="#ff0000" spy={spy} />);
    open();
    drag(slider('Saturation and brightness'), [
      [1, 0],
      [0.5, 0.5],
      [0.5, 0.75],
    ]);
    expect(spy.mock.calls.map(([c]) => c as string)).toEqual(['#ff0000', '#804040', '#402020']);
    expect(new Set(spy.mock.calls.map(([, c]) => (c as ColorChange).gesture)).size).toBe(1);
    expect(shown()).toBe('#402020');
    const recent = screen.getByRole('radiogroup', { name: 'Recent colours' });
    const remembered = [...recent.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('aria-label'));
    expect(remembered[0]).toBe('#402020');
    expect(remembered).not.toContain('#804040');
    expect(screen.getByRole('button', { name: /^Background:/ }).getAttribute('aria-label')).toBe('Background: #402020');
  });

  it('keeps the hue while the field is dragged to grey, and drags the hue strip on its own', () => {
    render(<Picker start="#3366cc" />);
    open();
    const field = slider('Saturation and brightness');
    drag(field, [[0, 0.5]]);
    expect(shown()).toBe('#808080');
    expect(screen.getByRole('slider', { name: 'Hue' }).getAttribute('aria-valuenow')).toBe('220');
    drag(field, [[1, 0]]);
    expect(shown()).toBe('#0055ff');
    drag(slider('Hue'), [[0.5, 0.5]]);
    expect(shown()).toBe('#00ffff');
  });

  it('slides the opacity into the hex, or beside a swatch the caller keeps by name', () => {
    render(<Picker start="#abcdef" />);
    open();
    drag(slider('Opacity'), [[0.5, 0.5]]);
    expect(shown()).toBe('#abcdef80');
    cleanup();

    const swatches = [{ color: '#64b4f5', name: 'Up', value: 'up' }];
    render(<Picker start="up" opacity={1} swatches={swatches} />);
    open();
    drag(slider('Opacity'), [
      [0.2, 0.5],
      [0.25, 0.5],
    ]);
    expect(shown()).toBe('up');
    expect(screen.getByRole('status', { name: 'opacity' }).textContent).toBe('0.25');
    fireEvent.click(screen.getByRole('radio', { name: 'Up' }));
    expect(shown()).toBe('up');
    expect(screen.getByRole('status', { name: 'opacity' }).textContent).toBe('0.25');
    expect(screen.getByRole('radio', { name: 'Up' }).getAttribute('aria-checked')).toBe('true');
  });

  it('nudges with the arrow keys as one gesture per press and hold', () => {
    const spy = vi.fn();
    render(<Picker start="#ff0000" spy={spy} />);
    open();
    const hue = screen.getByRole('slider', { name: 'Hue' });
    fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true, repeat: true });
    fireEvent.keyUp(hue, { key: 'ArrowRight' });
    fireEvent.keyDown(hue, { key: 'End' });
    fireEvent.keyUp(hue, { key: 'End' });
    expect(spy.mock.calls.map(([c]) => c as string)).toEqual(['#ff2a00', '#ff5500', '#ff0000']);
    const g = spy.mock.calls.map(([, c]) => (c as ColorChange).gesture);
    expect(g[0]).toBe(g[1]);
    expect(g[2]).not.toBe(g[1]);
  });

  it('still takes a swatch or a typed hex, and a swatch keeps the opacity', () => {
    render(<Picker />);
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Raise' }));
    expect(shown()).toBe('#0d1319');
    const hex = screen.getByRole('textbox', { name: 'Background, hex' });
    fireEvent.change(hex, { target: { value: '#ABCDEF' } });
    expect(shown()).toBe('#0d1319');
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(shown()).toBe('#abcdef');
    drag(slider('Opacity'), [[0.5, 0.5]]);
    fireEvent.click(screen.getByRole('radio', { name: 'Up' }));
    expect(shown()).toBe('#2fd3b480');
    const recent = screen.getByRole('radiogroup', { name: 'Recent colours' });
    expect([...recent.querySelectorAll('[role="radio"]')].slice(0, 4).map((r) => r.getAttribute('aria-label'))).toEqual(
      ['#2fd3b480', '#abcdef80', '#abcdef', '#0d1319'],
    );
  });

  it('refuses what it cannot read, says a refusal, and offers the way back for a changed colour', () => {
    const reset = vi.fn();
    render(<Picker onReset={reset} error="Too close to the background to read" />);
    open();
    const hex = screen.getByRole('textbox', { name: 'Background, hex' });
    fireEvent.change(hex, { target: { value: 'not a colour' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(shown()).toBe('#05070c');
    expect(screen.getByRole('alert').textContent).toContain('Too close');
    act(() => fireEvent.click(screen.getByRole('button', { name: "Back to Tessera's" })));
    expect(reset).toHaveBeenCalledOnce();
  });
});
