import {
  defaultExtend,
  picksProfile,
  defaultLevels,
  isFibKind,
  LABEL_KINDS,
  type DrawingLabelSpec,
  type DrawingPoint,
  type DrawingSpec,
  type PlaceKind,
} from '@tessera/chart';
import {
  msToNs,
  normalizeEpochMs,
  type AnchorPoint,
  type Drawing,
  type DrawingKind,
  type DrawingLabel,
  type DrawingStyle,
  type LabelAlign,
  type LabelPosition,
  type LineDash,
} from '@tessera/protocol';
import type { IconName } from '@tessera/ui';
import { colorOf, themeSwatches, type SwatchPalette } from '../indicators.ts';

export type ToolGroupId = 'lines' | 'levels' | 'shapes' | 'fib' | 'text' | 'measure' | 'profile';

export interface ToolDef {
  kind: PlaceKind;
  label: string;
  group: ToolGroupId;
  icon: IconName;
  shortcut?: string;
}

export const TOOLS: readonly ToolDef[] = [
  { kind: 'trend_line', label: 'Trend line', group: 'lines', icon: 'trend-line', shortcut: 'alt+t' },
  { kind: 'ray', label: 'Ray', group: 'lines', icon: 'ray' },
  { kind: 'extended_line', label: 'Extended line', group: 'lines', icon: 'extended-line' },
  { kind: 'trend_angle', label: 'Trend angle', group: 'lines', icon: 'trend-angle' },
  {
    kind: 'horizontal_line',
    label: 'Horizontal line',
    group: 'levels',
    icon: 'h-line',
    shortcut: 'alt+h',
  },
  {
    kind: 'horizontal_ray',
    label: 'Horizontal ray',
    group: 'levels',
    icon: 'h-ray',
    shortcut: 'alt+j',
  },
  {
    kind: 'vertical_line',
    label: 'Vertical line',
    group: 'levels',
    icon: 'v-line',
    shortcut: 'alt+v',
  },
  { kind: 'cross_line', label: 'Cross line', group: 'levels', icon: 'cross-line' },
  { kind: 'rectangle', label: 'Rectangle', group: 'shapes', icon: 'rectangle', shortcut: 'alt+r' },
  { kind: 'parallel_channel', label: 'Parallel channel', group: 'shapes', icon: 'channel' },
  { kind: 'fib_retracement', label: 'Fib retracement', group: 'fib', icon: 'fib', shortcut: 'alt+f' },
  { kind: 'fib_extension', label: 'Fib extension', group: 'fib', icon: 'fib-extension' },
  { kind: 'fib_fan', label: 'Fib fan', group: 'fib', icon: 'fib-fan' },
  { kind: 'text', label: 'Text', group: 'text', icon: 'text', shortcut: 'alt+n' },
  { kind: 'measure', label: 'Measure', group: 'measure', icon: 'measure', shortcut: 'alt+m' },
  { kind: 'price_range', label: 'Price range', group: 'measure', icon: 'price-range' },
  { kind: 'date_range', label: 'Date range', group: 'measure', icon: 'date-range' },
  {
    kind: 'profile_range',
    label: 'Fixed range volume profile',
    group: 'profile',
    icon: 'profile-range',
    shortcut: 'alt+shift+p',
  },
  {
    kind: 'profile_anchored',
    label: 'Anchored volume profile',
    group: 'profile',
    icon: 'profile-anchored',
    shortcut: 'alt+shift+v',
  },
];

export interface ToolGroup {
  id: ToolGroupId;
  label: string;
  kinds: readonly PlaceKind[];
}

export const DRAWING_TOOLS = TOOLS.filter((t): t is ToolDef & { kind: DrawingKind } => !picksProfile(t.kind));

export const TOOL_GROUPS: readonly ToolGroup[] = (
  [
    ['lines', 'Lines'],
    ['levels', 'Horizontal and vertical'],
    ['shapes', 'Shapes'],
    ['fib', 'Fibonacci'],
    ['text', 'Text'],
    ['measure', 'Measure'],
    ['profile', 'Volume profiles'],
  ] as const
).map(([id, label]) => ({ id, label, kinds: TOOLS.filter((t) => t.group === id).map((t) => t.kind) }));

