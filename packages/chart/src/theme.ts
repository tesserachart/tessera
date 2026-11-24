import type { ChartFlowTheme, ChartTheme } from './types.ts';

const SANS = "'Instrument Sans', 'Tessera Keys', sans-serif";
const FIG = SANS;

const INK = '#05080b';
const LINE = '#1b2730';
const RAISE = '#0d1319';
const T1 = '#e8eef3';
const T2 = '#aebcc8';
const T3 = '#7c8b99';
const UP = '#2fd3b4';
const DOWN = '#e0523f';
const ICE = '#8ed1fc';
const GOLD = '#d8b26a';
const MIST = '#e8eef3';
const FS_META = 11.5;
const FS_FIG_META = 12;

const MIN_FONT_PX = 10;
const MIN_PRICE_FONT_PX = 11;

export function mergeTheme(base: ChartTheme, patch: Partial<ChartTheme> | undefined): ChartTheme {
  const t = { ...base, ...patch };
  t.fontSize = Math.max(MIN_FONT_PX, t.fontSize);
  t.priceFontSize = Math.max(MIN_PRICE_FONT_PX, t.priceFontSize);
  return t;
}

export interface LineStyle {
  name: string;
  text: string;
  line: string;
  dash: readonly number[];
  width: number;
}

export type LevelKind =
  'callWall' | 'putWall' | 'maxGamma' | 'zeroGamma' | 'gammaFlip' | 'pdh' | 'pdl' | 'vwap' | 'plan' | 'custom';

export const LEVEL_STYLES: Readonly<Record<LevelKind, LineStyle>> = {
  callWall: { name: 'Call wall', text: UP, line: 'rgba(47,211,180,0.6)', dash: [], width: 1 },
  putWall: { name: 'Put wall', text: DOWN, line: 'rgba(224,82,63,0.6)', dash: [], width: 1 },
  maxGamma: { name: 'Max gamma', text: T2, line: 'rgba(232,238,243,0.45)', dash: [], width: 1 },
  zeroGamma: { name: 'Zero gamma', text: T2, line: 'rgba(232,238,243,0.45)', dash: [1, 3], width: 1 },
  gammaFlip: { name: 'Flip', text: MIST, line: 'rgba(232,238,243,0.7)', dash: [6, 4], width: 1 },
  pdh: { name: 'Prior high', text: T3, line: 'rgba(124,139,153,0.55)', dash: [2, 3], width: 1 },
  pdl: { name: 'Prior low', text: T3, line: 'rgba(124,139,153,0.55)', dash: [2, 3], width: 1 },
  vwap: { name: 'VWAP', text: MIST, line: 'rgba(232,238,243,0.55)', dash: [], width: 1.25 },
  plan: { name: 'Plan', text: ICE, line: 'rgba(142,209,252,0.6)', dash: [6, 4], width: 1 },
  custom: { name: '', text: T2, line: 'rgba(174,188,200,0.6)', dash: [], width: 1 },
};

export type OrderKind = 'draft' | 'staged' | 'working' | 'position' | 'stop' | 'target' | 'offline';

export const ORDER_STYLES: Readonly<Record<OrderKind, Omit<LineStyle, 'name'>>> = {
  draft: { text: ICE, line: ICE, dash: [5, 3], width: 1 },
  stop: { text: DOWN, line: 'rgba(224,82,63,0.75)', dash: [], width: 1 },
  target: { text: UP, line: 'rgba(47,211,180,0.7)', dash: [], width: 1 },
  staged: { text: MIST, line: MIST, dash: [5, 3], width: 1 },
  offline: { text: T3, line: T3, dash: [1, 3], width: 1 },
  working: { text: MIST, line: MIST, dash: [], width: 1 },
  position: { text: GOLD, line: GOLD, dash: [], width: 1.5 },
};

export const DRAFT_DASH: readonly number[] = [5, 3];

const PROFILE_STYLE = {
  bar: 'rgba(174,188,200,0.22)',
  valueArea: 'rgba(174,188,200,0.42)',
  poc: MIST,
} as const;

export const FOOTPRINT_TEXT = { color: T1, alpha: 0.82 } as const;

