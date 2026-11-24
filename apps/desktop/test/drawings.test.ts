import { SeriesStore } from '@tessera/chart';
import type { ChartState, Drawing, Layout } from '@tessera/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDrawing,
  canRedoDrawings,
  canUndoDrawings,
  moveDrawing,
  redoDrawings,
  relabelDrawing,
  removeAllDrawings,
  restyleDrawing,
  undoDrawings,
  updateDrawing,
} from '../src/chart/drawings/actions.ts';
import { overlaps, styleBarAt } from '../src/chart/drawings/place.ts';
import {
  applyChanges,
  byInstrument,
  defaultStyle,
  diffDrawings,
  DrawingHistory,
  drawingsOn,
  extendChoices,
  levelChoices,
  makeDrawing,
  parseLevel,
  defaultLabel,
  labelControls,
  labelOf,
  placementWords,
  styleControls,
  toAnchors,
  toggleLevel,
  TOOL_GROUPS,
  TOOLS,
  toSpec,
} from '../src/chart/drawings/model.ts';
import { placedInputs } from '../src/chart/profilePlacement.ts';
import { isPlacedProfile, PROFILE_SHOWS, profileQuick, withProfileInputs } from '../src/chart/profileStudy.ts';
import { drawingStore, groupTool, makeDrawingStore } from '../src/chart/drawings/store.ts';
import { layoutsStore } from '../src/state/layouts.ts';
import { patch, read } from '../src/app/store.ts';

const T0 = Date.UTC(2026, 9, 2, 14);
const NS = 1_000_000;
const at = (min: number, price: number) => ({ t: T0 + min * 60_000, price });

function line(id: string, instrument = 'NQ', over: Partial<Drawing> = {}): Drawing {
  return { ...makeDrawing('trend_line', [at(0, 100), at(10, 110)], instrument, { id, now: T0 }), ...over };
}

describe('drawing tools: the catalogue', () => {
  it('puts every kind in one group, with the keys the toolbar shows', () => {
    const kinds = TOOL_GROUPS.flatMap((g) => g.kinds);
    expect(new Set(kinds).size).toBe(TOOLS.length);
    expect(kinds).toHaveLength(19);
    const keys = TOOLS.flatMap((t) => (t.shortcut ? [t.shortcut] : []));
    expect(new Set(keys).size).toBe(keys.length);
    expect(TOOLS.find((t) => t.kind === 'trend_line')?.shortcut).toBe('alt+t');
  });

  it("shows on a group's button its last tool, else its first", () => {
    expect(groupTool({}, 'lines')).toBe('trend_line');
    expect(groupTool({ lines: 'ray' }, 'lines')).toBe('ray');
    expect(groupTool({}, 'measure')).toBe('measure');
  });

  it('keeps the magnet, the folded rail, each group’s last tool and each kind’s style, as stored before', () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    storage.setItem(
      'tessera.drawing',
      JSON.stringify({
        state: {
          magnet: true,
          collapsed: true,
          lastInGroup: { lines: 'ray', retired: 'gone' },
          styleByKind: { trend_line: { color: 'brass', width: 2 }, retired_kind: { color: 'x' } },
        },
        version: 1,
      }),
    );
    const store = makeDrawingStore(storage);
    expect(read(store)).toMatchObject({
      tool: null,
      selected: null,
      magnet: true,
      collapsed: true,
      lastInGroup: { lines: 'ray' },
      styleByKind: { trend_line: { color: 'brass', width: 2 } },
    });
    expect(read(store).styleByKind).not.toHaveProperty('retired_kind');
    patch(store, { tool: 'ray', magnet: false });
    expect(JSON.parse(m.get('tessera.drawing')!)).toEqual({
      state: {
        magnet: false,
        collapsed: true,
        lastInGroup: { lines: 'ray' },
        styleByKind: { trend_line: { color: 'brass', width: 2 } },
      },
      version: 1,
    });
  });

  it('offers on the style bar only what changes the drawing', () => {
    expect(styleControls({ kind: 'trend_line', namespace: 'user' })).toEqual({
      color: true,
      line: true,
      extend: true,
      levels: false,
      text: false,
      label: true,
    });
    expect(styleControls({ kind: 'text', namespace: 'user' })).toMatchObject({
      line: false,
      text: true,
      extend: false,
    });
    expect(styleControls({ kind: 'fib_retracement', namespace: 'user' })).toMatchObject({ levels: true });
    expect(styleControls({ kind: 'measure', namespace: 'user' }).color).toBe(false);
    expect(styleControls({ kind: 'horizontal_line', namespace: 'agent' }).color).toBe(true);
    expect(styleControls({ kind: 'measure', namespace: 'user' }).color).toBe(false);
    for (const k of ['horizontal_line', 'vertical_line', 'rectangle', 'fib_retracement', 'date_range'] as const)
      expect(styleControls({ kind: k, namespace: 'user' }).label).toBe(true);
    for (const k of ['text', 'measure'] as const)
      expect(styleControls({ kind: k, namespace: 'user' }).label).toBe(false);
  });
});

