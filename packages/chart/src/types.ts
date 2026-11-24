export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  bv?: number;
}

export type BarTuple =
  | readonly [t: number, o: number, h: number, l: number, c: number, v: number]
  | readonly [t: number, o: number, h: number, l: number, c: number, v: number, bv: number];

export type BarInput = Bar | BarTuple;

export interface PriceFormat {
  precision: number;
  minMove: number;
}

export interface SessionOptions {
  mode: 'collapse' | 'continuous';
  timezone: string;
  dayStartMinutes: number;
  dayStartZone?: string;
  maxGapMs?: number;
}

export interface ChartTheme {
  background: string;
  grid: string;
  border: string;
  text: string;
  mutedText: string;
  subtleText: string;
  labelText: string;
  dayText: string;
  upFill: string;
  downFill: string;
  upVolume: string;
  downVolume: string;
  upText: string;
  downText: string;
  agent: string;
  hazard: string;
  crosshair: string;
  tagBackground: string;
  tagInk: string;
  tagInkLight: string;
  lastPrice: string | null;
  lastPriceLine: string | null;
  sessionSeparator: string;
  font: string;
  fontMono: string;
  fontFig: string;
  fontSize: number;
  priceFontSize: number;
  gridVertical: string;
  upWick: string;
  downWick: string;
  upBorder: string;
  downBorder: string;
  upBar: string;
  downBar: string;
  lineSeries: string;
  handles: string | null;
  flow: ChartFlowTheme;
}

export interface TimeSpan {
  readonly from: number;
  readonly to: number;
}

export interface ChartFlowTheme {
  volume: string;
  ask: string;
  bid: string;
  imbalanceAsk: string;
  imbalanceBid: string;
  text: string;
  poc: string;
  bubbleBuy: string;
  bubbleSell: string;
  deltaUp: string;
  deltaDown: string;
  profileBar: string;
  profileValueArea: string;
  profilePoc: string;
  profileBuy: string;
  profileSell: string;
}

export interface ChartOptions {
  theme?: Partial<ChartTheme>;
  priceFormat?: PriceFormat;
  sessions?: SessionOptions;
  timeframeMs?: number;
  volumePane?: number;
  rightPadBars?: number;
  initialBars?: number;
  clearLeft?: number;
  legend?: { title: string; subtitle?: string; hover?: boolean } | false;
  lastPrice?: 'live' | 'stale';
  countdown?: boolean;
  now?: () => number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewportState {
  barSpacing: number;
  rightEdgeSlot: number;
  from: number;
  to: number;
  fromTime: number | null;
  toTime: number | null;
  priceMin: number;
  priceMax: number;
  priceMode: 'auto' | 'manual';
  following: boolean;
  asked: TimeAsk | null;
  shown: { from: number; to: number } | null;
}

export type TimeAsk = { lastBars: number } | { fitAll: true } | { range: { from: number; to: number } };

export interface ViewportUpdate {
  barSpacing?: number;
  rightEdgeSlot?: number;
  lastBars?: number;
  fitAll?: boolean;
  range?: { from: number; to: number };
  price?: { min: number; max: number } | 'auto';
}

export interface ChartCoords {
  plot: Rect;
  volume: Rect | null;
  panes: readonly { id: PaneId; rect: Rect }[];
  priceAxis: Rect;
  timeAxis: Rect;
  barSpacing: number;
  from: number;
  to: number;
  xOfIndex(index: number): number;
  xOfTime(timeMs: number): number | null;
  indexOfX(x: number): number;
  timeOfX(x: number): number | null;
  yOfPrice(price: number): number;
  priceOfY(y: number): number;
}

export interface BarSnapshot extends Bar {
  index: number;
}

export interface CrosshairEvent {
  x: number;
  y: number;
  index: number;
  time: number | null;
  price: number;
  bar: BarSnapshot | null;
}

export interface LayerHit {
  layerId: string;
  objectId: string;
  distance: number;
}

export interface PointerMods {
  shift?: boolean;
  alt?: boolean;
  cmdOrCtrl?: boolean;
}

export interface ChartClickEvent {
  x: number;
  y: number;
  index: number;
  price: number;
  hits: LayerHit[];
}

export interface FrameEvent {
  durationMs: number;
  surfaces: SurfaceKind[];
  timings: Partial<Record<SurfaceKind, number>>;
}

export interface GapHover {
  x: number;
  y: number;
  from: number;
  to: number;
}

export interface ChartEventMap {
  crosshair: CrosshairEvent | null;
  gap: GapHover | null;
  viewport: ViewportState;
  click: ChartClickEvent;
  frame: FrameEvent;
  layers: readonly LayerInfo[];
  panes: readonly PaneHeight[];
  settled: ViewportState;
}

export interface PaneHeight {
  id: PaneId;
  height: number;
}

export type ChartEventName = keyof ChartEventMap;

export type SurfaceKind = 'gpu' | 'underlay' | 'main' | 'overlay';

export type Surface2D = Exclude<SurfaceKind, 'gpu'>;

export type GpuState = 'none' | 'active' | 'fallback' | 'failed';

export type PaneId = string;

export type LayerKind = 'series' | 'study' | 'overlay' | 'drawing' | 'annotation' | 'interaction';

export interface LayerInfo {
  id: string;
  kind: LayerKind;
  provider: string | null;
  owner: string | null;
  surface: SurfaceKind;
  pane: PaneId;
  z: number;
  visible: boolean;
  settingsSchema: Record<string, unknown> | null;
}