export function niceStep(minStep: number): number {
  if (!(minStep > 0) || !Number.isFinite(minStep)) return 1;
  const b = 10 ** Math.floor(Math.log10(minStep));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * b >= minStep - 1e-12) return m * b;
  return 10 * b;
}

export const ORDERFLOW_STYLE = {
  tintVolume: [0.04, 0.3] as const,
  tintDelta: [0.06, 0.4] as const,
  cellSplit: [0.18, 0.6] as const,
  histogram: [0.16, 0.46] as const,
  tintSteps: 8,
  mist: '232,238,243',
  up: '47,211,180',
  down: '224,82,63',
  imbalanceWeight: 600,
  zoneFill: 0.06,
  zoneEdge: 0.6,
  pocOutline: { color: PROFILE_STYLE.poc, alpha: 0.75 },
  pocDash: { color: PROFILE_STYLE.poc, alpha: 0.6 },
  bubbleFill: 0.75,
  bubbleStroke: 1,
  bubbleHoverStroke: 2,
  bubbleRadiusMin: 2,
  bubbleRadiusMax: 10,
  bubbleRadiusBase: 1,
  bubbleRadiusPerSpacing: 0.85,
  bubbleScaleMax: 2.5,
  bubbleLabelSpacingMin: 5,
  bubbleLabelWeight: 600,
  bubbleLabelHalo: 3,
  zoneOpacity: 0.18,
  text: `rgba(232,238,243,${String(FOOTPRINT_TEXT.alpha)})`,
  cellBar: 0.1,
  barProfile: 0.3,
  barValueArea: 0.55,
  unfinished: 0.8,
  deltaPoc: 0.7,
  maxLevel: { width: 1.5, alpha: 0.95 },
  figureSize: 11.5,
} as const;

const BUBBLE_TINT = 0.25;

export const TESSERA_FLOW: ChartFlowTheme = {
  volume: ORDERFLOW_STYLE.mist,
  ask: ORDERFLOW_STYLE.up,
  bid: ORDERFLOW_STYLE.down,
  imbalanceAsk: UP,
  imbalanceBid: DOWN,
  text: ORDERFLOW_STYLE.text,
  poc: PROFILE_STYLE.poc,
  bubbleBuy: rgba(ORDERFLOW_STYLE.up, BUBBLE_TINT),
  bubbleSell: rgba(ORDERFLOW_STYLE.down, BUBBLE_TINT),
  deltaUp: UP,
  deltaDown: DOWN,
  profileBar: PROFILE_STYLE.bar,
  profileValueArea: PROFILE_STYLE.valueArea,
  profilePoc: 'rgba(232,238,243,0.72)',
  profileBuy: 'rgba(47,211,180,0.24)',
  profileSell: 'rgba(224,82,63,0.28)',
};

export const TESSERA_THEME: ChartTheme = {
  background: INK,
  grid: 'rgba(232,238,243,0.032)',
  border: LINE,
  text: T1,
  mutedText: T3,
  subtleText: T2,
  labelText: T3,
  dayText: T2,
  upFill: UP,
  downFill: DOWN,
  upVolume: 'rgba(47,211,180,0.24)',
  downVolume: 'rgba(224,82,63,0.28)',
  upText: UP,
  downText: DOWN,
  agent: ICE,
  hazard: GOLD,
  crosshair: 'rgba(232,238,243,0.32)',
  tagBackground: RAISE,
  tagInk: INK,
  tagInkLight: T1,
  lastPrice: T1,
  lastPriceLine: 'rgba(232,238,243,0.55)',
  sessionSeparator: LINE,
  font: SANS,
  fontMono: SANS,
  fontFig: FIG,
  fontSize: FS_META,
  priceFontSize: FS_FIG_META,
  gridVertical: 'rgba(232,238,243,0)',
  upWick: UP,
  downWick: DOWN,
  upBorder: UP,
  downBorder: DOWN,
  upBar: UP,
  downBar: DOWN,
  lineSeries: T1,
  handles: null,
  flow: TESSERA_FLOW,
};

export function rgba(rgb: string, alpha: number): string {
  return `rgba(${rgb},${String(Math.round(alpha * 1000) / 1000)})`;
}
