import type {
  Alert,
  AlertDelivery,
  AlertOp,
  AlertStep,
  AlertsCreateInput,
  AlertsUpdateInput,
  EvaluateOn,
  FlowSide,
  Operand,
  Timeframe,
} from '@tessera/protocol';
import { timeframeParts } from '@tessera/protocol';

export type FormOp = AlertOp | 'sweep_above' | 'sweep_below';

export const FORM_OPS: readonly { value: FormOp; label: string }[] = [
  { value: 'crosses', label: 'Crosses' },
  { value: 'crosses_above', label: 'Crosses up' },
  { value: 'crosses_below', label: 'Crosses down' },
  { value: 'above', label: 'Is above' },
  { value: 'below', label: 'Is below' },
  { value: 'sweep_above', label: 'Sweeps above, back below' },
  { value: 'sweep_below', label: 'Sweeps below, back above' },
  { value: 'at_least', label: 'At least' },
];

export type Expiry = 'never' | 'keep' | '1h' | '4h' | '1d' | '1w';

const EXPIRY_MS: Record<Exclude<Expiry, 'never' | 'keep'>, number> = {
  '1h': 3_600_000,
  '4h': 4 * 3_600_000,
  '1d': 86_400_000,
  '1w': 7 * 86_400_000,
};

export const EXPIRIES: readonly { value: Exclude<Expiry, 'keep'>; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '1h', label: 'In 1 hour' },
  { value: '4h', label: 'In 4 hours' },
  { value: '1d', label: 'In 1 day' },
  { value: '1w', label: 'In 1 week' },
];

export const FORM_INTERVALS: readonly Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h'];

function alertsWatch(tf: Timeframe): boolean {
  const { unit } = timeframeParts(tf);
  return unit === 'm' || unit === 'h';
}

export interface OperandChoice {
  key: string;
  operand: Operand;
  label: string;
}

export interface AlertSeed {
  instrument: string;
  symbol: string;
  interval: Timeframe;
  decimals: number;
  tick: number;
  price: number | null;
  target?: OperandChoice;
  subject?: OperandChoice;
  more?: readonly OperandChoice[];
  op?: FormOp;
  count?: number;
}

export interface AlertForm {
  id: string | null;
  instrument: string;
  symbol: string;
  decimals: number;
  tick: number;
  interval: Timeframe;
  subject: string;
  op: FormOp;
  target: string;
  value: string;
  on: EvaluateOn;
  within: string;
  repeat: 'once' | 'every';
  cooldown: string;
  expiry: Expiry;
  message: string;
  deliver: AlertDelivery;
  askAnalyst: boolean;
  canAsk: boolean;
  choices: readonly OperandChoice[];
  fixed: { steps: AlertStep[]; title: string; within: number | null } | null;
}

export const PRICE: OperandChoice = { key: 'price', operand: { kind: 'price' }, label: 'Price' };
export const VALUE_KEY = 'value';

const SIDE_WORDS: Record<FlowSide, string> = { ask: ' at the ask', bid: ' at the bid', either: ', either side' };
const STACK_WORDS: Record<FlowSide, string> = {
  ask: 'a buy stack',
  bid: 'a sell stack',
  either: 'a stack, either side',
};

const FLOW_CHOICES: readonly OperandChoice[] = (['big_trade', 'print'] as const).flatMap((kind) =>
  (['ask', 'bid', 'either'] as const).map((side) => {
    const operand: Operand = { kind, side };
    return { key: operandKey(operand), operand, label: operandWords(operand) };
  }),
);

export function isEvent(o: Operand | undefined): boolean {
  return o?.kind === 'big_trade' || o?.kind === 'print' || o?.kind === 'stacked_imbalance';
}

function subjectOf(f: AlertForm): Operand | undefined {
  return f.choices.find((c) => c.key === f.subject)?.operand;
}

export function eventSubject(f: AlertForm): boolean {
  return isEvent(subjectOf(f));
}

export function stackSubject(f: AlertForm): boolean {
  return subjectOf(f)?.kind === 'stacked_imbalance';
}