describe('drawing tools: cross line, trend angle, fib extension and fib fan', () => {
  it('files each with its family on the rail', () => {
    const group = (kind: string) => TOOL_GROUPS.find((g) => g.kinds.some((k) => k === kind))?.id;
    expect(group('trend_angle')).toBe('lines');
    expect(group('cross_line')).toBe('levels');
    expect(group('fib_extension')).toBe('fib');
    expect(group('fib_fan')).toBe('fib');
  });

  it('gives each Fibonacci kind its own levels, choices and label, and the lines a line’s', () => {
    const ext = makeDrawing('fib_extension', [at(0, 1), at(1, 3), at(2, 2)], 'NQ');
    expect(ext.levels).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2]);
    expect(ext.points).toHaveLength(3);
    const fan = makeDrawing('fib_fan', [at(0, 1), at(1, 3)], 'NQ');
    expect(fan.levels).toEqual([0.382, 0.5, 0.618]);
    expect(fan.style.extend).toBe('right');
    expect(extendChoices('fib_fan')).toEqual(['none', 'right']);
    expect(levelChoices('fib_extension')).toEqual(expect.arrayContaining([1.272, 1.618, 2.618, 4.236]));
    expect(levelChoices('trend_angle')).toEqual([]);
    for (const k of ['fib_extension', 'fib_fan'] as const)
      expect(styleControls({ kind: k, namespace: 'user' })).toMatchObject({ levels: true, label: true, extend: true });
    expect(labelControls('fib_extension')).toEqual({ words: false, price: true, levels: true, placement: true });
    expect(labelControls('fib_fan')).toEqual({ words: false, price: false, levels: true, placement: false });
    expect(defaultLabel('fib_fan')).toMatchObject({ showLevels: true, showPrice: false });
    expect(labelControls('cross_line')).toEqual({ words: true, price: true, levels: false, placement: true });
    expect(defaultLabel('cross_line').align).toBe('right');
    expect(styleControls({ kind: 'cross_line', namespace: 'user' })).toMatchObject({ extend: false, label: true });
    expect(styleControls({ kind: 'trend_angle', namespace: 'user' })).toMatchObject({
      extend: true,
      label: true,
      levels: false,
    });
    expect(makeDrawing('cross_line', [at(0, 1)], 'NQ').levels).toBeUndefined();
  });
});

