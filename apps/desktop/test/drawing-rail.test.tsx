import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChartApi, ChartOptions } from '@tessera/chart';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingToolbar } from '../src/chart/drawings/DrawingToolbar.tsx';
import { setCollapsed } from '../src/chart/drawings/store.ts';

const CANVAS_LEFT = 300;

function layOut(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const at = (left: number, width: number) => new DOMRect(left, 0, width, 600);
    if (this.classList.contains('chart-canvas')) return at(CANVAS_LEFT, 900);
    if (this.classList.contains('dt-rail')) return at(CANVAS_LEFT + 6, 36);
    if (this.classList.contains('dt-reveal')) return at(CANVAS_LEFT, 14);
    return at(0, 0);
  });
}

function chartApi() {
  const options: Partial<ChartOptions>[] = [];
  const api = {
    setOptions: (o: Partial<ChartOptions>) => options.push(o),
    coords: () => ({ plot: { x: 0, y: 0, w: 900, h: 600 } }),
  } as unknown as ChartApi;
  const clearLeft = () => options.filter((o) => o.clearLeft !== undefined).at(-1)?.clearLeft;
  return { api, clearLeft };
}

function Rail({ api }: { api: ChartApi }) {
  return (
    <div className="chart-canvas">
      <DrawingToolbar chart={{ layoutId: 'l', tileId: 't' }} api={api} instrument="NQZ6.CME" count={0} />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => setCollapsed(false));
});

describe('the drawing rail keeps its chart’s bars out from under it', () => {
  it('clears the band under the rail, then under the tab once hidden, and none once the rail is gone', () => {
    layOut();
    const { api, clearLeft } = chartApi();
    const view = render(<Rail api={api} />);
    expect(clearLeft()).toBe(6 + 36 + 6);
    fireEvent.click(screen.getByRole('button', { name: 'Hide drawing tools' }));
    expect(screen.getByRole('button', { name: 'Show drawing tools' })).toBeTruthy();
    expect(clearLeft()).toBe(14 + 6);
    view.unmount();
    expect(clearLeft()).toBe(0);
  });
});