function operandKey(o: Operand): string {
  switch (o.kind) {
    case 'price':
      return 'price';
    case 'value':
      return VALUE_KEY;
    case 'level':
      return `level:${o.provider ?? ''}:${o.key}`;
    case 'drawing':
      return `drawing:${o.drawingId}`;
    case 'indicator_line':
      return `line:${o.indicator}|${stable(o.inputs)}|${o.label}`;
    case 'plot':
      return `plot:${o.indicator}|${stable(o.inputs)}|${o.plot}`;
    case 'big_trade':
    case 'print':
      return `${o.kind}:${o.side}`;
    case 'stacked_imbalance':
      return `stack:${o.side}|${String(o.ratio)}|${String(o.minVolume)}|${String(o.minDifference)}|${String(o.includeZero)}|${String(o.rowTicks)}`;
  }
}

function stable(v: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(v)
      .sort()
      .map((k) => [k, v[k]]),
  );
}

function operandWords(o: Operand, decimals = 2): string {
  switch (o.kind) {
    case 'price':
      return 'Price';
    case 'value':
      return o.value.toFixed(decimals);
    case 'level':
      return o.label ?? o.key;
    case 'drawing':
      return o.label ?? 'Drawn line';
    case 'indicator_line':
      return o.name ? `${o.label} · ${o.name}` : o.label;
    case 'plot':
      return o.label ?? o.plot.toUpperCase();
    case 'big_trade':
      return `Big trade${SIDE_WORDS[o.side]}`;
    case 'print':
      return `One print${SIDE_WORDS[o.side]}`;
    case 'stacked_imbalance':
      return `Price back in ${STACK_WORDS[o.side]} (${String(o.ratio)}:1)`;
  }
}

function choiceOf(o: Operand, decimals: number): OperandChoice {
  return { key: operandKey(o), operand: o, label: operandWords(o, decimals) };
}

export function operandChoice(o: Operand, label: string = operandWords(o)): OperandChoice {
  return { key: operandKey(o), operand: o, label };
}

const needsClose = (o: Operand) => o.kind === 'plot';

function priceText(p: number | null, decimals: number): string {
  return p === null || !Number.isFinite(p) ? '' : p.toFixed(decimals);
}

function parsePrice(text: string): number | null {
  const t = text.replace(/[,\s\u202f]/g, '').replace('\u2212', '-');
  if (t === '' || !/^-?\d*\.?\d*$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function uniq(list: readonly OperandChoice[]): OperandChoice[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.key) && seen.add(c.key));
}

export function formFromSeed(seed: AlertSeed, deliver: AlertDelivery): AlertForm {
  const target = seed.target ?? null;
  const subject = seed.subject ?? PRICE;
  const choices = uniq([PRICE, ...(target ? [target] : []), subject, ...(seed.more ?? []), ...FLOW_CHOICES]);
  const plotInvolved = needsClose(subject.operand) || (target ? needsClose(target.operand) : false);
  if (isEvent(subject.operand)) {
    const blank = { ...formFromSeed({ ...seed, subject: PRICE, target: undefined }, deliver), choices };
    return { ...withSubject(blank, subject.key), ...(seed.count === undefined ? {} : { value: String(seed.count) }) };
  }
  return {
    id: null,
    instrument: seed.instrument,
    symbol: seed.symbol,
    decimals: seed.decimals,
    tick: seed.tick,
    interval: alertsWatch(seed.interval) ? seed.interval : '1m',
    subject: subject.key,
    op: seed.op ?? 'crosses',
    target: target?.key ?? VALUE_KEY,
    value: priceText(target ? null : seed.price, seed.decimals),
    on: plotInvolved ? 'bar_close' : 'trade',
    within: '3',
    repeat: 'once',
    cooldown: '60',
    expiry: 'never',
    message: '',
    deliver,
    askAnalyst: false,
    canAsk: false,
    choices,
    fixed: null,
  };
}

function sweepOf(steps: readonly AlertStep[]): { op: FormOp; target: Operand } | null {
  if (steps.length !== 2) return null;
  const [a, b] = steps as [AlertStep, AlertStep];
  if (a.subject.kind !== 'price' || b.subject.kind !== 'price') return null;
  if (operandKey(a.target) !== operandKey(b.target) || a.on !== 'trade' || b.on !== 'bar_close') return null;
  if (a.op === 'crosses_above' && b.op === 'below') return { op: 'sweep_above', target: a.target };
  if (a.op === 'crosses_below' && b.op === 'above') return { op: 'sweep_below', target: a.target };
  return null;
}