describe('drawing tools: the model', () => {
  it("makes a new drawing with its kind's defaults and the tool's last style", () => {
    const ray = makeDrawing('ray', [at(0, 1), at(1, 2)], 'NQ', { style: { color: 'brass', width: 2 } });
    expect(ray.style).toEqual({ color: 'brass', width: 2, line: 'solid', extend: 'right' });
    expect(ray.namespace).toBe('user');
    expect(ray.id).toMatch(/^dr_/);
    expect(ray.points[0]).toEqual({ t: T0 * NS, price: 1 });
    expect(makeDrawing('fib_retracement', [at(0, 1), at(1, 2)], 'NQ').levels).toEqual([
      0, 0.236, 0.382, 0.5, 0.618, 0.786, 1,
    ]);
    expect(makeDrawing('text', [at(0, 1)], 'NQ', { text: 'hi' }).text).toBe('hi');
    expect(defaultStyle('extended_line').extend).toBe('both');
  });

  it('turns a stored drawing into what the engine draws and back', () => {
    const d = line('a', 'NQ', { style: { color: 'up', width: 2, line: 'dash', extend: 'left' }, locked: true });
    const s = toSpec(d, { up: '#5fc79c' });
    expect(s).toMatchObject({
      id: 'a',
      kind: 'trend_line',
      color: '#5fc79c',
      width: 2,
      dash: 'dash',
      extend: 'left',
      locked: true,
      agent: false,
    });
    expect(s.points).toEqual([at(0, 100), at(10, 110)]);
    expect(toAnchors(s.points)).toEqual(d.points);
    const h: Drawing = { ...line('h'), kind: 'horizontal_line', points: [{ t: null, price: 5 }], namespace: 'agent' };
    const hs = toSpec(h);
    expect(Number.isNaN(hs.points[0]!.t)).toBe(true);
    expect(hs.agent).toBe(h.style.color === 'mist');
    expect(toSpec({ ...h, style: { ...h.style, color: 'mist' } }).agent).toBe(true);
    expect(toSpec({ ...h, style: { ...h.style, color: 'brass' } }).agent).toBe(false);
    expect(toAnchors(hs.points)).toEqual([{ t: null, price: 5 }]);
  });

  it('shows a chart the drawings of the instrument it shows', () => {
    const all = [line('a', 'NQ'), line('b', 'ES'), line('c', 'NQ')];
    expect(drawingsOn(all, 'NQ').map((d) => d.id)).toEqual(['a', 'c']);
    expect(drawingsOn(undefined, 'NQ')).toEqual([]);
  });

  it('switches retracement levels and reads typed ones', () => {
    expect(toggleLevel([0, 0.5, 1], 0.5)).toEqual([0, 1]);
    expect(toggleLevel([0, 1], 0.618)).toEqual([0, 0.618, 1]);
    expect(toggleLevel([0.5], 0.5)).toEqual([0.5]);
    expect(parseLevel('0.65')).toBe(0.65);
    expect(parseLevel('161.8%')).toBe(1.618);
    expect(parseLevel('1,272')).toBe(1.272);
    expect(parseLevel('abc')).toBeNull();
    expect(parseLevel('20')).toBeNull();
    expect(parseLevel('-5')).toBe(-5);
    expect(parseLevel('-5.01')).toBeNull();
    expect(parseLevel('1000%')).toBe(10);
    expect(parseLevel('10.01')).toBeNull();
  });
});

