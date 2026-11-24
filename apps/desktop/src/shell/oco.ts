import type { Bracket, ContractSpec, OrderRequest, Side } from '@tessera/protocol';
import { formatMoney, formatPrice } from '@tessera/ui';
import { toTick, type EntryKind } from './ticket.ts';

export type OcoUnit = 'ticks' | 'points' | 'usd' | 'pct';

export const OCO_UNITS: readonly OcoUnit[] = ['ticks', 'points', 'usd', 'pct'];
export const UNIT_WORD: Record<OcoUnit, string> = { ticks: 'Ticks', points: 'Points', usd: '$', pct: '%' };
const UNIT_STEP: Record<OcoUnit, number> = { ticks: 1, points: 0.25, usd: 5, pct: 0.05 };

export interface OcoLeg {
  on: boolean;
  unit: OcoUnit;
  value: number;
}

export interface OcoConfig {
  on: boolean;
  stop: OcoLeg;
  target: OcoLeg;
  breakeven: { on: boolean; trigger: number; offset: number };
  trail: { on: boolean; ticks: number; trigger: number; step: number };
}

export const DEFAULT_OCO: OcoConfig = {
  on: false,
  stop: { on: true, unit: 'ticks', value: 40 },
  target: { on: true, unit: 'ticks', value: 80 },
  breakeven: { on: false, trigger: 20, offset: 1 },
  trail: { on: false, ticks: 20, trigger: 0, step: 1 },
};

export interface ContractMath {
  tick: number;
  tickValue: number;
  decimals: number;
}

export function contractMath(spec: Pick<ContractSpec, 'tickSize' | 'tickValue' | 'priceDecimals'>): ContractMath {
  return { tick: spec.tickSize, tickValue: spec.tickValue.amount, decimals: spec.priceDecimals };
}

export interface OcoMarket extends ContractMath {
  qty: number;
  balance: number | null;
}

function floorish(x: number): number {
  return Math.floor(x + 1e-9);
}

export function tickMoney(m: OcoMarket): number {
  return m.tickValue * m.qty;
}

export function legTicks(leg: OcoLeg, m: OcoMarket): { ticks: number | null; error: string | null } {
  const v = leg.value;
  if (!Number.isFinite(v) || v <= 0) return { ticks: null, error: 'Enter a distance' };
  let ticks: number;
  switch (leg.unit) {
    case 'ticks':
      ticks = Math.round(v);
      break;
    case 'points':
      ticks = floorish(v / m.tick);
      break;
    case 'usd': {
      const per = tickMoney(m);
      if (!(per > 0)) return { ticks: null, error: 'No tick value for $' };
      ticks = floorish(v / per);
      break;
    }
    case 'pct': {
      const per = tickMoney(m);
      if (m.balance === null || !(m.balance > 0)) return { ticks: null, error: 'No balance for %' };
      if (!(per > 0)) return { ticks: null, error: 'No tick value for %' };
      ticks = floorish((m.balance * v) / 100 / per);
      break;
    }
  }
  if (ticks < 1) {
    const one = formatMoney(tickMoney(m));
    return { ticks: null, error: `Under 1 tick (one tick is ${one} at ${String(m.qty)})` };
  }
  return { ticks, error: null };
}

export function legMoney(leg: OcoLeg, balance: number | null): number | null {
  const v = leg.value;
  if (!Number.isFinite(v) || v <= 0) return null;
  if (leg.unit === 'usd') return v;
  if (leg.unit === 'pct') return balance !== null && balance > 0 ? (balance * v) / 100 : null;
  return null;
}

export function moneyTicks(money: number, tickValue: number, qty: number): number {
  const per = tickValue * qty;
  return per > 0 ? Math.max(1, floorish(money / per)) : 1;
}

export function legFigures(
  ticks: number,
  m: OcoMarket,
): { ticks: number; points: number; usd: number; pct: number | null } {
  const usd = ticks * tickMoney(m);
  return {
    ticks,
    points: ticks * m.tick,
    usd,
    pct: m.balance !== null && m.balance > 0 ? (usd / m.balance) * 100 : null,
  };
}

export function legPrice(side: Side, role: 'stop' | 'target', entry: number, ticks: number, tick: number): number {
  const dir = side === 'buy' ? 1 : -1;
  const sign = role === 'stop' ? -dir : dir;
  return toTick(entry + sign * ticks * tick, tick);
}

