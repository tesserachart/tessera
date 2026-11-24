import type { ChartState, Drawing, DrawingTemplate, Layout } from '@tessera/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { addDrawing, undoDrawings } from '../src/chart/drawings/actions.ts';
import { defaultLabel, makeDrawing } from '../src/chart/drawings/model.ts';
import { drawingStore } from '../src/chart/drawings/store.ts';
import { applyLook, setNewDrawingsLook } from '../src/chart/drawings/templateActions.ts';
import { drawingTemplatesStore } from '../src/chart/drawings/templateStore.ts';
import {
  builtInLook,
  labelInput,
  lookOfDrawing,
  lookOfNew,
  lookOfTemplate,
  lookWords,
  readDrawingTemplates,
  renameProblem,
  sameLook,
  templateNamed,
  templatesOf,
  withLook,
} from '../src/chart/drawings/templates.ts';
import { colorName } from '../src/chart/settings/model.ts';
import { layoutsStore } from '../src/state/layouts.ts';
import { applySetting, readDrawingTools } from '../src/state/settingsSync.ts';
import { patch, read } from '../src/app/store.ts';

const T0 = Date.UTC(2026, 9, 2, 14);
const at = (min: number, price: number) => ({ t: T0 + min * 60_000, price });

function level(id: string, over: Partial<Drawing> = {}): Drawing {
  return { ...makeDrawing('horizontal_line', [at(0, 20_641.25)], 'NQ', { id, now: T0 }), ...over };
}

const SESSION: DrawingTemplate = {
  id: 'session-level',
  name: 'Session level',
  kind: 'horizontal_line',
  style: { color: 'brass', width: 2, line: 'dash', extend: 'none' },
  label: { ...defaultLabel('horizontal_line'), align: 'left', showPrice: true, size: 14 },
};

describe('drawing templates: reading', () => {
  it('reads the runtime’s value leniently: a bad entry never loses the others', () => {
    const all = readDrawingTemplates({
      templates: [
        SESSION,
        { ...SESSION, id: 'session-level' },
        { ...SESSION, id: 'other', name: 'SESSION LEVEL' },
        { ...SESSION, id: 'ray', kind: 'horizontal_ray' },
        { id: 'x', name: 'Spiral', kind: 'spiral', style: {} },
        { id: '', name: 'No id', kind: 'ray', style: {} },
        {
          id: 'fib',
          name: 'Golden',
          kind: 'fib_retracement',
          style: { color: 'teal', width: 9 },
          levels: [0.618, 0.5, 0.5, 42],
          label: { showLevels: false, size: 99, align: 'nowhere', text: 'dropped' },
        },
        'junk',
      ],
    });
    expect(all.map((t) => t.id)).toEqual(['session-level', 'ray', 'fib']);
    const fib = all[2]!;
    expect(fib.style).toEqual({ color: 'teal', width: 1, line: 'solid', extend: 'none' });
    expect(fib.levels).toEqual([0.5, 0.618]);
    expect(fib.label).toMatchObject({ showLevels: false, size: 12, align: 'left', text: '' });
    expect(readDrawingTemplates(null)).toEqual([]);
    expect(templatesOf(all, 'horizontal_ray').map((t) => t.id)).toEqual(['ray']);
    expect(templateNamed(all, 'horizontal_line', 'session LEVEL')?.id).toBe('session-level');
    expect(templateNamed(all, 'trend_line', 'Session level')).toBeNull();
    expect(renameProblem(all, all[0]!, ' ')).toBe('A template needs a name');
    expect(renameProblem(all, all[1]!, 'Session level')).toBeNull();
    expect(renameProblem([...all, { ...SESSION, id: 'b', name: 'B' }], all[0]!, 'b')).toBe('b is taken');
  });

  it('reads what new drawings take from the drawing tools’ setting, label and levels included', () => {
    expect(
      readDrawingTools({
        styles: {
          horizontal_line: { color: 'brass', label: { position: 'below', showPrice: true, size: 14 } },
          fib_retracement: { levels: [1, 0], label: { showLevels: false } },
          spiral: { color: 'teal', label: { size: 14 } },
        },
      }).styleByKind,
    ).toEqual({
      horizontal_line: {
        color: 'brass',
        label: { ...defaultLabel('horizontal_line'), position: 'below', showPrice: true, size: 14 },
      },
      fib_retracement: { levels: [0, 1], label: { ...defaultLabel('fib_retracement'), showLevels: false } },
      spiral: { color: 'teal' },
    });
    applySetting('chart.drawingTemplates', { templates: [SESSION] });
    expect(read(drawingTemplatesStore).templates.map((t) => t.name)).toEqual(['Session level']);
  });
});

