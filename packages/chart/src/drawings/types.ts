export type DrawingKind =
  | 'trend_line'
  | 'ray'
  | 'extended_line'
  | 'trend_angle'
  | 'horizontal_line'
  | 'horizontal_ray'
  | 'vertical_line'
  | 'cross_line'
  | 'rectangle'
  | 'parallel_channel'
  | 'fib_retracement'
  | 'fib_extension'
  | 'fib_fan'
  | 'text'
  | 'price_range'
  | 'date_range'
  | 'measure';

export type ProfilePick = 'profile_range' | 'profile_anchored';

export type PlaceKind = DrawingKind | ProfilePick;

export function picksProfile(kind: PlaceKind): kind is ProfilePick {
  return kind === 'profile_range' || kind === 'profile_anchored';
}

export type DrawingExtend = 'none' | 'left' | 'right' | 'both';

export type DrawingDash = 'solid' | 'dash' | 'dot';

export interface DrawingPoint {
  t: number;
  price: number;
}

export interface DrawingSpec {
  id: string;
  kind: PlaceKind;
  points: readonly DrawingPoint[];
  color: string;
  width: number;
  dash: DrawingDash;
  extend: DrawingExtend;
  text?: string | null;
  levels?: readonly number[] | null;
  locked: boolean;
  agent: boolean;
  label?: DrawingLabelSpec | null;
}

export type LabelAlign = 'left' | 'center' | 'right';
export type LabelPosition = 'above' | 'on' | 'below';

export interface DrawingLabelSpec {
  text: string;
  color: string | null;
  size: number;
  bold: boolean;
  italic: boolean;
  align: LabelAlign;
  position: LabelPosition;
  showPrice: boolean;
  showLevels: boolean;
}

export const LABEL_KINDS: ReadonlySet<PlaceKind> = new Set<PlaceKind>([
  'trend_line',
  'ray',
  'extended_line',
  'trend_angle',
  'horizontal_line',
  'horizontal_ray',
  'vertical_line',
  'cross_line',
  'rectangle',
  'parallel_channel',
  'fib_retracement',
  'fib_extension',
  'fib_fan',
  'price_range',
  'date_range',
]);

export type FibKind = 'fib_retracement' | 'fib_extension' | 'fib_fan';

export const FIB_DEFAULT_LEVELS: Readonly<Record<FibKind, readonly number[]>> = {
  fib_retracement: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  fib_extension: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2],
  fib_fan: [0.382, 0.5, 0.618],
};

export function isFibKind(kind: PlaceKind): kind is FibKind {
  return kind in FIB_DEFAULT_LEVELS;
}

export function defaultLevels(kind: PlaceKind): readonly number[] | null {
  return isFibKind(kind) ? FIB_DEFAULT_LEVELS[kind] : null;
}

export function takesWords(kind: PlaceKind): boolean {
  return LABEL_KINDS.has(kind) && !isFibKind(kind);
}

export const DRAWING_ANCHORS: Readonly<Record<PlaceKind, number>> = {
  trend_line: 2,
  ray: 2,
  extended_line: 2,
  trend_angle: 2,
  horizontal_line: 1,
  horizontal_ray: 1,
  vertical_line: 1,
  cross_line: 1,
  rectangle: 2,
  parallel_channel: 3,
  fib_retracement: 2,
  fib_extension: 3,
  fib_fan: 2,
  text: 1,
  price_range: 2,
  date_range: 2,
  measure: 2,
  profile_range: 2,
  profile_anchored: 1,
};

export type DrawingEvent =
  | { type: 'create'; kind: PlaceKind; points: DrawingPoint[] }
  | { type: 'move'; id: string; points: DrawingPoint[] }
  | { type: 'remove'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'cancel' }
  | { type: 'edit-text'; id: string };

export type { PointerMods } from '../types.ts';