export function convertLeg(leg: OcoLeg, unit: OcoUnit, m: OcoMarket): OcoLeg {
  if (unit === leg.unit) return leg;
  const { ticks } = legTicks(leg, m);
  if (ticks === null) return { ...leg, unit, value: unit === 'ticks' ? 1 : UNIT_STEP[unit] };
  const f = legFigures(ticks, m);
  const step = UNIT_STEP[unit];
  const raw = unit === 'ticks' ? f.ticks : unit === 'points' ? f.points : unit === 'usd' ? f.usd : (f.pct ?? 0);
  const value = unit === 'usd' ? Math.round(raw * 100) / 100 : unit === 'pct' ? Math.round(raw * 10000) / 10000 : raw;
  return { ...leg, unit, value: value > 0 ? value : step };
}

export function stepLeg(leg: OcoLeg, n: number): OcoLeg {
  const step = UNIT_STEP[leg.unit];
  const next = Math.round((leg.value + n * step) / step) * step;
  return { ...leg, value: Math.max(step, Number(next.toFixed(6))) };
}

export function legReadout(ticks: number, m: OcoMarket, price: number | null): string {
  const f = legFigures(ticks, m);
  const parts: string[] = [];
  if (price !== null) parts.push(formatPrice(price, m.decimals));
  parts.push(`${String(f.ticks)} ${f.ticks === 1 ? 'tick' : 'ticks'}`);
  parts.push(`${formatPrice(f.points, Math.max(2, m.decimals))} pts`);
  parts.push(formatMoney(f.usd));
  if (f.pct !== null && m.balance !== null) parts.push(`${f.pct.toFixed(2)}% of ${formatMoney(m.balance)}`);
  return parts.join(' · ');
}

export interface OcoPlan {
  stopTicks: number | null;
  targetTicks: number | null;
  errors: { stop?: string; target?: string; rules?: string };
}

export function planOco(oco: OcoConfig, m: OcoMarket): OcoPlan {
  const errors: OcoPlan['errors'] = {};
  if (!oco.on) return { stopTicks: null, targetTicks: null, errors };
  let stopTicks: number | null = null;
  let targetTicks: number | null = null;
  if (oco.stop.on) {
    const s = legTicks(oco.stop, m);
    stopTicks = s.ticks;
    if (s.error) errors.stop = s.error;
  }
  if (oco.target.on) {
    const t = legTicks(oco.target, m);
    targetTicks = t.ticks;
    if (t.error) errors.target = t.error;
  }
  const rules: string[] = [];
  if ((oco.breakeven.on || oco.trail.on) && !oco.stop.on) rules.push('Breakeven and trailing need the stop');
  if (oco.breakeven.on) {
    if (!(oco.breakeven.trigger >= 1)) rules.push('Breakeven trigger under 1 tick');
    else if (!(oco.breakeven.offset >= 0) || oco.breakeven.offset >= oco.breakeven.trigger)
      rules.push('Breakeven offset must be below its trigger');
  }
  if (oco.trail.on) {
    if (!(oco.trail.ticks >= 1)) rules.push('Trailing under 1 tick');
    if (!(oco.trail.trigger >= 0)) rules.push('Trailing start below the entry');
    if (!(oco.trail.step >= 1)) rules.push('Trailing step under 1 tick');
  }
  if (rules.length) errors.rules = rules.join(' · ');
  return { stopTicks, targetTicks, errors };
}

export function planOk(plan: OcoPlan): boolean {
  return !plan.errors.stop && !plan.errors.target && !plan.errors.rules;
}

export type LegsFrom = number | 'fill';

export function tickLegs(
  side: Side,
  from: LegsFrom,
  tick: number,
  ticks: { stop: number | null; target: number | null },
): Bracket {
  if (from === 'fill') {
    return {
      stopLoss: null,
      takeProfit: null,
      ...(ticks.stop !== null ? { stopTicks: ticks.stop } : {}),
      ...(ticks.target !== null ? { targetTicks: ticks.target } : {}),
    };
  }
  return {
    stopLoss: ticks.stop !== null ? legPrice(side, 'stop', from, ticks.stop, tick) : null,
    takeProfit: ticks.target !== null ? legPrice(side, 'target', from, ticks.target, tick) : null,
  };
}