describe('drawing tools: labels', () => {
  it('starts each kind’s label where TradingView would put it, with the runtime’s defaults', () => {
    expect(defaultLabel('horizontal_line')).toMatchObject({ align: 'right', position: 'above', showPrice: false });
    expect(defaultLabel('trend_line').align).toBe('center');
    expect(defaultLabel('horizontal_ray').align).toBe('left');
    expect(defaultLabel('fib_retracement')).toMatchObject({ align: 'left', showPrice: true, showLevels: true });
    expect(defaultLabel('rectangle')).toMatchObject({ size: 12, bold: false, italic: false, text: '' });
    expect(labelOf({ kind: 'measure' })).toBeNull();
    expect(labelOf({ kind: 'ray' })).toEqual(defaultLabel('ray'));
    expect(labelControls('fib_retracement')).toEqual({ words: false, price: true, levels: true, placement: true });
    expect(labelControls('horizontal_ray')).toEqual({ words: true, price: true, levels: false, placement: true });
    expect(labelControls('trend_line')).toEqual({ words: true, price: false, levels: false, placement: true });
    expect(placementWords('vertical_line').align.map((w) => w.label)).toEqual(['Bottom', 'Middle', 'Top']);
    expect(placementWords('rectangle').position.map((w) => w.label)).toEqual(['Top', 'Middle', 'Bottom']);
    expect(placementWords('ray').position.map((w) => w.label)).toEqual(['Above', 'On', 'Below']);
  });

  it('hands the engine a label with its colour resolved, or the line’s (an agent’s aqua) when it has none', () => {
    const d = line('a', 'NQ', { label: { ...defaultLabel('trend_line'), text: 'Swing', color: 'up', bold: true } });
    expect(toSpec(d, { up: '#5fc79c' }).label).toMatchObject({ text: 'Swing', color: '#5fc79c', bold: true });
    const agent: Drawing = { ...line('b'), namespace: 'agent', label: { ...defaultLabel('trend_line'), text: 'PDH' } };
    const spec = toSpec(agent);
    expect(spec.agent).toBe(true);
    expect(spec.label).toMatchObject({ text: 'PDH', color: null });
    const fib = makeDrawing('fib_retracement', [at(0, 1), at(1, 2)], 'NQ');
    expect(fib.label).toBeUndefined();
    expect(toSpec(fib).label).toMatchObject({ showLevels: true, showPrice: true, align: 'left' });
    expect(toSpec(makeDrawing('text', [at(0, 1)], 'NQ', { text: 'hi' })).label).toBeNull();
  });

  it('makes a new drawing in the look its kind’s new drawings take, its words its own', () => {
    const look = {
      color: 'teal',
      width: 2,
      line: 'dash' as const,
      extend: 'right' as const,
      label: { ...defaultLabel('trend_line'), text: 'not copied', position: 'below' as const },
    };
    const d = makeDrawing('trend_line', [at(0, 1), at(1, 2)], 'NQ', { style: look });
    expect(d.style).toEqual({ color: 'teal', width: 2, line: 'dash', extend: 'right' });
    expect(d.label).toMatchObject({ text: '', position: 'below' });
    const fib = makeDrawing('fib_retracement', [at(0, 1), at(1, 2)], 'NQ', { style: { levels: [0, 0.5, 1] } });
    expect(fib.levels).toEqual([0, 0.5, 1]);
    expect(makeDrawing('horizontal_line', [at(0, 1)], 'NQ', { style: { extend: 'both' } }).style.extend).toBe('none');
  });
});

