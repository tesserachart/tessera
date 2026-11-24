import type { ChartState, Layout, Timeframe } from '@tessera/protocol';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDrawing,
  moveDrawing,
  ownDrawingCount,
  removeAllDrawings,
  restyleDrawing,
  undoDrawings,
} from '../src/chart/drawings/actions.ts';
import { homeOf, sharedLabels, shownDrawings, sourceChoices, useShownDrawings } from '../src/chart/drawings/sources.ts';
import { drawingStore } from '../src/chart/drawings/store.ts';
import { defaultChartState, layoutsStore, patchChart } from '../src/state/layouts.ts';
import { placeWords } from '../src/workspace/chartPlace.ts';
import { patch, read } from '../src/app/store.ts';

const T0 = Date.UTC(2026, 9, 2, 14, 0);
const at = (min: number, price: number) => ({ t: T0 + min * 60_000, price });
const NQ = 'NQZ6.CME';

function chart(tileId: string, instrument: string, timeframe: Timeframe, from?: string[]): ChartState {
  return { ...defaultChartState(tileId, tileId, instrument, timeframe), ...(from ? { drawingsFrom: from } : {}) };
}

const ref = (tileId: string) => ({ layoutId: 'L', tileId });
const charts = () => read(layoutsStore).layouts.L!.charts;
const shown = (tileId: string) => shownDrawings(charts(), tileId).map((d) => d.points[0]!.price);

function desk(): Layout {
  return {
    id: 'L',
    name: 'Day',
    revision: 1,
    updatedAt: 0,
    activeChartId: 'nq-1m',
    dock: null,
    charts: {
      'nq-1m': chart('nq-1m', NQ, '1m', ['nq-5m']),
      'nq-5m': chart('nq-5m', NQ, '5m'),
      'nq-1m-b': chart('nq-1m-b', NQ, '1m'),
      'es-5m': chart('es-5m', 'ESZ6.CME', '5m'),
    },
    trade: null,
  };
}

describe('drawings a chart shows from the charts it picks', () => {
  beforeEach(() => {
    patch(layoutsStore, { layouts: { L: desk() }, views: {} });
    patch(drawingStore, { styleByKind: {}, selected: null, tool: null });
  });

  it('a chart that picks nothing shows only its own drawings, and a new chart picks nothing', () => {
    addDrawing(ref('nq-5m'), 'horizontal_line', [at(0, 20_000)], NQ);
    addDrawing(ref('nq-1m'), 'horizontal_line', [at(0, 20_100)], NQ);
    expect(shown('nq-1m-b')).toEqual([]);
    expect(shown('nq-5m')).toEqual([20_000]);
    expect(defaultChartState('chart-9', 'Chart 9', NQ, '1m').drawingsFrom).toBeUndefined();
  });

  it('pulls from the chart it picked, not from another chart of its timeframe', () => {
    addDrawing(ref('nq-5m'), 'horizontal_line', [at(0, 20_000)], NQ);
    addDrawing(ref('nq-1m-b'), 'horizontal_line', [at(0, 19_900)], NQ);
    addDrawing(ref('nq-1m'), 'horizontal_line', [at(0, 20_100)], NQ);
    expect(shown('nq-1m')).toEqual([20_100, 20_000]);
    expect(charts()['nq-1m']!.drawings).toHaveLength(1);
    expect(charts()['nq-5m']!.drawings).toHaveLength(1);
  });

  it('shows only the picked chart’s drawings on its own instrument', () => {
    addDrawing(ref('nq-5m'), 'horizontal_line', [at(0, 20_000)], NQ);
    patchChart('L', 'nq-5m', (c) => ({ ...c, instrument: 'ESZ6.CME' }));
    addDrawing(ref('nq-5m'), 'horizontal_line', [at(0, 6_000)], 'ESZ6.CME');
    expect(shown('nq-1m')).toEqual([20_000]);
  });

  it('a pulled drawing changed on the chart showing it changes where it was made, and undoes there', () => {
    const id = addDrawing(ref('nq-5m'), 'horizontal_line', [at(0, 20_000)], NQ);
    expect(homeOf(charts(), 'nq-1m', id)).toBe('nq-5m');
    expect(homeOf(charts(), 'nq-1m-b', id)).toBeNull();
    moveDrawing(ref('nq-1m'), id, [at(0, 20_050)]);
    restyleDrawing(ref('nq-1m'), id, { color: 'brass' });
    expect(charts()['nq-5m']!.drawings![0]).toMatchObject({ points: [{ price: 20_050 }], style: { color: 'brass' } });
    expect(charts()['nq-1m']!.drawings ?? []).toEqual([]);
    expect(undoDrawings(ref('nq-1m'))).toBe(true);
    expect(undoDrawings(ref('nq-1m'))).toBe(true);
    expect(charts()['nq-5m']!.drawings![0]!.points[0]!.price).toBe(20_000);
  });

  it('Remove all clears the chart’s own drawings and leaves the ones it pulls', () => {
    addDrawing(ref('nq-5m'), 'horizontal_line', [at(0, 20_000)], NQ);
    addDrawing(ref('nq-1m'), 'horizontal_line', [at(0, 20_100)], NQ);
    expect(ownDrawingCount(ref('nq-1m'), NQ)).toBe(1);
    expect(removeAllDrawings(ref('nq-1m'), NQ)).toBe(1);
    expect(shown('nq-1m')).toEqual([20_000]);
  });

  it('keeps the same list for a chart when a chart it does not pick changes', () => {
    addDrawing(ref('nq-5m'), 'horizontal_line', [at(0, 20_000)], NQ);
    const { result } = renderHook(() => useShownDrawings('L', 'nq-1m'));
    const before = result.current;
    act(() => {
      addDrawing(ref('nq-1m-b'), 'horizontal_line', [at(0, 19_900)], NQ);
    });
    expect(result.current).toBe(before);
    act(() => {
      addDrawing(ref('nq-5m'), 'horizontal_line', [at(0, 20_200)], NQ);
    });
    expect(result.current.map((d) => d.points[0]!.price)).toEqual([20_000, 20_200]);
  });
});

describe('the Drawings from picker', () => {
  beforeEach(() => {
    patch(layoutsStore, { layouts: { L: desk() }, views: {} });
  });

  it('offers the other charts of the instrument, picked ones checked, and flags labels that repeat', () => {
    const choices = sourceChoices(charts(), 'nq-1m');
    expect(choices.map((c) => [c.tileId, c.label, c.picked])).toEqual([
      ['nq-5m', 'NQ Z6 5m', true],
      ['nq-1m-b', 'NQ Z6 1m', false],
    ]);
    expect([...sharedLabels(choices, 'NQ Z6 1m')]).toEqual(['NQ Z6 1m']);
    expect([...sharedLabels(sourceChoices(charts(), 'nq-5m'), 'NQ Z6 5m')]).toEqual(['NQ Z6 1m']);
  });

  it('names where a chart sits on the desk', () => {
    const desk = { x: 0, y: 0, w: 1200, h: 800 };
    expect(placeWords({ x: 0, y: 0, w: 600, h: 800 }, desk)).toBe('Left');
    expect(placeWords({ x: 600, y: 400, w: 600, h: 400 }, desk)).toBe('Bottom right');
    expect(placeWords(desk, desk)).toBe('Centre');
  });
});
