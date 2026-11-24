import type { PriceFormatter } from '../format.ts';
import type { SessionModel } from '../session.ts';
import type { DataChange, SeriesStore } from '../store.ts';
import type { ChartTheme, LayerKind, PaneId, Rect, SurfaceKind, TimeSpan } from '../types.ts';
import type { BarsInView } from './missingPrints.ts';
import type { PixelColumns } from '../render/columns.ts';

export type Ctx2D = CanvasRenderingContext2D;

export interface ChartLayout {
  width: number;
  height: number;
  main: Rect;
  volume: Rect | null;
  panes: readonly { id: PaneId; rect: Rect }[];
  priceAxis: Rect;
  timeAxis: Rect;
}

export interface TimeView {
  from: number;
  to: number;
  barSpacing: number;
  xOfIndex(index: number): number;
  indexOfX(x: number): number;
  xOfTime(timeMs: number): number;
}

export interface PriceView {
  min: number;
  max: number;
  yOf(price: number): number;
  priceOf(y: number): number;
}

export interface AxisTag {
  price: number;
  text: string;
  sub?: string;
  style: 'filled' | 'outline' | 'neutral';
  color: string;
  priority: number;
  dashed?: boolean;
  transient?: boolean;
  pane?: PaneId;
}

export interface FigureColumn {
  readonly index: number;
  readonly left: number;
  readonly right: number;
}

export interface LabelClaim {
  y: number;
  h: number;
  edge: 'left' | 'right';
}

export interface CrosshairState {
  x: number;
  y: number;
  index: number;
  price: number;
  pane: PaneId;
  value: number;
}

export interface RenderContext {
  readonly ctx: Ctx2D;
  readonly dpr: number;
  readonly theme: ChartTheme;
  readonly layout: ChartLayout;
  readonly pane: Rect;
  readonly store: SeriesStore;
  readonly session: SessionModel;
  readonly time: TimeView;
  readonly price: PriceView;
  readonly mainPrice: PriceView;
  readonly format: PriceFormatter;
  readonly timeframeMs: number;
  readonly now: number;
  readonly crosshair: CrosshairState | null;
  addAxisTag(tag: AxisTag): void;
  formatPaneValue(pane: PaneId, value: number): string;
  readonly labelClaims: readonly LabelClaim[];
  readonly interacting: boolean;
  readonly seriesReplaced: boolean;
  readonly gutter: Rect | null;
  readonly figures: readonly FigureColumn[];
  readonly columns: PixelColumns | null;
}

export type GpuRenderContext = Omit<RenderContext, 'ctx' | 'addAxisTag' | 'labelClaims' | 'figures' | 'columns'> & {
  readonly gpu: GpuSurface;
};

export interface ViewHints {
  maxBarSpacing?: number;
}

export interface LayerPointerEvent {
  type: 'down' | 'move' | 'up' | 'hover' | 'leave' | 'dblclick';
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  cmdOrCtrl: boolean;
}

export interface LayerHost {
  invalidate(kind?: 'data'): void;
  relayout(): void;
}

export interface Layer {
  readonly id: string;
  readonly kind: LayerKind;
  readonly surface: SurfaceKind;
  readonly pane?: PaneId;
  readonly z?: number;
  readonly provider?: string | null;
  readonly owner?: string | null;
  readonly settingsSchema?: Record<string, unknown> | null;
  readonly visible?: boolean;
  draw(rc: RenderContext): void;
  hitTest?(x: number, y: number, rc: RenderContext): { objectId: string; distance: number } | null;
  labelClaims?(rc: RenderContext): readonly LabelClaim[];
  gutter?(rc: RenderContext): number;
  figureColumns?(rc: RenderContext): readonly FigureColumn[];
  onData?(change: DataChange, store: SeriesStore, session: SessionModel): void;
  autoscaleRange?(from: number, to: number): [number, number] | null;
  readonly autoscaleMargins?: { top: number; bottom: number };
  autoscaleReserve?(barSpacing: number, paneH: number): number;
  readonly paneHeight?: number | undefined;
  readonly paneOrder?: number | undefined;
  axisMarks?(): readonly number[];
  missingPrints?(bars: BarsInView): readonly TimeSpan[];
  readonly fixedRange?: boolean;
  formatValue?(value: number, price: PriceFormatter): string;
  pointer?(e: LayerPointerEvent, rc: RenderContext): boolean;
  cursor?(x: number, y: number, rc: RenderContext): string | null;
  keyDown?(key: string): boolean;
  attach?(host: LayerHost): void;
  detach?(): void;
  viewHints?(): ViewHints;
  replacesSeries?(rc: RenderContext): boolean;
  onViewSettled?(): void;
  drawGpu?(rc: GpuRenderContext): void;
}

export type LayerClass<T extends Layer> = abstract new (...args: never[]) => T;

export type GpuTextureFormat = 'r16f' | 'rgba8';

export interface GpuSurface {
  readonly gl: WebGL2RenderingContext;
  readonly width: number;
  readonly height: number;
  readonly generation: number;
  texture(
    key: string,
    width: number,
    height: number,
    format: GpuTextureFormat,
    data: Uint16Array | Uint8Array,
    version?: number,
  ): WebGLTexture;
  has(key: string, version?: number): boolean;
  readonly uploadBudget: number;
  release(key: string): void;
  program(key: string, vertex: string, fragment: string): WebGLProgram;
}