export function ocoBracket(side: Side, from: LegsFrom | null, oco: OcoConfig, m: OcoMarket): Bracket | null {
  if (!oco.on || from === null) return null;
  const plan = planOco(oco, m);
  if (plan.stopTicks === null && plan.targetTicks === null) return null;
  const b = tickLegs(side, from, m.tick, { stop: plan.stopTicks, target: plan.targetTicks });
  if (plan.stopTicks !== null && oco.breakeven.on) {
    b.breakeven = { triggerTicks: Math.round(oco.breakeven.trigger), offsetTicks: Math.round(oco.breakeven.offset) };
  }
  if (plan.stopTicks !== null && oco.trail.on) {
    b.trail = {
      distanceTicks: Math.round(oco.trail.ticks),
      triggerTicks: Math.round(oco.trail.trigger),
      stepTicks: Math.round(oco.trail.step),
    };
  }
  return b;
}

function crosses(side: Side, price: number, touch: number): boolean {
  return side === 'buy' ? touch <= price : touch >= price;
}

export function expectedFill(side: Side, kind: EntryKind, price: number | null, touch: number | null): number | null {
  if (kind === 'market') return touch;
  if (kind === 'limit' && price !== null && touch !== null) return crosses(side, price, touch) ? touch : price;
  return price;
}

export function legsFrom(side: Side, kind: EntryKind, price: number | null, touch: number | null): LegsFrom | null {
  if (kind === 'market' || kind === 'stop') return 'fill';
  if (kind === 'limit' && price !== null && touch !== null && crosses(side, price, touch)) return 'fill';
  return price;
}

export function entryBracket(
  side: Side,
  kind: EntryKind,
  price: number | null,
  touch: number | null,
  oco: OcoConfig,
  m: OcoMarket,
): Bracket | null {
  return ocoBracket(side, legsFrom(side, kind, price, touch), oco, m);
}

export function legAt(
  b: Bracket,
  role: 'stop' | 'target',
  side: Side,
  from: number | null,
  tick: number,
): number | null {
  const price = role === 'stop' ? b.stopLoss : b.takeProfit;
  if (price !== null) return price;
  const ticks = role === 'stop' ? b.stopTicks : b.targetTicks;
  return ticks !== undefined && from !== null ? legPrice(side, role, from, ticks, tick) : null;
}

export function withLegPrice(b: Bracket, role: 'stop' | 'target', price: number | null): Bracket {
  const { stopTicks, targetTicks, ...rest } = b;
  return role === 'stop'
    ? { ...rest, stopLoss: price, ...(targetTicks !== undefined ? { targetTicks } : {}) }
    : { ...rest, takeProfit: price, ...(stopTicks !== undefined ? { stopTicks } : {}) };
}

export function draftLeg(
  r: Pick<OrderRequest, 'bracket' | 'side' | 'instrument'>,
  role: 'stop' | 'target',
  from: number,
): number | null {
  return r.bracket ? legAt(r.bracket, role, r.side, from, knownContract(instrumentRoot(r.instrument)).tick) : null;
}

export function legWords(b: Bracket | null | undefined, role: 'stop' | 'target', decimals: number): string | null {
  const price = role === 'stop' ? b?.stopLoss : b?.takeProfit;
  if (price !== null && price !== undefined) return formatPrice(price, decimals);
  const ticks = role === 'stop' ? b?.stopTicks : b?.targetTicks;
  return ticks !== undefined ? `${String(ticks)} ${ticks === 1 ? 'tick' : 'ticks'} from the fill` : null;
}

export function hasLegs(b: Bracket | null | undefined): boolean {
  return (
    !!b && (b.stopLoss !== null || b.takeProfit !== null || b.stopTicks !== undefined || b.targetTicks !== undefined)
  );
}

export function bracketSideErrors(side: Side, fill: number | null, b: Bracket | null, decimals: number): string[] {
  if (!b || fill === null) return [];
  const below = (p: number) => (side === 'buy' ? p < fill : p > fill);
  const px = (p: number) => formatPrice(p, decimals);
  const out: string[] = [];
  const [losing, winning] = side === 'buy' ? ['above', 'below'] : ['below', 'above'];
  if (b.stopLoss !== null && !below(b.stopLoss))
    out.push(`Stop ${px(b.stopLoss)} is ${losing} the market (${px(fill)}): it would stop out at once`);
  if (b.takeProfit !== null && (below(b.takeProfit) || b.takeProfit === fill))
    out.push(`Target ${px(b.takeProfit)} is ${winning} the market (${px(fill)}): it would fill at once`);
  return out;
}

export interface OcoSummary {
  text: string;
  head: string;
  roomText: string | null;
  binds: boolean;
  risk: number | null;
  reward: number | null;
  room: number | null;
}

