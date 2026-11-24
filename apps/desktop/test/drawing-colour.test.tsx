import type { ChartState, Layout } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patch, read, useStore } from '../src/app/store.ts';
import { addDrawing, canUndoDrawings, undoDrawings } from '../src/chart/drawings/actions.ts';
import { DrawingStyleBar } from '../src/chart/drawings/DrawingStyleBar.tsx';
import { drawingStore } from '../src/chart/drawings/store.ts';
import { layoutsStore } from '../src/state/layouts.ts';

const ref = { layoutId: 'L', tileId: 'chart-1' };
const chart: ChartState = {
  tileId: 'chart-1',
  title: 'Chart 1',
  instrument: 'NQ',
  timeframe: '5m',
  layers: [],
  annotations: [],
  viewport: null,
  linkGroup: null,
};
const drawings = () => read(layoutsStore).layouts.L?.charts['chart-1']?.drawings ?? [];

function Bar({ id }: { id: string }) {
  const d = useStore(layoutsStore, (s) => s.layouts.L?.charts['chart-1']?.drawings?.find((x) => x.id === id));
  return d ? <DrawingStyleBar chart={ref} drawing={d} /> : null;
}

const BOX = { left: 0, top: 0, width: 200, height: 100 };
const point = (fx: number, fy: number) => ({
  clientX: BOX.left + fx * BOX.width,
  clientY: BOX.top + fy * BOX.height,
  button: 0,
  pointerId: 1,
});

beforeEach(() => {
  const layout: Layout = {
    id: 'L',
    name: 'L',
    revision: 1,
    updatedAt: 0,
    activeChartId: 'chart-1',
    dock: null,
    charts: { 'chart-1': chart },
    trade: null,
  };
  patch(layoutsStore, { layouts: { L: layout } });
  patch(drawingStore, { styleByKind: {}, selected: null, tool: null });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("a drawing's colour", () => {
  it('follows the picker live while it is dragged, and the whole drag is one undo step', () => {
    const id = addDrawing(ref, 'horizontal_line', [{ t: Date.UTC(2026, 9, 2, 14), price: 20_641.25 }], 'NQ');
    render(
      <TooltipProvider>
        <Bar id={id} />
      </TooltipProvider>,
    );
    expect(drawings()[0]!.style.color).toBe('mist');
    fireEvent.click(screen.getByRole('button', { name: /^Colour: Mist/ }));
    const field = screen.getByRole('slider', { name: 'Saturation and brightness' });
    field.getBoundingClientRect = () => ({ ...BOX, x: 0, y: 0, right: 200, bottom: 100 }) as DOMRect;
    fireEvent.click(screen.getByRole('radio', { name: 'Up' }));
    expect(drawings()[0]!.style.color).toBe('up');
    fireEvent.pointerDown(field, point(1, 0));
    const seen = [drawings()[0]!.style.color];
    fireEvent.pointerMove(field, point(0.5, 0.2));
    seen.push(drawings()[0]!.style.color);
    fireEvent.pointerMove(field, point(0.9, 0.1));
    seen.push(drawings()[0]!.style.color);
    fireEvent.pointerUp(field, point(0.9, 0.1));
    expect(new Set(seen).size).toBe(3);
    expect(seen.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(screen.getByRole('button', { name: /^Colour: / }).getAttribute('aria-label')).toBe(`Colour: ${seen[2]!}`);
    expect(read(drawingStore).styleByKind.horizontal_line?.color).toBe(seen[2]);

    expect(undoDrawings(ref)).toBe(true);
    expect(drawings()[0]!.style.color).toBe('up');
    expect(undoDrawings(ref)).toBe(true);
    expect(drawings()[0]!.style.color).toBe('mist');
    undoDrawings(ref);
    expect(canUndoDrawings(ref)).toBe(false);
  });

  it('takes an opacity as #rrggbbaa, which the runtime accepts for a drawing', () => {
    const id = addDrawing(ref, 'horizontal_line', [{ t: Date.UTC(2026, 9, 2, 14), price: 20_641.25 }], 'NQ');
    render(
      <TooltipProvider>
        <Bar id={id} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Colour: Mist/ }));
    const opacity = screen.getByRole('slider', { name: 'Opacity' });
    opacity.getBoundingClientRect = () => ({ ...BOX, x: 0, y: 0, right: 200, bottom: 100 }) as DOMRect;
    fireEvent.pointerDown(opacity, point(0.5, 0.5));
    fireEvent.pointerUp(opacity, point(0.5, 0.5));
    expect(drawings()[0]!.style.color).toMatch(/^#[0-9a-f]{6}80$/);
    expect(screen.getByRole('button', { name: /^Colour: / }).getAttribute('aria-label')).toMatch(/, 50%$/);
  });
});