export function toolOf(kind: PlaceKind): ToolDef {
  return TOOLS.find((t) => t.kind === kind)!;
}

const EXTENDS: ReadonlySet<DrawingKind> = new Set([
  'trend_line',
  'ray',
  'extended_line',
  'trend_angle',
  'rectangle',
  'parallel_channel',
  'fib_retracement',
  'fib_extension',
  'fib_fan',
]);

export { LABEL_KINDS };

const PRICED: ReadonlySet<DrawingKind> = new Set([
  'horizontal_line',
  'horizontal_ray',
  'cross_line',
  'fib_retracement',
  'fib_extension',
]);

export function styleControls(d: Pick<Drawing, 'kind' | 'namespace'>): {
  color: boolean;
  line: boolean;
  extend: boolean;
  levels: boolean;
  text: boolean;
  label: boolean;
} {
  return {
    color: d.kind !== 'measure',
    line: d.kind !== 'text',
    extend: EXTENDS.has(d.kind),
    levels: isFibKind(d.kind),
    text: d.kind === 'text',
    label: LABEL_KINDS.has(d.kind),
  };
}

export const LABEL_SIZE = 12;
export const LABEL_SIZES: readonly number[] = [10, 11, 12, 14, 16, 20, 24, 28, 32, 40];

export function labelControls(kind: DrawingKind): {
  words: boolean;
  price: boolean;
  levels: boolean;
  placement: boolean;
} {
  return {
    words: LABEL_KINDS.has(kind) && !isFibKind(kind),
    price: PRICED.has(kind),
    levels: isFibKind(kind),
    placement: kind !== 'fib_fan',
  };
}

const RIGHT_ALIGNED: ReadonlySet<DrawingKind> = new Set(['horizontal_line', 'vertical_line', 'cross_line']);
const LEFT_ALIGNED: ReadonlySet<DrawingKind> = new Set([
  'horizontal_ray',
  'rectangle',
  'price_range',
  'date_range',
  'fib_retracement',
  'fib_extension',
  'fib_fan',
]);

export function defaultLabel(kind: DrawingKind): DrawingLabel {
  const align: LabelAlign = RIGHT_ALIGNED.has(kind) ? 'right' : LEFT_ALIGNED.has(kind) ? 'left' : 'center';
  return {
    text: '',
    size: LABEL_SIZE,
    bold: false,
    italic: false,
    align,
    position: 'above',
    showPrice: kind === 'fib_retracement' || kind === 'fib_extension',
    showLevels: true,
  };
}

export function labelOf(d: Pick<Drawing, 'kind' | 'label'>): DrawingLabel | null {
  if (!LABEL_KINDS.has(d.kind)) return null;
  return d.label ?? defaultLabel(d.kind);
}

export function labelLook(l: DrawingLabel): DrawingLabel {
  return { ...l, text: '' };
}

export function cleanLabelText(text: string): string {
  return text.trimEnd();
}

export function placementWords(kind: DrawingKind): {
  align: readonly { value: LabelAlign; label: string }[];
  position: readonly { value: LabelPosition; label: string }[];
} {
  if (kind === 'vertical_line') {
    return {
      align: [
        { value: 'left', label: 'Bottom' },
        { value: 'center', label: 'Middle' },
        { value: 'right', label: 'Top' },
      ],
      position: [
        { value: 'above', label: 'Left' },
        { value: 'on', label: 'On' },
        { value: 'below', label: 'Right' },
      ],
    };
  }
  const box = kind === 'rectangle' || kind === 'price_range' || kind === 'date_range';
  return {
    align: [
      { value: 'left', label: 'Left' },
      { value: 'center', label: 'Centre' },
      { value: 'right', label: 'Right' },
    ],
    position: [
      { value: 'above', label: box ? 'Top' : 'Above' },
      { value: 'on', label: box ? 'Middle' : 'On' },
      { value: 'below', label: box ? 'Bottom' : 'Below' },
    ],
  };
}