export function formFromAlert(
  a: Alert,
  opts: { symbol: string; decimals: number; tick: number; more?: readonly OperandChoice[] },
): AlertForm {
  const sweep = sweepOf(a.steps);
  const one = a.steps.length === 1 ? a.steps[0]! : null;
  const subject = one ? one.subject : { kind: 'price' as const };
  const target = sweep ? sweep.target : one ? one.target : null;
  const shown = [subject, ...(target ? [target] : [])].map((o) => choiceOf(o, opts.decimals));
  const choices = uniq([PRICE, ...shown.filter((c) => c.key !== VALUE_KEY), ...(opts.more ?? []), ...FLOW_CHOICES]);
  return {
    id: a.id,
    instrument: a.instrument,
    symbol: opts.symbol,
    decimals: opts.decimals,
    tick: opts.tick,
    interval: a.interval,
    subject: operandKey(subject),
    op: sweep ? sweep.op : (one?.op ?? 'crosses'),
    target: target ? operandKey(target) : VALUE_KEY,
    value:
      target?.kind === 'value'
        ? isEvent(subject)
          ? String(target.value)
          : priceText(target.value, opts.decimals)
        : '',
    on: one?.on ?? 'trade',
    within: String(a.withinBars ?? 3),
    repeat: a.repeat,
    cooldown: String(a.cooldownSecs),
    expiry: a.expiresAt === null ? 'never' : 'keep',
    message: a.message ?? '',
    deliver: a.deliver,
    askAnalyst: a.askAnalyst,
    canAsk: a.sessionId !== null,
    choices,
    fixed: sweep || one ? null : { steps: a.steps, title: a.title, within: a.withinBars },
  };
}

export function isSweep(op: FormOp): op is 'sweep_above' | 'sweep_below' {
  return op === 'sweep_above' || op === 'sweep_below';
}

export function readsPlot(f: AlertForm): boolean {
  const pick = (k: string) => f.choices.find((c) => c.key === k)?.operand;
  return [pick(f.subject), pick(f.target)].some((o) => o?.kind === 'plot');
}

export function usesInterval(f: AlertForm): boolean {
  if (f.fixed) return f.fixed.steps.some((s) => s.on === 'bar_close') || f.fixed.steps.length > 1;
  if (stackSubject(f)) return true;
  if (eventSubject(f)) return false;
  return f.on === 'bar_close' || isSweep(f.op) || readsPlot(f);
}

type Built<T> = { ok: T } | { error: string };

export function formSteps(f: AlertForm): Built<AlertStep[]> {
  if (f.fixed) return { ok: f.fixed.steps };
  const subject = f.choices.find((c) => c.key === f.subject)?.operand ?? { kind: 'price' as const };
  if (subject.kind === 'stacked_imbalance') {
    const rows = Number(f.value.trim());
    if (!Number.isInteger(rows) || rows < 1 || rows > STACK_MAX)
      return { error: `Type a stack of 1 to ${String(STACK_MAX)} rows` };
    return { ok: [{ subject, op: 'at_least', target: { kind: 'value', value: rows }, on: 'trade' }] };
  }
  if (isEvent(subject)) {
    const size = Number(f.value.trim());
    if (!Number.isInteger(size) || size < 1) return { error: 'Type a size of at least 1 contract' };
    return { ok: [{ subject, op: 'at_least', target: { kind: 'value', value: size }, on: 'trade' }] };
  }
  let target: Operand | null;
  if (f.target === VALUE_KEY) {
    const v = parsePrice(f.value);
    if (v === null) return { error: 'Type a price' };
    target = { kind: 'value', value: v };
  } else {
    target = f.choices.find((c) => c.key === f.target)?.operand ?? null;
  }
  if (!target) return { error: 'Pick what it watches' };
  if (operandKey(subject) === operandKey(target)) return { error: 'It compares two different things' };
  if (isSweep(f.op)) {
    if (subject.kind !== 'price') return { error: 'A sweep is the price’s' };
    const up = f.op === 'sweep_above';
    return {
      ok: [
        { subject, op: up ? 'crosses_above' : 'crosses_below', target, on: 'trade' },
        { subject, op: up ? 'below' : 'above', target, on: 'bar_close' },
      ],
    };
  }
  const plot = subject.kind === 'plot' || target.kind === 'plot';
  return { ok: [{ subject, op: f.op, target, on: plot ? 'bar_close' : f.on }] };
}

