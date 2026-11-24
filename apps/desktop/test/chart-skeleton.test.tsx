import { createCanvas } from '@napi-rs/canvas';
import { createHeadlessChart, type ChartCoords, type HeadlessChart } from '@tessera/chart';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartSkeleton } from '../src/chart/ChartSkeleton.tsx';
import { chartFrame, rememberAxisWidth } from '../src/chart/chartSkeleton.ts';

const W = 1200;
const H = 700;
const charts: HeadlessChart[] = [];

function engineChart(): HeadlessChart {
  const chart = createHeadlessChart({ width: W, height: H, createCanvas: (w, h) => createCanvas(w, h) });
  charts.push(chart);
  return chart;
}

const px = (el: Element | null | undefined, prop: 'left' | 'top' | 'width' | 'height') =>
  Number.parseFloat((el as HTMLElement | null)?.style[prop] ?? 'NaN');

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(W);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(H);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const c of charts.splice(0)) c.destroy();
});

describe('the skeleton of a chart with no bars yet', () => {
  it('draws its axes exactly where the chart engine lays them out', () => {
    const chart = engineChart();
    const coords: ChartCoords = chart.coords();
    const { container } = render(<ChartSkeleton chart={chart} instrument="NQZ6.CME" />);
    const priceAxis = container.querySelector('[data-axis="price"]');
    const timeAxis = container.querySelector('[data-axis="time"]');
    expect(px(priceAxis, 'left')).toBe(coords.priceAxis.x);
    expect(px(priceAxis, 'height')).toBe(coords.priceAxis.h);
    expect(px(timeAxis, 'top')).toBe(coords.timeAxis.y);
  });

  it('keeps every placeholder candle inside the plot and every price label inside the price axis', () => {
    const chart = engineChart();
    const { plot, priceAxis } = chart.coords();
    const { container } = render(<ChartSkeleton chart={chart} instrument="NQZ6.CME" />);
    const candles = [...container.querySelectorAll('.chart-sketch-candle')];
    expect(candles.length).toBeGreaterThan(20);
    for (const c of candles) {
      expect(px(c, 'left')).toBeGreaterThanOrEqual(plot.x);
      expect(px(c, 'left') + px(c, 'width')).toBeLessThanOrEqual(plot.x + plot.w);
    }
    const labels = [...container.querySelectorAll(':scope .chart-sketch > .chart-sketch-at')].filter(
      (l) => px(l, 'left') >= priceAxis.x,
    );
    expect(labels.length).toBeGreaterThan(3);
    for (const l of labels) expect(px(l, 'left') + px(l, 'width')).toBeLessThanOrEqual(priceAxis.x + priceAxis.w);
  });

  it('draws the price axis as wide as this symbol’s prices last needed, so the axis does not jump when they land', () => {
    rememberAxisWidth('NQZ6.CME', 74);
    const { container } = render(<ChartSkeleton chart={engineChart()} instrument="NQZ6.CME" />);
    expect(px(container.querySelector('[data-axis="price"]'), 'left')).toBe(W - 74);
  });

  it('shows the chart’s own grid and frame in its theme, with nothing else but skeleton bars', () => {
    const { container } = render(<ChartSkeleton chart={engineChart()} instrument={null} />);
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('[skullet-bar]').length).toBeGreaterThan(20);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the frame a chart skeleton measures', () => {
  it('splits off the indicator panes the chart shows beneath its price pane', () => {
    const frame = chartFrame(
      { width: 800, height: 522 },
      {
        plot: { x: 0, y: 0, w: 740, h: 400 },
        panes: [{ id: 'rsi', rect: { x: 0, y: 400, w: 740, h: 100 } }],
        priceAxis: { x: 740, y: 0, w: 60, h: 500 },
        timeAxis: { x: 0, y: 500, w: 740, h: 22 },
      },
      null,
    );
    expect(frame.main).toEqual({ x: 0, y: 0, w: 740, h: 400 });
    expect(frame.panes).toEqual([{ x: 0, y: 400, w: 740, h: 100 }]);
    expect(frame.timeAxis).toEqual({ x: 0, y: 500, w: 740, h: 22 });
  });
});