export function ocoSummary(
  plan: OcoPlan,
  m: OcoMarket,
  room: number | null = null,
  riskSized: number | null = null,
): OcoSummary {
  const per = tickMoney(m);
  const risk = riskSized ?? (plan.stopTicks !== null ? plan.stopTicks * per : null);
  const reward = riskSized === null && plan.targetTicks !== null ? plan.targetTicks * per : null;
  const parts: string[] = [];
  parts.push(risk !== null ? `Risk ${formatMoney(risk)}` : 'No stop');
  if (reward !== null) parts.push(`Reward ${formatMoney(reward)}`);
  if (risk !== null && reward !== null && risk > 0) parts.push(`1 : ${(reward / risk).toFixed(1)}`);
  const head = parts.join(' · ');
  const roomText = room !== null ? `${formatMoney(room)} left today` : null;
  const binds = room !== null && risk !== null && risk > room * 0.5;
  return { text: roomText ? `${head} · ${roomText}` : head, head, roomText, binds, risk, reward, room };
}

export function readOco(v: unknown): OcoConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<OcoConfig>;
  const leg = (l: unknown, d: OcoLeg): OcoLeg => {
    const x = (l && typeof l === 'object' ? l : {}) as Partial<OcoLeg>;
    return {
      on: typeof x.on === 'boolean' ? x.on : d.on,
      unit: OCO_UNITS.includes(x.unit!) ? x.unit! : d.unit,
      value: typeof x.value === 'number' && x.value > 0 ? x.value : d.value,
    };
  };
  const be = (o.breakeven ?? {}) as Partial<OcoConfig['breakeven']>;
  const tr = (o.trail ?? {}) as Partial<OcoConfig['trail']>;
  return {
    on: typeof o.on === 'boolean' ? o.on : DEFAULT_OCO.on,
    stop: leg(o.stop, DEFAULT_OCO.stop),
    target: leg(o.target, DEFAULT_OCO.target),
    breakeven: {
      on: typeof be.on === 'boolean' ? be.on : DEFAULT_OCO.breakeven.on,
      trigger: typeof be.trigger === 'number' ? be.trigger : DEFAULT_OCO.breakeven.trigger,
      offset: typeof be.offset === 'number' ? be.offset : DEFAULT_OCO.breakeven.offset,
    },
    trail: {
      on: typeof tr.on === 'boolean' ? tr.on : DEFAULT_OCO.trail.on,
      ticks: typeof tr.ticks === 'number' ? tr.ticks : DEFAULT_OCO.trail.ticks,
      trigger: typeof tr.trigger === 'number' ? tr.trigger : DEFAULT_OCO.trail.trigger,
      step: typeof tr.step === 'number' ? tr.step : DEFAULT_OCO.trail.step,
    },
  };
}

const KNOWN_CONTRACTS: Readonly<Record<string, ContractMath>> = {
  NQ: { tick: 0.25, tickValue: 5, decimals: 2 },
  MNQ: { tick: 0.25, tickValue: 0.5, decimals: 2 },
  ES: { tick: 0.25, tickValue: 12.5, decimals: 2 },
  MES: { tick: 0.25, tickValue: 1.25, decimals: 2 },
  RTY: { tick: 0.1, tickValue: 5, decimals: 2 },
  M2K: { tick: 0.1, tickValue: 0.5, decimals: 2 },
  YM: { tick: 1, tickValue: 5, decimals: 0 },
  MYM: { tick: 1, tickValue: 0.5, decimals: 0 },
  CL: { tick: 0.01, tickValue: 10, decimals: 2 },
  MCL: { tick: 0.01, tickValue: 1, decimals: 2 },
  GC: { tick: 0.1, tickValue: 10, decimals: 1 },
  MGC: { tick: 0.1, tickValue: 1, decimals: 1 },
  EQUITY: { tick: 0.01, tickValue: 0.01, decimals: 2 },
  BTC: { tick: 0.01, tickValue: 0.01, decimals: 2 },
};

export function instrumentRoot(instrument: string, root: string | null = null): string {
  if (root) return root;
  const base = instrument.split('.')[0] ?? instrument;
  const fut = /^([A-Z][A-Z0-9]{0,2})[FGHJKMNQUVXZ]\d$/.exec(base);
  if (fut && instrument.includes('.')) return fut[1]!;
  return base.split('-')[0] ?? base;
}

export function knownContract(root: string): ContractMath {
  return KNOWN_CONTRACTS[root] ?? KNOWN_CONTRACTS.EQUITY!;
}
