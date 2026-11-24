import type { CanvasLike } from '../engine.ts';
import { MINUS, type PriceFormatter } from '../format.ts';
import type { ChartTheme, TimeSpan } from '../types.ts';

export interface LegendValue {
  text: string;
  color: string;
}

export interface LegendNote {
  text: string;
}

export interface LegendNotice {
  readonly text: string;
  readonly short: string;
  readonly least: string;
}

export interface FlowReadout {
  legendValues(index: number, format: PriceFormatter, theme: ChartTheme): LegendValue[];
  legendNote(): LegendNote | null;
  legendNotice?(): LegendNotice | null;
  reading(): boolean;
  legendSuffix(): string;
  aggressorNote(): string | null;
  optionNotes?(): Readonly<Record<string, string>> | null;
}

export function isFlowReadout(layer: unknown): layer is FlowReadout {
  return (
    typeof layer === 'object' &&
    layer !== null &&
    typeof (layer as Partial<FlowReadout>).legendValues === 'function' &&
    typeof (layer as Partial<FlowReadout>).legendNote === 'function'
  );
}

export interface AskTarget {
  kind: 'bar' | 'profile' | 'bubble';
  label: string;
  from: number;
  to: number;
  low: number;
  high: number;
  detail?: string;
}

export interface AskSource {
  askTarget(x: number, y: number): AskTarget | null;
}

export function isAskSource(layer: unknown): layer is AskSource {
  return typeof layer === 'object' && layer !== null && typeof (layer as Partial<AskSource>).askTarget === 'function';
}

export const STOPPED_ALPHA = 0.6;

export const NO_GAPS: readonly TimeSpan[] = [];

export class FlowState {
  note: LegendNote | null = null;
  notice: LegendNotice | null = null;
  aggressor: string | null = null;
  reading = false;

  read(reading: boolean): void {
    this.note = null;
    this.reading = reading;
  }

  stop(words: string): void {
    this.note = { text: words };
    this.reading = false;
  }

  clear(): void {
    this.note = null;
    this.notice = null;
    this.reading = false;
  }

  get stopped(): boolean {
    return this.note !== null;
  }
}

export function aggressorNoteOf(source: string | null | undefined, provider?: string | null): string | null {
  const by = provider ? ` · ${provider}` : '';
  if (source === 'inferred') return `Buy/sell side inferred from the quote, not the exchange's flag${by}`;
  if (source === 'replay_mapped') return `Buy/sell side mapped from a replay${by}`;
  return null;
}

export type CanvasFactory = (width: number, height: number) => CanvasLike;

export function defaultCanvasFactory(): CanvasFactory | null {
  if (typeof document === 'undefined') return null;
  return (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };
}

export function signedCount(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.round(Math.abs(v));
  const body = a.toLocaleString('en-US');
  return v < 0 && a !== 0 ? `${MINUS}${body}` : a === 0 ? '0' : `+${body}`;
}
