import { type IndicatorLayer, type InputValue, type PriceFormatter } from '@tessera/chart';
import type { ChartLayer, IndicatorInput, IndicatorSpec } from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { indicatorName as nameOf, indicatorSummary, layerSpec, resolveIndicator } from '../indicators.ts';
import { indicatorLayerId } from '../layers/indicators.ts';
import { zoneOffsetMs } from '../../state/timeZone.ts';

export function stepDecimals(step: number | null | undefined): number {
  if (!step || step >= 1) return 0;
  return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
}

export function parseNumber(
  text: string,
  o: { min?: number | null; max?: number | null; integer?: boolean },
): number | null {
  const t = text.trim().replace(/,/g, '').replace(/^−/, '-');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  if (o.integer && !Number.isInteger(v)) return null;
  if (o.min !== null && o.min !== undefined && v < o.min) return null;
  if (o.max !== null && o.max !== undefined && v > o.max) return null;
  return v;
}

export function stepNumber(
  value: number,
  n: number,
  o: { step?: number | null; min?: number | null; max?: number | null },
): number {
  const step = o.step ?? 1;
  const d = stepDecimals(step);
  const v = Number((value + n * step).toFixed(d));
  return Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
}

const SWATCH_NAMES: Record<string, string> = {
  mist: 'Mist',
  t1: 'White',
  t2: 'Light grey',
  t3: 'Grey',
  t4: 'Dark grey',
  up: 'Up',
  down: 'Down',
  brass: 'Brass',
  teal: 'Teal',
};

export function colorName(c: string): string {
  return SWATCH_NAMES[c] ?? c.toLowerCase();
}

export const WIDTHS = [1, 1.5, 2, 3, 4] as const;

export const SOURCE_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'high', label: 'High' },
  { value: 'low', label: 'Low' },
  { value: 'close', label: 'Close' },
  { value: 'hl2', label: 'HL/2' },
  { value: 'hlc3', label: 'HLC/3' },
  { value: 'ohlc4', label: 'OHLC/4' },
] as const;

export interface InputRow {
  input: IndicatorInput;
  paired?: IndicatorInput;
  under?: readonly IndicatorInput[];
}

export function inputRows(inputs: readonly IndicatorInput[]): InputRow[] {
  const rows: InputRow[] = [];
  for (let k = 0; k < inputs.length; k++) {
    const i = inputs[k]!;
    const next = inputs[k + 1];
    if (i.when || (i.type === 'enum' && (i.options?.length ?? 0) < 2)) continue;
    const under = i.type === 'enum' ? inputs.filter((u) => u.when?.input === i.key) : [];
    if (under.length > 0) rows.push({ input: i, under });
    else if (
      i.type === 'bool' &&
      next &&
      (next.type === 'number' || next.type === 'int') &&
      next.label.startsWith(`${i.label} `)
    ) {
      rows.push({ input: i, paired: next });
      k++;
    } else rows.push({ input: i });
  }
  return rows;
}

export function shownUnder(row: InputRow, value: InputValue | undefined): IndicatorInput[] {
  const v = String(value ?? row.input.default);
  return (row.under ?? []).filter((u) => u.when?.values.includes(v) === true);
}

export function liveOptionNotes(
  input: IndicatorInput,
  notes: Readonly<Record<string, string>> | undefined,
): string | null {
  if (!input.segmented) return null;
  const live = (input.options ?? []).flatMap((o) => {
    const note = notes?.[`${input.key}.${o.value}`];
    return note ? [`${o.label} ${note}`] : [];
  });
  return live.length > 0 ? live.join(' · ') : null;
}

export function paneOf(layerId: string): string {
  return `pane:${indicatorLayerId(layerId)}`;
}

export function legendPanes(
  entries: readonly { layer: ChartLayer; spec: IndicatorSpec }[],
  panes: readonly string[],
): { pane: string; ids: string[] }[] {
  const main: string[] = [];
  const own = new Map<string, string[]>();
  for (const e of entries) {
    const pane = paneOf(e.layer.id);
    if (e.spec.placement === 'pane' && e.layer.visible && panes.includes(pane)) own.set(pane, [e.layer.id]);
    else main.push(e.layer.id);
  }
  const out = [{ pane: 'main', ids: main }];
  for (const p of panes) {
    const ids = own.get(p);
    if (ids) out.push({ pane: p, ids });
  }
  return out;
}

const LABEL_INKS = new Set([TOKENS.t3, TOKENS.t3Raised, TOKENS.t4Fig, TOKENS.t4].map((c) => c.toLowerCase()));

export function valueInk(color: string): string {
  return LABEL_INKS.has(color.toLowerCase()) ? TOKENS.t2 : color;
}

export function rowValues(
  drawn: IndicatorLayer,
  index: number,
  format: PriceFormatter,
  down: (index: number) => boolean,
  max = Infinity,
): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  for (const p of drawn.def.plots) {
    if (out.length >= max) break;
    if (p.kind === 'hline') continue;
    const st = drawn.plotStyle(p.key);
    if (!st.visible) continue;
    const v = drawn.valueAt(p.key, index);
    if (!Number.isFinite(v)) continue;
    const isDown = p.colorBy === 'direction' ? down(index) : p.colorBy === 'sign' ? v < 0 : false;
    out.push({ text: drawn.formatValue(v, format), color: valueInk(isDown ? (st.downColor ?? st.color) : st.color) });
  }
  return out;
}

export function indicatorName(layer: ChartLayer): string | null {
  const spec = layerSpec(layer);
  if (!spec) return null;
  const inputs = resolveIndicator(spec, layer.params).inputs;
  const summary = indicatorSummary(spec, inputs);
  const name = nameOf(spec, inputs);
  return summary ? `${name} ${summary}` : name;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function studyTimeText(value: string, zone: string): string {
  const ms = value === '' ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + zoneOffsetMs(zone, ms));
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function parseStudyTime(text: string, zone: string): string | null {
  const t = text.trim();
  if (t === '') return '';
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const guess = wall - zoneOffsetMs(zone, wall);
  return new Date(wall - zoneOffsetMs(zone, guess)).toISOString();
}
