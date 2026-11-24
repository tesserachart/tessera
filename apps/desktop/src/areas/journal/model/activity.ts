import type { JournalTrade, PathStep, TradeDetail } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';
import { nsToMs, plural } from './format.ts';
import { displayZone } from '../../../state/timeZone.ts';

const clockSecFmt = new Map<string, Intl.DateTimeFormat>();

export function clockSec(ns: number, tz: string = displayZone()): string {
  let f = clockSecFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZone: tz,
    });
    clockSecFmt.set(tz, f);
  }
  return f.format(new Date(nsToMs(ns)));
}

export function chartSteps(path: readonly PathStep[]): { t: number; price: number | null }[] {
  return path.map((s) => ({ t: nsToMs(s.t), price: s.price }));
}

export type PlanLeg = 'stop' | 'target';

export interface RecordedPrice {
  price: number;
  t: number;
  ticks: number | null;
  money: number;
  current: boolean;
}

export type RecordedPriceSource = Pick<TradeDetail, 'activity' | 'pointValue' | 'tickSize'> & {
  trade: Pick<JournalTrade, 'side' | 'entryPrice' | 'qty' | 'stopPrice' | 'targetPrice'>;
};

export function recordedPrices(d: RecordedPriceSource, leg: PlanLeg): RecordedPrice[] {
  const path = leg === 'stop' ? d.activity?.stopPath : d.activity?.targetPath;
  if (!path?.length) return [];
  const t = d.trade;
  const tick = d.tickSize > 0 ? d.tickSize : 0;
  const eps = tick > 0 ? tick / 2 : 1e-9;
  const same = (a: number, b: number) => Math.abs(a - b) < eps;
  const dir = t.side === 'buy' ? 1 : -1;
  const plan = leg === 'stop' ? t.stopPrice : t.targetPrice;
  const out: RecordedPrice[] = [];
  for (const s of path) {
    const price = s.price;
    if (price === null || !Number.isFinite(price) || out.some((o) => same(o.price, price))) continue;
    const dist = Math.abs(price - t.entryPrice);
    out.push({
      price,
      t: s.t,
      ticks: tick > 0 ? Number((dist / tick).toFixed(1)) : null,
      money: Math.round((price - t.entryPrice) * dir * d.pointValue * t.qty * 100) / 100 || 0,
      current: plan !== null && same(price, plan),
    });
  }
  return out;
}

export function recordedPriceNote(p: RecordedPrice): string {
  return p.ticks === null
    ? formatMoney(p.money, { signed: true })
    : `${plural(p.ticks, 'tick')} · ${formatMoney(p.money, { signed: true })}`;
}