describe('drawing tools: undo', () => {
  it('records what each edit changed and puts it back, leaving others as they are', () => {
    const a = line('a');
    const b = line('b');
    const moved = { ...a, points: [a.points[0]!, { t: 1, price: 1 }] };
    const changes = diffDrawings([a, b], [moved]);
    expect(changes).toEqual([
      { id: 'a', before: a, after: moved },
      { id: 'b', before: b, after: null },
    ]);
    const agent = line('z', 'NQ', { namespace: 'agent' });
    const undone = applyChanges([moved, agent], changes, 'undo');
    expect(undone.map((d) => d.id)).toEqual(['a', 'z', 'b']);
    expect(undone[0]).toBe(a);
    expect(applyChanges(undone, changes, 'redo').map((d) => d.id)).toEqual(['a', 'z']);
  });

  it('joins edits that continue one another into one step, until another edit comes between', () => {
    const a = line('a');
    const h = new DrawingHistory();
    const typed = (text: string) => ({ ...a, label: { ...defaultLabel('trend_line'), text } });
    h.record('c1', diffDrawings([a], [typed('P')]), 'label:a');
    h.record('c1', diffDrawings([typed('P')], [typed('PD')]), 'label:a');
    h.record('c1', diffDrawings([typed('PD')], [typed('PDH')]), 'label:a');
    const moved = { ...typed('PDH'), points: [] };
    h.record('c1', diffDrawings([typed('PDH')], [moved]));
    h.record('c1', diffDrawings([moved], [{ ...moved, label: typed('PDH!').label }]), 'label:a');
    let list: Drawing[] = [{ ...moved, label: typed('PDH!').label }];
    list = h.undo('c1', list)!;
    expect(list[0]!.label!.text).toBe('PDH');
    list = h.undo('c1', list)!;
    expect(list[0]!.points).toEqual(a.points);
    list = h.undo('c1', list)!;
    expect(list[0]!.label).toBeUndefined();
    expect(h.canUndo('c1')).toBe(false);
  });

  it('undoes and redoes per chart; a new edit clears the redo', () => {
    const h = new DrawingHistory();
    const a = line('a');
    h.record('c1', diffDrawings([], [a]));
    expect(h.canUndo('c1')).toBe(true);
    expect(h.canUndo('c2')).toBe(false);
    expect(h.undo('c1', [a])).toEqual([]);
    expect(h.canRedo('c1')).toBe(true);
    expect(h.redo('c1', [])).toEqual([a]);
    h.undo('c1', [a]);
    h.record('c1', diffDrawings([], [line('b')]));
    expect(h.canRedo('c1')).toBe(false);
    expect(h.undo('c2', [])).toBeNull();
  });

  it('splits an edit by the instrument of each drawing it touches', () => {
    const changes = diffDrawings([line('a', 'NQ'), line('b', 'ES')], [line('c', 'NQ')]);
    const parts = byInstrument(changes);
    expect([...parts.keys()].sort()).toEqual(['ES', 'NQ']);
    expect(parts.get('NQ')!.map((c) => c.id)).toEqual(['a', 'c']);
    expect(parts.get('ES')!.map((c) => c.id)).toEqual(['b']);
  });
});