function positiveInt(text: string, min: number, max: number): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function toCreateInput(f: AlertForm, nowMs: number): Built<AlertsCreateInput> {
  const steps = formSteps(f);
  if ('error' in steps) return steps;
  const opts = options(f, nowMs);
  if ('error' in opts) return opts;
  return { ok: { instrument: f.instrument, steps: steps.ok, interval: f.interval, ...opts.ok } };
}

const REMOVE = 0;

export function toUpdateInput(f: AlertForm, nowMs: number): Built<AlertsUpdateInput> {
  if (!f.id) return { error: 'No alert' };
  const steps = formSteps(f);
  if ('error' in steps) return steps;
  const opts = options(f, nowMs);
  if ('error' in opts) return opts;
  const { expiresAt, ...rest } = opts.ok;
  return {
    ok: {
      id: f.id,
      ...(f.fixed ? {} : { steps: steps.ok }),
      interval: f.interval,
      ...rest,
      ...(f.expiry === 'keep' ? {} : { expiresAt: expiresAt ?? REMOVE }),
      withinBars: rest.withinBars ?? REMOVE,
      message: f.message.trim(),
      ...(f.canAsk ? { askAnalyst: f.askAnalyst } : {}),
    },
  };
}

interface Options {
  withinBars?: number;
  repeat: 'once' | 'every';
  cooldownSecs?: number;
  expiresAt?: number;
  message?: string;
  deliver: AlertDelivery;
}

function options(f: AlertForm, nowMs: number): Built<Options> {
  const sequence = f.fixed ? f.fixed.steps.length > 1 : isSweep(f.op);
  let withinBars: number | undefined;
  if (sequence) {
    const n = f.fixed && f.fixed.within !== null && f.within === String(f.fixed.within) ? f.fixed.within : null;
    withinBars = n ?? positiveInt(f.within, 1, 500) ?? undefined;
    if (withinBars === undefined) return { error: 'The window is 1 to 500 bars' };
  }
  let cooldownSecs: number | undefined;
  if (f.repeat === 'every') {
    cooldownSecs = positiveInt(f.cooldown, 0, 86_400) ?? undefined;
    if (cooldownSecs === undefined) return { error: 'The cool-down is 0 to 86,400 seconds' };
  }
  const message = f.message.trim();
  if (message.length > 500) return { error: 'A message is at most 500 characters' };
  const expiresAt = f.expiry === 'never' || f.expiry === 'keep' ? undefined : (nowMs + EXPIRY_MS[f.expiry]) * 1e6;
  return {
    ok: {
      ...(withinBars === undefined ? {} : { withinBars }),
      repeat: f.repeat,
      ...(cooldownSecs === undefined ? {} : { cooldownSecs }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(message ? { message } : {}),
      deliver: f.deliver,
    },
  };
}

export function withOp(f: AlertForm, op: FormOp): AlertForm {
  return isSweep(op) ? { ...f, op, subject: PRICE.key } : { ...f, op };
}

export function withTarget(f: AlertForm, key: string, price: number | null): AlertForm {
  const next = { ...f, target: key };
  if (key === VALUE_KEY && f.value === '') next.value = priceText(price, f.decimals);
  return readsPlot(next) ? { ...next, on: 'bar_close' } : next;
}

const DEFAULT_FLOW_SIZE = '50';
const DEFAULT_STACK = '3';
const STACK_MAX = 50;

export function withSubject(f: AlertForm, key: string): AlertForm {
  const chosen = f.choices.find((c) => c.key === key)?.operand;
  if (isEvent(chosen)) {
    const stack = chosen?.kind === 'stacked_imbalance';
    const keep = stack === stackSubject(f) && eventSubject(f) ? f.value : stack ? DEFAULT_STACK : DEFAULT_FLOW_SIZE;
    return { ...f, subject: key, op: 'at_least', target: VALUE_KEY, value: keep, on: 'trade' };
  }
  const op = (key !== PRICE.key && isSweep(f.op)) || f.op === 'at_least' ? ('crosses' as const) : f.op;
  const value = eventSubject(f) ? '' : f.value;
  const next = { ...f, subject: key, op, value };
  return readsPlot(next) ? { ...next, on: 'bar_close' } : next;
}

export function stepValue(f: AlertForm, ticks: number, fallback: number | null): AlertForm {
  const v = parsePrice(f.value) ?? fallback;
  if (v === null) return f;
  const next = Math.round(v / f.tick + ticks) * f.tick;
  return { ...f, value: priceText(next, f.decimals) };
}
