export type InputValue = number | string | boolean;
export type IndicatorInputs = Readonly<Record<string, InputValue>>;

export interface IndicatorPlotDef {
  readonly key: string;
  readonly label: string;
  readonly kind: 'line' | 'histogram' | 'hline';
  readonly colorBy?: 'direction' | 'sign' | null;
  readonly value?: number | null;
  readonly valueInput?: string | null;
}

export interface IndicatorFillDef {
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

export interface IndicatorDef {
  readonly kind: string;
  readonly short: string;
  readonly placement: 'overlay' | 'pane';
  readonly plots: readonly IndicatorPlotDef[];
  readonly fills: readonly IndicatorFillDef[];
  readonly range?: readonly number[] | null;
  readonly sessionReset: boolean;
  readonly resetBy?: string | null;
  readonly format: 'price' | 'volume' | 'number';
}

export interface PlotStyle {
  readonly color: string;
  readonly downColor?: string | null;
  readonly width: number;
  readonly line: 'solid' | 'dash' | 'dot';
  readonly opacity: number;
  readonly visible: boolean;
}

export interface FillStyle {
  readonly color: string;
  readonly opacity: number;
  readonly visible: boolean;
}

export interface IndicatorLabels {
  readonly priceScale: boolean;
  readonly name: boolean;
  readonly value: boolean;
}

export interface IndicatorStyle {
  readonly plots: Readonly<Record<string, PlotStyle>>;
  readonly fills: Readonly<Record<string, FillStyle>>;
  readonly labels?: IndicatorLabels;
}

export function defaultLabels(def: Pick<IndicatorDef, 'placement'>): IndicatorLabels {
  return { priceScale: def.placement === 'pane', name: false, value: false };
}

export const DEFAULT_PLOT_STYLE: PlotStyle = {
  color: '#aebcc8',
  width: 1,
  line: 'solid',
  opacity: 1,
  visible: true,
};

export function dashOf(line: PlotStyle['line'], width = 1): number[] {
  if (line === 'dash') return [5 * Math.max(1, width * 0.8), 4];
  if (line === 'dot') return [Math.max(1, width), 3];
  return [];
}