describe('drawing tools: edits on a chart', () => {
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

  it('adds, moves, styles, locks and removes a drawing, each one undo step', () => {
    const id = addDrawing(ref, 'trend_line', [at(0, 100), at(5, 105)], 'NQ');
    expect(drawings()).toHaveLength(1);
    moveDrawing(ref, id, [at(1, 101), at(6, 106)]);
    expect(drawings()[0]!.points[0]!.price).toBe(101);
    restyleDrawing(ref, id, { color: 'brass', extend: 'right' });
    expect(drawings()[0]!.style).toMatchObject({ color: 'brass', extend: 'right' });
    expect(read(drawingStore).styleByKind.trend_line).toEqual({ color: 'brass' });
    updateDrawing(ref, id, { locked: true });
    expect(drawings()[0]!.locked).toBe(true);
    expect(undoDrawings(ref)).toBe(true);
    expect(drawings()[0]!.locked).toBe(false);
    undoDrawings(ref);
    expect(drawings()[0]!.style.color).toBe('mist');
    undoDrawings(ref);
    expect(drawings()[0]!.points[0]!.price).toBe(100);
    undoDrawings(ref);
    expect(drawings()).toEqual([]);
    expect(canUndoDrawings(ref)).toBe(false);
    expect(redoDrawings(ref)).toBe(true);
    expect(drawings()).toHaveLength(1);
    expect(canRedoDrawings(ref)).toBe(true);
    addDrawing(ref, 'trend_line', [at(0, 1), at(1, 2)], 'NQ');
    expect(drawings()[1]!.style.color).toBe('brass');
    expect(canRedoDrawings(ref)).toBe(false);
  });

  it('undoes and redoes the instrument on screen only, keeping the other instrument’s history', () => {
    const setInstrument = (instrument: string) =>
      patch(layoutsStore, (s) => ({
        layouts: {
          L: { ...s.layouts.L!, charts: { 'chart-1': { ...s.layouts.L!.charts['chart-1']!, instrument } } },
        },
      }));
    const nq = addDrawing(ref, 'trend_line', [at(0, 100), at(5, 105)], 'NQ');
    setInstrument('ES');
    expect(canUndoDrawings(ref)).toBe(false);
    addDrawing(ref, 'horizontal_line', [at(0, 5000)], 'ES');
    expect(undoDrawings(ref)).toBe(true);
    expect(undoDrawings(ref)).toBe(false);
    expect(drawings().map((d) => d.id)).toEqual([nq]);
    expect(canRedoDrawings(ref)).toBe(true);
    setInstrument('NQ');
    expect(canRedoDrawings(ref)).toBe(false);
    expect(undoDrawings(ref)).toBe(true);
    expect(drawings()).toEqual([]);
    expect(redoDrawings(ref)).toBe(true);
    expect(drawings().map((d) => d.id)).toEqual([nq]);
  });

  it('labels a line: its words typed in a row are one undo step, its look is what the next line takes', () => {
    const id = addDrawing(ref, 'horizontal_line', [at(0, 20_641.25)], 'NQ');
    expect(drawings()[0]!.label).toBeUndefined();
    for (const text of ['A', 'As', 'Asia', 'Asia high ']) relabelDrawing(ref, id, { text }, { typing: true });
    expect(drawings()[0]!.label).toMatchObject({ text: 'Asia high ', align: 'right', position: 'above' });
    relabelDrawing(ref, id, { text: 'Asia high \n' });
    expect(drawings()[0]!.label!.text).toBe('Asia high');
    relabelDrawing(ref, id, { position: 'below', showPrice: true, color: 'brass' });
    expect(drawings()[0]!.label).toMatchObject({ position: 'below', showPrice: true, color: 'brass' });
    expect(read(drawingStore).styleByKind.horizontal_line?.label).toMatchObject({
      text: '',
      position: 'below',
      showPrice: true,
      color: 'brass',
    });
    const next = addDrawing(ref, 'horizontal_line', [at(0, 20_600)], 'NQ');
    expect(drawings().find((d) => d.id === next)!.label).toMatchObject({ text: '', position: 'below' });
    relabelDrawing(ref, id, { color: undefined });
    expect(drawings()[0]!.label!.color).toBeUndefined();
    undoDrawings(ref);
    undoDrawings(ref);
    undoDrawings(ref);
    undoDrawings(ref);
    expect(drawings()[0]!.label!.text).toBe('Asia high ');
    undoDrawings(ref);
    expect(drawings()[0]!.label).toBeUndefined();
    const m = addDrawing(ref, 'measure', [at(0, 1), at(2, 3)], 'NQ');
    relabelDrawing(ref, m, { text: 'x' });
    expect(drawings().find((d) => d.id === m)!.label).toBeUndefined();
  });

  it('removes a note left empty, and every drawing of the instrument at once', () => {
    const note = addDrawing(ref, 'text', [at(0, 1)], 'NQ', { text: 'hi' });
    addDrawing(ref, 'horizontal_line', [at(0, 2)], 'ES');
    updateDrawing(ref, note, { text: '  ' });
    expect(drawings().map((d) => d.kind)).toEqual(['horizontal_line']);
    addDrawing(ref, 'rectangle', [at(0, 1), at(2, 3)], 'NQ');
    addDrawing(ref, 'measure', [at(0, 1), at(2, 3)], 'NQ');
    expect(removeAllDrawings(ref, 'NQ')).toBe(2);
    expect(drawings().map((d) => d.instrument)).toEqual(['ES']);
    undoDrawings(ref);
    expect(drawings()).toHaveLength(3);
  });
});

