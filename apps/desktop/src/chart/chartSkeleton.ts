import { MIN_AXIS_W, TIME_AXIS_H, type ChartCoords, type Rect } from '@tessera/chart';

export const CHART_INITIAL_BARS = 150;
export const CHART_RIGHT_PAD_BARS = 8;

const MIN_CANDLE_STEP_PX = 10;
const PRICE_GRID_GAP_PX = 64;
const TIME_LABEL_GAP_PX = 112;
const TIME_LABEL_W = 30;
const LABEL_H = 8;
const AXIS_LABEL_INSET = 8;
const BODY_SHARE = 0.55;
const CANDLE_BAND = { top: 0.18, bottom: 0.72 };

export type FrameCoords = Pick<ChartCoords, 'plot' | 'panes' | 'priceAxis' | 'timeAxis'>;

export interface ChartFrame {
  width: number;
  height: number;
  main: Rect;
  panes: readonly Rect[];
  priceAxis: Rect;
  timeAxis: Rect;
}

interface SkeletonCandle {
  x: number;
  bodyTop: number;
  bodyH: number;
  bodyW: number;
  wickTop: number;
  wickH: number;
}

export interface ChartSketch {
  frame: ChartFrame;
  gridYs: readonly number[];
  priceLabels: readonly Rect[];
  timeLabels: readonly Rect[];
  candles: readonly SkeletonCandle[];
}

export function chartFrame(
  size: { width: number; height: number },
  coords: FrameCoords | null,
  axisWidth: number | null,
): ChartFrame {
  const { width, height } = size;
  const axisW = Math.min(width, axisWidth ?? coords?.priceAxis.w ?? MIN_AXIS_W);
  const timeH = Math.min(height, coords?.timeAxis.h ?? TIME_AXIS_H);
  const plotW = Math.max(0, width - axisW);
  const plotH = Math.max(0, height - timeH);
  const fitsCoords = coords !== null && coords.plot.h + paneHeight(coords) === coords.priceAxis.h;
  const panes = fitsCoords ? coords.panes.filter((p) => p.id !== 'main' && p.rect.h > 0).map((p) => p.rect) : [];
  const below = panes.reduce((sum, p) => sum + p.h, 0);
  const scale = fitsCoords && coords.priceAxis.h > 0 ? plotH / coords.priceAxis.h : 1;
  const mainH = Math.max(0, plotH - below * scale);
  let y = mainH;
  const scaled = panes.map((p) => {
    const rect = { x: 0, y, w: plotW, h: p.h * scale };
    y += rect.h;
    return rect;
  });
  return {
    width,
    height,
    main: { x: 0, y: 0, w: plotW, h: mainH },
    panes: scaled,
    priceAxis: { x: plotW, y: 0, w: axisW, h: plotH },
    timeAxis: { x: 0, y: plotH, w: plotW, h: timeH },
  };
}

function paneHeight(coords: FrameCoords): number {
  return coords.panes.filter((p) => p.id !== 'main').reduce((sum, p) => sum + p.rect.h, 0);
}

function noise(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff - 0.5;
}

function walk(length: number): number[] {
  const path: number[] = [];
  let level = 0;
  let drift = 0;
  for (let i = 0; i < length; i++) {
    drift = drift * 0.35 + noise(i);
    level += drift;
    path.push(level);
  }
  const lo = Math.min(...path);
  const span = Math.max(...path) - lo || 1;
  return path.map((v) => (v - lo) / span);
}

export function chartSketch(frame: ChartFrame): ChartSketch {
  const { main, priceAxis, timeAxis } = frame;
  const gridCount = Math.max(1, Math.round(main.h / PRICE_GRID_GAP_PX));
  const gap = main.h / gridCount;
  const gridYs = Array.from({ length: Math.max(0, gridCount - 1) }, (_, k) => Math.round(gap * (k + 1)));
  const labelW = Math.max(0, priceAxis.w - 2 * AXIS_LABEL_INSET);
  const priceLabels = gridYs.map((y) => ({
    x: priceAxis.x + AXIS_LABEL_INSET,
    y: y - LABEL_H / 2,
    w: labelW,
    h: LABEL_H,
  }));
  const timeCount = Math.floor(timeAxis.w / TIME_LABEL_GAP_PX);
  const timeLabels = Array.from({ length: Math.max(0, timeCount) }, (_, k) => ({
    x: Math.round(TIME_LABEL_GAP_PX * (k + 0.5) - TIME_LABEL_W / 2),
    y: timeAxis.y + Math.round((timeAxis.h - LABEL_H) / 2),
    w: TIME_LABEL_W,
    h: LABEL_H,
  }));
  return { frame, gridYs, priceLabels, timeLabels, candles: candlesIn(main) };
}

function candlesIn(main: Rect): SkeletonCandle[] {
  if (main.w <= 0 || main.h <= 0) return [];
  const barSpacing = main.w / (CHART_INITIAL_BARS + CHART_RIGHT_PAD_BARS);
  const step = barSpacing * Math.max(1, Math.ceil(MIN_CANDLE_STEP_PX / barSpacing));
  const bodyW = Math.max(3, Math.round(step * BODY_SHARE));
  const top = main.y + main.h * CANDLE_BAND.top;
  const span = main.h * (CANDLE_BAND.bottom - CANDLE_BAND.top);
  const right = main.w - CHART_RIGHT_PAD_BARS * barSpacing;
  const count = Math.max(0, Math.floor((right - bodyW / 2) / step));
  const path = walk(count + 1);
  const y = (k: number) => top + span * (1 - path[k]!);
  const out: SkeletonCandle[] = [];
  for (let k = 0; k < count; k++) {
    const open = y(k);
    const close = y(k + 1);
    const reach = span * 0.04 * (1 + Math.abs(noise(k + 977)) * 2);
    const bodyTop = Math.min(open, close);
    const bodyH = Math.max(2, Math.abs(close - open));
    out.push({
      x: Math.round(right - step * (count - k - 0.5) - bodyW / 2),
      bodyTop: Math.round(bodyTop),
      bodyH: Math.round(bodyH),
      bodyW,
      wickTop: Math.round(bodyTop - reach),
      wickH: Math.round(bodyH + reach * 2),
    });
  }
  return out;
}

const AXIS_MEMORY_KEY = 'tessera:chart-axis-widths';

function storedAxisWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(AXIS_MEMORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function rememberedAxisWidth(instrument: string): number | null {
  const w = storedAxisWidths()[instrument];
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null;
}

export function rememberAxisWidth(instrument: string, width: number): void {
  if (!Number.isFinite(width) || width <= 0) return;
  const all = storedAxisWidths();
  if (all[instrument] === width) return;
  try {
    localStorage.setItem(AXIS_MEMORY_KEY, JSON.stringify({ ...all, [instrument]: width }));
  } catch {
    return;
  }
}
