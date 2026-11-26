import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BarGraph, Donut, EquityGraph, Gauge, LinesGraph, type EquitySample } from '../src/graphs/index.ts';
import { nearest, valueScale } from '../src/graphs/scales.ts';

const WIDTH = 864;
const PLOT_W = 800;

class SizedObserver {
  constructor(private readonly fire: ResizeObserverCallback) {}
  observe() {
    this.fire([], this);
  }
  disconnect() {}
  unobserve() {}
}

const realObserver = globalThis.ResizeObserver;
const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

beforeAll(() => {
  globalThis.ResizeObserver = SizedObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH });
});

afterAll(() => {
  globalThis.ResizeObserver = realObserver;
  if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
});

afterEach(cleanup);

const trades: EquitySample[] = [
  { x: 0, equity: 0, peak: 0, drawdown: 0 },
  { x: 1, equity: 100, peak: 100, drawdown: 0 },
  { x: 2, equity: 40, peak: 100, drawdown: 60 },
  { x: 3, equity: 180, peak: 180, drawdown: 0 },
  { x: 4, equity: 150, peak: 180, drawdown: 30 },
];

function hoverAt(el: Element, x: number) {
  fireEvent.pointerMove(el, { clientX: x, clientY: 10 });
}

describe('the equity graph', () => {
  it('reads out the trade under the pointer and opens it on a click', () => {
    const onPick = vi.fn();
    const { container } = render(
      <EquityGraph
        samples={trades}
        axis={{ kind: 'trades', label: (i) => `T${String(i)}` }}
        label="Equity curve"
        empty="Nothing"
        tip={(i) => (i === 0 ? null : <b>Trade {i}</b>)}
        onPick={onPick}
      />,
    );
    const graph = container.firstElementChild!;
    hoverAt(graph, (PLOT_W / 4) * 2 + 10);
    expect(screen.getByText('Trade 2')).toBeTruthy();
    fireEvent.click(graph);
    expect(onPick).toHaveBeenCalledWith(2);

    hoverAt(graph, 0);
    expect(screen.queryByText(/^Trade /)).toBeNull();
    fireEvent.click(graph);
    expect(onPick).toHaveBeenCalledTimes(1);

    hoverAt(graph, PLOT_W + 20);
    expect(screen.queryByText(/^Trade /)).toBeNull();
  });

  it('draws dated and money axes, the drawdown pane and the later sessions shaded', () => {
    const day = Date.UTC(2026, 8, 14, 14, 30);
    const samples = trades.map((s, i) => ({ ...s, x: day + i * 2 * 86_400_000 }));
    const { container } = render(
      <EquityGraph
        samples={samples}
        axis={{ kind: 'time', zone: 'America/New_York' }}
        shade={{ from: day + 4 * 86_400_000, before: 'Development', after: 'Later' }}
        label="Equity curve, +$150.00 at the end"
        ddLabel="Drawdown, deepest −$60.00"
        empty="Nothing"
        tip={() => null}
      />,
    );
    expect(screen.getByRole('img', { name: 'Equity curve, +$150.00 at the end' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Drawdown, deepest −$60.00' })).toBeTruthy();
    const words = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(words).toContain('Development');
    expect(words).toContain('Later');
    expect(words).toContain('Sep 16');
    expect(words.some((w) => /^\+\$\d/.test(w))).toBe(true);
    expect(words).toContain('−$60');
    const shades = container.querySelectorAll('.gr-shade');
    expect(shades).toHaveLength(2);
    expect(Number(shades[0]!.getAttribute('x'))).toBeCloseTo(PLOT_W / 2, 0);
  });

  it('says why it draws nothing with fewer than two points', () => {
    render(
      <EquityGraph
        samples={trades.slice(0, 1)}
        axis={{ kind: 'trades', label: String }}
        label="Equity curve"
        empty="Its trades draw the curve."
        tip={() => null}
      />,
    );
    expect(screen.getByText('Its trades draw the curve.')).toBeTruthy();
  });
});

describe('the bar graph', () => {
  it('dims a small sample, reads out the bar under the pointer and opens it', () => {
    const onPick = vi.fn();
    const { container } = render(
      <BarGraph
        bars={[
          { key: 'a', value: 120, label: 'Mon', note: 'n 30' },
          { key: 'b', value: -40, label: 'Tue', note: 'n 3', faint: true },
        ]}
        label="Bars by bucket"
        empty="Nothing"
        tip={(i) => <b>Bar {i}</b>}
        onPick={onPick}
      />,
    );
    const groups = container.querySelectorAll('.gr-bar');
    expect([...groups].map((g) => g.classList.contains('is-faint'))).toEqual([false, true]);
    expect([...groups].map((g) => g.querySelector('rect:not(.gr-hit)')!.getAttribute('class'))).toEqual([
      'visx-bar up',
      'visx-bar down',
    ]);
    fireEvent.pointerEnter(groups[1]!);
    expect(screen.getByText('Bar 1')).toBeTruthy();
    fireEvent.click(groups[1]!);
    expect(onPick).toHaveBeenCalledWith(1);
  });
});

describe('the lines graph', () => {
  it('isolates a series from its legend and lets it go again', () => {
    const { container } = render(
      <LinesGraph
        series={[
          { key: 'nq', label: 'NQ', values: [1, 2, 3] },
          { key: 'es', label: 'ES', values: [3, 1, -2] },
        ]}
        labels={['Aug', 'Sep', 'Oct']}
        label="Lines by series"
        empty="Nothing"
      />,
    );
    const dimmed = () => [...container.querySelectorAll('.gr-series')].map((p) => p.classList.contains('is-dim'));
    expect(dimmed()).toEqual([false, false]);
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(dimmed()).toEqual([true, false]);
    expect(screen.getByRole('button', { name: 'ES' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(dimmed()).toEqual([false, false]);
  });
});

describe('rings', () => {
  it('shows the hovered share of a donut in its centre', () => {
    const { container } = render(
      <Donut
        segments={[
          { key: 'w', label: 'Winners', value: 3, tone: 'up' },
          { key: 'l', label: 'Losers', value: 1, tone: 'down' },
        ]}
        center={<b>75%</b>}
        empty="Nothing"
      />,
    );
    expect(container.querySelectorAll('.gr-seg')).toHaveLength(2);
    expect(screen.getByText('25%')).toBeTruthy();
    fireEvent.pointerEnter(screen.getByText('Losers').closest('li')!);
    expect(container.querySelector('.gr-donut-c')!.textContent).toBe('1Losers');
  });

  it('says a gauge is empty without a share', () => {
    render(<Gauge share={null} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('scales', () => {
  it('keeps zero in a value range and finds the nearest point', () => {
    expect(valueScale([10, 20], [100, 0]).domain()[0]).toBe(0);
    expect(valueScale([-130, 420], [100, 0]).domain()).toEqual([-200, 600]);
    expect(nearest([0, 10, 20], 14)).toBe(1);
    expect(nearest([0, 10, 20], 99)).toBe(2);
    expect(nearest([], 3)).toBe(-1);
  });
});
