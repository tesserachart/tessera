import { describe, expect, it, vi } from 'vitest';
import { IndicatorLayer, type IndicatorDef } from '../src/index.ts';
import { equityBars, headless, valuesOf } from './fixtures.ts';

const VWAP: IndicatorDef = {
  kind: 'vwap',
  short: 'VWAP',
  placement: 'overlay',
  plots: [{ key: 'vwap', label: 'VWAP', kind: 'line' }],
  fills: [],
  sessionReset: true,
  resetBy: 'period',
  format: 'price',
};

function linesDrawn(period: string | undefined): number {
  const chart = headless({ volumePane: 0 });
  const bars = equityBars(8);
  chart.setData('main', bars);
  const level = (Math.max(...bars.map((b) => b.h)) + Math.min(...bars.map((b) => b.l))) / 2;
  chart.addLayer(
    new IndicatorLayer({
      id: 'vwap',
      def: VWAP,
      inputs: period === undefined ? {} : { period },
      style: { plots: { vwap: { color: '#fff', width: 1, line: 'solid', opacity: 1, visible: true } }, fills: {} },
      label: 'VWAP',
      values: valuesOf(bars, { vwap: () => level }),
    }),
  );
  chart.setViewport({ fitAll: true });
  const ctx = chart.canvases.main.getContext('2d') as { moveTo(x: number, y: number): void };
  const moves = vi.spyOn(ctx, 'moveTo');
  chart.render(true);
  const y = chart.coords().yOfPrice(level);
  const starts = moves.mock.calls.filter(([, at]) => Math.abs(at - y) < 0.01).length;
  chart.destroy();
  return starts;
}

describe('an indicator that starts over each period', () => {
  it('breaks its line where the period its input names starts, each session by default', () => {
    const sessions = linesDrawn(undefined);
    expect(sessions).toBeGreaterThan(0);
    expect(linesDrawn('session')).toBe(sessions);
    expect(linesDrawn('week') * 4).toBe(sessions);
    expect(linesDrawn('month') * 4).toBe(sessions);
  });
});

describe('a period with one bar', () => {
  it('draws its value as a tick across the bar, so a session line still shows on daily bars', () => {
    const chart = headless({ volumePane: 0 });
    const bars = equityBars(8).filter((_, i) => i % 78 === 0);
    chart.setData('main', bars);
    const level = bars[0]!.c;
    chart.addLayer(
      new IndicatorLayer({
        id: 'vwap',
        def: VWAP,
        inputs: {},
        style: { plots: { vwap: { color: '#fff', width: 1, line: 'solid', opacity: 1, visible: true } }, fills: {} },
        label: 'VWAP',
        values: valuesOf(bars, { vwap: () => level }),
      }),
    );
    chart.setViewport({ fitAll: true });
    const ctx = chart.canvases.main.getContext('2d') as { lineTo(x: number, y: number): void };
    const lines = vi.spyOn(ctx, 'lineTo');
    chart.render(true);
    const y = chart.coords().yOfPrice(level);
    const ticks = lines.mock.calls.filter(([, at]) => Math.abs(at - y) < 0.01);
    chart.destroy();
    const ends = new Set(ticks.map(([x]) => Math.round(x)));
    expect(ends.size).toBe(bars.length);
  });
});
