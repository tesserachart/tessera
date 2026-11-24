import { formatPrice, formatMoney } from '@tessera/ui';
import {
  legFigures,
  type OcoConfig,
  type OcoLeg,
  type OcoMarket,
  type OcoPlan,
  type OcoUnit,
} from '../../shell/oco.ts';

export function bracketShort(oco: OcoConfig, plan: OcoPlan | null, opts: { riskSizing: boolean }): string {
  if (!oco.on) return '';
  const t = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${String(n)} t`);
  const stop = opts.riskSizing ? 'Stop on click' : oco.stop.on ? t(plan?.stopTicks) : null;
  const money = oco.target.unit === 'usd' ? formatMoney(oco.target.value) : `${legFieldText(oco.target)}%`;
  const target = !oco.target.on ? null : opts.riskSizing && sizedByStop(oco.target.unit) ? money : t(plan?.targetTicks);
  return [stop, target].filter((x): x is string => x !== null).join(' · ') || 'No legs';
}

export function sizedByStop(unit: OcoUnit): boolean {
  return unit === 'usd' || unit === 'pct';
}

export function legHelp(ticks: number | null, unit: OcoUnit, m: OcoMarket | null, price: number | null): string {
  if (ticks === null || !m) return '—';
  const f = legFigures(ticks, m);
  const parts: string[] = [];
  if (price !== null) parts.push(formatPrice(price, m.decimals));
  if (unit !== 'ticks') parts.push(`${String(f.ticks)} t`);
  if (unit !== 'usd') parts.push(formatMoney(f.usd));
  return parts.join(' · ');
}

export function legFieldText(leg: Pick<OcoLeg, 'value' | 'unit'>): string {
  const v = leg.value;
  if (leg.unit === 'ticks') return String(Math.round(v));
  if (leg.unit === 'pct') return String(Number(v.toFixed(4)));
  return String(Number(v.toFixed(2)));
}

export const UNIT_SHORT: Record<OcoUnit, string> = { ticks: 't', points: 'pt', usd: '$', pct: '%' };

export const UNIT_NAME: Record<OcoUnit, string> = {
  ticks: 'Ticks',
  points: 'Points',
  usd: 'Dollars',
  pct: '% of the balance',
};

export function rulesShort(oco: OcoConfig): string {
  const parts: string[] = [];
  if (oco.breakeven.on) parts.push(`Breakeven ${String(oco.breakeven.trigger)}`);
  if (oco.trail.on) parts.push(`Trail ${String(oco.trail.ticks)}`);
  return parts.join(' · ');
}

function ticksWord(n: number): string {
  return `${String(n)} ${n === 1 ? 'tick' : 'ticks'}`;
}

export function breakevenWords(oco: OcoConfig): string {
  const { trigger, offset } = oco.breakeven;
  return `At ${String(trigger)} ticks of profit, the stop moves to the entry${offset > 0 ? ` + ${String(offset)}` : ''}, once`;
}

export function trailWords(oco: OcoConfig): string {
  const { ticks, trigger, step } = oco.trail;
  const from = trigger > 0 ? `From ${ticksWord(trigger)} of profit, the stop` : 'The stop';
  const steps = step > 1 ? `, ${ticksWord(step)} at a time` : '';
  return `${from} follows ${ticksWord(ticks)} behind the best price${steps}, only tighter`;
}

export function bracketErrors(plan: OcoPlan | null, extra: readonly string[] = []): string[] {
  const out: string[] = [];
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  if (plan?.errors.stop) out.push(`Stop: ${lower(plan.errors.stop)}`);
  if (plan?.errors.target) out.push(`Target: ${lower(plan.errors.target)}`);
  if (plan?.errors.rules) out.push(plan.errors.rules);
  return [...new Set([...out, ...extra])];
}