function labelSpec(l: DrawingLabel, palette: SwatchPalette): DrawingLabelSpec {
  return {
    text: l.text,
    color: l.color ? colorOf(l.color, palette) : null,
    size: l.size,
    bold: l.bold,
    italic: l.italic,
    align: l.align,
    position: l.position,
    showPrice: l.showPrice,
    showLevels: l.showLevels,
  };
}

export const DRAWING_DEFAULT_COLOR = 'mist';

export function inAnalystColour(d: Pick<Drawing, 'namespace' | 'style'>): boolean {
  return d.namespace === 'agent' && d.style.color === DRAWING_DEFAULT_COLOR;
}

export type NewDrawingLook = Partial<DrawingStyle> & { label?: DrawingLabel; levels?: number[] };

export function defaultStyle(kind: DrawingKind, last?: NewDrawingLook): DrawingStyle {
  return {
    color: last?.color ?? DRAWING_DEFAULT_COLOR,
    width: last?.width ?? 1,
    line: last?.line ?? ('solid' satisfies LineDash),
    extend: last?.extend && EXTENDS.has(kind) ? last.extend : defaultExtend(kind),
  };
}

const EXTEND_CHOICES: readonly DrawingStyle['extend'][] = ['none', 'left', 'right', 'both'];

export function extendChoices(kind: DrawingKind): readonly DrawingStyle['extend'][] {
  return kind === 'fib_fan' ? ['none', 'right'] : EXTEND_CHOICES;
}

export { defaultLevels };
export const LEVEL_MIN = -5;
export const LEVEL_MAX = 10;

const LEVEL_CHOICES: Readonly<Record<'fib_retracement' | 'fib_extension' | 'fib_fan', readonly number[]>> = {
  fib_retracement: [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618, 2.618],
  fib_extension: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.414, 1.618, 2, 2.618, 3.618, 4.236],
  fib_fan: [0.236, 0.382, 0.5, 0.618, 0.786, 1],
};

export function levelChoices(kind: DrawingKind): readonly number[] {
  return isFibKind(kind) ? LEVEL_CHOICES[kind] : [];
}

export function toggleLevel(levels: readonly number[], level: number): number[] {
  const on = levels.some((l) => Math.abs(l - level) < 1e-9);
  const next = on ? levels.filter((l) => Math.abs(l - level) >= 1e-9) : [...levels, level];
  return next.length ? [...next].sort((a, b) => a - b) : [...levels];
}

export function parseLevel(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const pct = t.endsWith('%');
  const v = Number(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(v)) return null;
  const level = pct ? v / 100 : v;
  return level >= LEVEL_MIN && level <= LEVEL_MAX ? Number(level.toFixed(4)) : null;
}

export function toSpec(d: Drawing, palette: SwatchPalette = themeSwatches()): DrawingSpec {
  const label = labelOf(d);
  return {
    id: d.id,
    kind: d.kind,
    points: d.points.map((p) => ({
      t: p.t === null ? Number.NaN : normalizeEpochMs(p.t),
      price: p.price ?? Number.NaN,
    })),
    color: colorOf(d.style.color, palette),
    width: d.style.width,
    dash: d.style.line,
    extend: d.style.extend,
    text: d.text ?? null,
    levels: d.levels ?? null,
    locked: d.locked,
    agent: inAnalystColour(d),
    label: label ? labelSpec(label, palette) : null,
  };
}

export function toAnchors(points: readonly DrawingPoint[]): AnchorPoint[] {
  return points.map((p) => ({
    t: Number.isFinite(p.t) ? msToNs(p.t) : null,
    price: Number.isFinite(p.price) ? p.price : null,
  }));
}

export function drawingsOn(all: readonly Drawing[] | undefined, instrument: string): Drawing[] {
  return (all ?? []).filter((d) => d.instrument === instrument);
}

function newDrawingId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `dr_${Date.now().toString(36)}${rand}`;
}