describe('the style bar', () => {
  const plot = { x: 0, y: 0, w: 900, h: 500 };
  const bar = { w: 220, h: 34 };
  const legend = { x: 9, y: 0, w: 380, h: 100 };

  it('sits over the drawing, centred, inside the plot', () => {
    const at = styleBarAt({ x: 400, y: 300, w: 100, h: 60 }, bar, plot, legend);
    expect(at).toEqual({ x: 340, y: 300 - 34 - 10 });
    expect(styleBarAt({ x: 600, y: 2, w: 100, h: 60 }, bar, plot, legend).y).toBe(72);
  });

  it('never covers the legend: beside it, else under the drawing, else under the legend', () => {
    const fib = { x: 60, y: 90, w: 300, h: 200 };
    expect(overlaps({ ...styleBarAt(fib, bar, plot, null), ...bar }, legend)).toBe(true);
    const at = styleBarAt(fib, bar, plot, legend);
    expect(overlaps({ ...at, ...bar }, legend)).toBe(false);
    expect(at).toEqual({ x: 9 + 380 + 6, y: 90 - 34 - 10 });
    const narrow = { x: 0, y: 0, w: 560, h: 500 };
    expect(styleBarAt(fib, bar, narrow, legend)).toEqual({ x: 100, y: 90 + 200 + 10 });
    const tall = { ...fib, h: 380 };
    const under = styleBarAt(tall, bar, narrow, legend);
    expect(under.y).toBe(100 + 6);
    expect(overlaps({ ...under, ...bar }, legend)).toBe(false);
  });
});

describe('the volume profile tools', () => {
  it('place a profile study from clicks: a fixed range to the end of its last bar, or an anchor to now', () => {
    expect(TOOLS.find((t) => t.kind === 'profile_range')).toMatchObject({ group: 'profile', shortcut: 'alt+shift+p' });
    expect(TOOL_GROUPS.find((g) => g.id === 'profile')?.kinds).toEqual(['profile_range', 'profile_anchored']);
    const bars = new SeriesStore(16);
    bars.setData(Array.from({ length: 10 }, (_, k) => ({ t: T0 + k * 3_600_000, o: 1, h: 1, l: 1, c: 1, v: 1 })));
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(placedInputs('profile_range', [at(5 * 60, 100), at(0, 110)], bars, '1h')).toEqual({
      period: 'range',
      from: iso(T0),
      to: iso(T0 + 6 * 3_600_000),
    });
    expect(placedInputs('profile_anchored', [at(2 * 60, 100)], bars, '1h')).toEqual({
      period: 'anchored',
      from: iso(T0 + 2 * 3_600_000),
      to: '',
    });
    expect(placedInputs('profile_range', [at(0, 100)], bars, '1h')).toBeNull();
  });

  it('keep the profile popover on a placed range or anchored study, setting the study’s own inputs', () => {
    const study = (period: string, visible = true) => ({
      id: `vp-${period}`,
      kind: 'volume_profile',
      params: { inputs: { period, show: 'split', valueArea: 80, rowTicks: '4', length: 5 } },
      visible,
      namespace: 'user' as const,
      sessionId: null,
    });
    expect(isPlacedProfile(study('range'))).toBe(true);
    expect(isPlacedProfile(study('anchored'))).toBe(true);
    expect(isPlacedProfile(study('week'))).toBe(false);
    expect(isPlacedProfile(study('range', false))).toBe(false);
    expect(profileQuick(study('range'))).toEqual({ show: 'split', valueArea: 80, rowTicks: '4' });
    expect(PROFILE_SHOWS.map((o) => o.label)).toEqual(['Volume', 'Buy/Sell', 'Delta', 'Vol+Δ']);
    const [range, week] = withProfileInputs([study('range'), study('week')], 'vp-range', { show: 'delta' });
    expect((range!.params as { inputs: Record<string, unknown> }).inputs).toEqual({
      period: 'range',
      show: 'delta',
      valueArea: 80,
      rowTicks: '4',
      length: 5,
    });
    expect(week).toEqual(study('week'));
  });
});
