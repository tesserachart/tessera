import {
  compareTimeframes,
  parseTimeframe,
  TIMEFRAME_PRESETS,
  type PrintBars,
  type Timeframe,
} from '@tessera/protocol';

export const CHART_TIMEFRAMES: readonly Timeframe[] = TIMEFRAME_PRESETS;

export const PRINT_BAR_CHOICES: readonly PrintBars[] = [
  { kind: 'tick', size: 100 },
  { kind: 'tick', size: 500 },
  { kind: 'tick', size: 1000 },
  { kind: 'range', size: 4 },
  { kind: 'range', size: 10 },
  { kind: 'range', size: 20 },
  { kind: 'volume', size: 1000 },
  { kind: 'volume', size: 5000 },
  { kind: 'delta', size: 100 },
  { kind: 'delta', size: 300 },
  { kind: 'delta', size: 500 },
  { kind: 'renko', size: 4 },
  { kind: 'renko', size: 10 },
  { kind: 'renko', size: 20 },
];

export const PRINT_BAR_KINDS: readonly PrintBars['kind'][] = ['tick', 'range', 'volume', 'delta', 'renko'];

const PRINT_BAR_LETTER: Record<PrintBars['kind'], string> = {
  tick: 'T',
  range: 'R',
  volume: 'V',
  delta: 'Δ',
  renko: 'Rk',
};
const PRINT_BAR_NOUN: Record<PrintBars['kind'], string> = {
  tick: 'ticks',
  range: 'ticks range',
  volume: 'contracts',
  delta: 'delta',
  renko: 'ticks renko',
};
const PRINT_BAR_GROUP: Record<PrintBars['kind'], string> = {
  tick: 'Tick bars',
  range: 'Range bars',
  volume: 'Volume bars',
  delta: 'Delta bars',
  renko: 'Renko',
};

export function printBarsGroup(kind: PrintBars['kind']): string {
  return PRINT_BAR_GROUP[kind];
}

export function printBarsKey(b: PrintBars): string {
  return `${b.kind}:${String(b.size)}`;
}

export function printBarsShort(b: PrintBars): string {
  return `${String(b.size)}${PRINT_BAR_LETTER[b.kind]}`;
}

export function printBarsWords(b: PrintBars): string {
  return `${b.size.toLocaleString('en-US')} ${PRINT_BAR_NOUN[b.kind]}`;
}

export function printBarChoices(kind: PrintBars['kind'], extra: readonly Interval[]): PrintBars[] {
  const all = [...PRINT_BAR_CHOICES];
  for (const i of extra) {
    if (i.printBars && !all.some((b) => printBarsKey(b) === printBarsKey(i.printBars))) all.push(i.printBars);
  }
  return all.filter((b) => b.kind === kind).sort((a, b) => a.size - b.size);
}

const PRINT_BAR_SIZE_MAX = 100_000;

const PRINT_BAR_WORDS: Record<string, PrintBars['kind']> = {
  t: 'tick',
  tick: 'tick',
  ticks: 'tick',
  r: 'range',
  range: 'range',
  v: 'volume',
  vol: 'volume',
  volume: 'volume',
  contracts: 'volume',
  δ: 'delta',
  delta: 'delta',
  rk: 'renko',
  renko: 'renko',
};

export type Interval = { tf: Timeframe; printBars: null } | { tf: null; printBars: PrintBars };

export function parseInterval(text: string): Interval | null {
  const m = /^(\d+)\s*([a-zδ]+)$/.exec(text.trim().toLowerCase().replaceAll(',', ''));
  const kind = m ? PRINT_BAR_WORDS[m[2]!] : undefined;
  if (m && kind) {
    const size = Number(m[1]);
    return size >= 1 && size <= PRINT_BAR_SIZE_MAX ? { tf: null, printBars: { kind, size } } : null;
  }
  const tf = parseTimeframe(text);
  return tf ? { tf, printBars: null } : null;
}

export function withPresets(current: readonly (Timeframe | null | undefined)[]): Timeframe[] {
  const extra = current.filter((t): t is Timeframe => !!t && !CHART_TIMEFRAMES.includes(t));
  return [...new Set([...CHART_TIMEFRAMES, ...extra])].sort(compareTimeframes);
}

export function intervalOf(tf: Timeframe, printBars: PrintBars | null): Interval {
  return printBars ? { tf: null, printBars } : { tf, printBars: null };
}

export function intervalText(i: Interval): string {
  return i.printBars ? printBarsShort(i.printBars) : i.tf;
}

function compareIntervals(a: Interval, b: Interval): number {
  if (!a.printBars && !b.printBars) return compareTimeframes(a.tf, b.tf);
  if (!a.printBars) return -1;
  if (!b.printBars) return 1;
  return (
    PRINT_BAR_KINDS.indexOf(a.printBars.kind) - PRINT_BAR_KINDS.indexOf(b.printBars.kind) ||
    a.printBars.size - b.printBars.size
  );
}

export function intervalsOf(texts: readonly (string | null | undefined)[]): Interval[] {
  const seen = new Map<string, Interval>();
  for (const t of texts) {
    const i = t ? parseInterval(t) : null;
    if (i) seen.set(intervalText(i), i);
  }
  return [...seen.values()].sort(compareIntervals);
}

export function savedIntervalTexts(texts: readonly string[]): string[] {
  return intervalsOf(texts).map(intervalText);
}

export function tabRowChoices(saved: readonly string[], current: Interval | null): Interval[] {
  return intervalsOf([...CHART_TIMEFRAMES, ...saved, current ? intervalText(current) : null]);
}

export const FIRST_PRINT_BAR_SESSIONS = 2;

export const MAX_PRINT_BAR_SESSIONS = 5;