describe('drawing templates: looks', () => {
  it('compares looks, never words, and a label left in the line’s colour as the same', () => {
    const plain = level('a', { label: { ...defaultLabel('horizontal_line'), text: 'PDH' } });
    expect(sameLook(lookOfDrawing(plain), builtInLook('horizontal_line'))).toBe(true);
    expect(sameLook(lookOfDrawing(level('b')), builtInLook('horizontal_line'))).toBe(true);
    expect(sameLook(lookOfTemplate(SESSION), builtInLook('horizontal_line'))).toBe(false);
    const styled = withLook(plain, lookOfTemplate(SESSION));
    expect(styled.style).toEqual(SESSION.style);
    expect(styled.label).toMatchObject({ text: 'PDH', align: 'left', showPrice: true, size: 14 });
    expect(sameLook(lookOfDrawing(styled), lookOfTemplate(SESSION))).toBe(true);
    expect(lookOfTemplate({ ...SESSION, kind: 'measure' }).label).toBeNull();
    expect(lookOfTemplate({ ...SESSION, kind: 'fib_retracement' }).levels).toHaveLength(7);
  });

  it('says what a look holds where it differs from a new drawing', () => {
    expect(lookWords('horizontal_line', lookOfTemplate(SESSION), colorName)).toBe(
      'Brass, 2 px dashed · text 14 px, left, above, price',
    );
    expect(lookWords('ray', builtInLook('ray'), colorName)).toBe('Mist, 1 px');
    const fib = { ...builtInLook('fib_retracement'), levels: [0, 0.5, 1] };
    fib.label = { ...fib.label!, showPrice: false };
    expect(lookWords('fib_retracement', fib, colorName)).toBe(
      'Mist, 1 px · labels 12 px, left, above, levels, no prices · levels 0, 0.5, 1',
    );
  });

  it('keeps an extension’s and a fan’s own levels in a template, and a fan’s labels without prices', () => {
    const golden: DrawingTemplate = {
      id: 'targets',
      name: 'Targets',
      kind: 'fib_extension',
      style: { color: 'teal', width: 1, line: 'solid', extend: 'right' },
      levels: [1, 1.618],
    };
    const [read] = readDrawingTemplates({ templates: [{ ...golden, levels: [1.618, 1, 1] }] });
    expect(read!.levels).toEqual([1, 1.618]);
    expect(lookOfTemplate({ ...golden, levels: undefined }).levels).toEqual([
      0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2,
    ]);
    const ext = makeDrawing('fib_extension', [at(0, 1), at(1, 3), at(2, 2)], 'NQ');
    expect(withLook(ext, lookOfTemplate(golden)).levels).toEqual([1, 1.618]);
    const fan = { ...builtInLook('fib_fan'), levels: [0.5] };
    fan.label = { ...fan.label!, showLevels: false };
    expect(lookWords('fib_fan', fan, colorName)).toBe('Mist, 1 px · labels 12 px, no levels · levels 0.5');
    expect(readDrawingTools({ styles: { fib_fan: { levels: [0.618, 0.382] } } }).styleByKind).toEqual({
      fib_fan: { levels: [0.382, 0.618] },
    });
  });

  it('gives the save tool a label’s look in its own terms', () => {
    expect(labelInput('horizontal_line', SESSION.label!)).toEqual({
      color: '',
      size: 14,
      bold: false,
      italic: false,
      align: 'left',
      position: 'above',
      showPrice: true,
    });
    expect(labelInput('fib_retracement', defaultLabel('fib_retracement'))).toMatchObject({ showLevels: true });
  });
});

describe('drawing templates: on a chart', () => {
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

  it('applies a template as one undo step, keeping the words', () => {
    const id = addDrawing(ref, 'horizontal_line', [at(0, 1)], 'NQ');
    applyLook(ref, id, lookOfTemplate(SESSION));
    expect(drawings()[0]!.style.color).toBe('brass');
    applyLook(ref, id, builtInLook('horizontal_line'));
    expect(drawings()[0]!.style.color).toBe('mist');
    undoDrawings(ref);
    expect(drawings()[0]!.style.color).toBe('brass');
  });

  it('makes a template what new drawings of its kind take, and the built-in style again', () => {
    setNewDrawingsLook('horizontal_line', lookOfTemplate(SESSION));
    const entry = read(drawingStore).styleByKind.horizontal_line;
    expect(sameLook(lookOfNew('horizontal_line', entry), lookOfTemplate(SESSION))).toBe(true);
    const id = addDrawing(ref, 'horizontal_line', [at(0, 1)], 'NQ');
    const d = drawings().find((x) => x.id === id)!;
    expect(d.style).toEqual(SESSION.style);
    expect(d.label).toMatchObject({ text: '', align: 'left', showPrice: true, size: 14 });
    expect(read(drawingStore).styleByKind.ray).toBeUndefined();
    setNewDrawingsLook('horizontal_line', null);
    expect(read(drawingStore).styleByKind.horizontal_line).toBeUndefined();
    const plain = addDrawing(ref, 'horizontal_line', [at(0, 2)], 'NQ');
    expect(drawings().find((x) => x.id === plain)!.style.color).toBe('mist');
  });
});