export function makeDrawing(
  kind: DrawingKind,
  points: readonly DrawingPoint[],
  instrument: string,
  opts: { style?: NewDrawingLook; text?: string; now?: number; id?: string } = {},
): Drawing {
  const label = LABEL_KINDS.has(kind) && opts.style?.label ? labelLook(opts.style.label) : null;
  return {
    id: opts.id ?? newDrawingId(),
    kind,
    instrument,
    points: toAnchors(points),
    style: defaultStyle(kind, opts.style),
    ...(kind === 'text' ? { text: opts.text ?? '' } : {}),
    ...(isFibKind(kind) ? { levels: [...(opts.style?.levels ?? defaultLevels(kind) ?? [])] } : {}),
    ...(label ? { label } : {}),
    locked: false,
    namespace: 'user',
    sessionId: null,
    createdAt: msToNs(opts.now ?? Date.now()),
  };
}

export interface DrawingChange {
  id: string;
  before: Drawing | null;
  after: Drawing | null;
}

export function diffDrawings(before: readonly Drawing[], after: readonly Drawing[]): DrawingChange[] {
  const was = new Map(before.map((d) => [d.id, d]));
  const now = new Map(after.map((d) => [d.id, d]));
  const out: DrawingChange[] = [];
  for (const [id, d] of was) {
    const n = now.get(id) ?? null;
    if (n !== d && JSON.stringify(n) !== JSON.stringify(d)) out.push({ id, before: d, after: n });
  }
  for (const [id, d] of now) if (!was.has(id)) out.push({ id, before: null, after: d });
  return out;
}

export function byInstrument(changes: readonly DrawingChange[]): Map<string, DrawingChange[]> {
  const out = new Map<string, DrawingChange[]>();
  for (const c of changes) {
    const instrument = (c.after ?? c.before)?.instrument;
    if (instrument === undefined) continue;
    const part = out.get(instrument);
    if (part) part.push(c);
    else out.set(instrument, [c]);
  }
  return out;
}

export function applyChanges(
  list: readonly Drawing[],
  changes: readonly DrawingChange[],
  dir: 'undo' | 'redo',
): Drawing[] {
  let out = [...list];
  for (const c of changes) {
    const want = dir === 'undo' ? c.before : c.after;
    const i = out.findIndex((d) => d.id === c.id);
    if (want === null) {
      if (i >= 0) out = [...out.slice(0, i), ...out.slice(i + 1)];
    } else if (i >= 0) {
      out[i] = want;
    } else {
      out.push(want);
    }
  }
  return out;
}

const HISTORY_MAX = 100;

export class DrawingHistory<C extends DrawingChange = DrawingChange> {
  private readonly stacks = new Map<string, { undo: C[][]; redo: C[][]; tag: string | null }>();

  private of(key: string) {
    let s = this.stacks.get(key);
    if (!s) {
      s = { undo: [], redo: [], tag: null };
      this.stacks.set(key, s);
    }
    return s;
  }

  record(key: string, changes: readonly C[], merge?: string): void {
    if (changes.length === 0) return;
    const s = this.of(key);
    const last = s.undo[s.undo.length - 1];
    if (merge !== undefined && merge === s.tag && last && s.redo.length === 0) {
      for (const c of changes) {
        const i = last.findIndex((x) => x.id === c.id);
        if (i >= 0) last[i] = { ...last[i]!, after: c.after };
        else last.push(c);
      }
      return;
    }
    s.undo.push([...changes]);
    if (s.undo.length > HISTORY_MAX) s.undo.shift();
    s.redo = [];
    s.tag = merge ?? null;
  }

  canUndo(key: string): boolean {
    return (this.stacks.get(key)?.undo.length ?? 0) > 0;
  }

  canRedo(key: string): boolean {
    return (this.stacks.get(key)?.redo.length ?? 0) > 0;
  }

  take(key: string, dir: 'undo' | 'redo'): C[] | null {
    const s = this.of(key);
    const step = (dir === 'undo' ? s.undo : s.redo).pop();
    s.tag = null;
    if (!step) return null;
    (dir === 'undo' ? s.redo : s.undo).push(step);
    return dir === 'undo' ? [...step].reverse() : step;
  }

  undo(key: string, list: readonly Drawing[]): Drawing[] | null {
    const step = this.take(key, 'undo');
    return step ? applyChanges(list, step, 'undo') : null;
  }

  redo(key: string, list: readonly Drawing[]): Drawing[] | null {
    const step = this.take(key, 'redo');
    return step ? applyChanges(list, step, 'redo') : null;
  }
}
