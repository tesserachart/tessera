import type { Alert, AlertFire, AlertStatus } from '@tessera/protocol';
import { normalizeEpochMs } from '@tessera/protocol';
import { formatPrice } from '@tessera/ui';
import { displaySymbol } from '../market/instruments.ts';
import { displayZone } from '../state/timeZone.ts';

const STATUS_WORD: Record<AlertStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  triggered: 'Fired',
  expired: 'Expired',
};

function decimalsOf(p: number, min = 0): number {
  if (!Number.isFinite(p)) return min;
  const s = p.toFixed(6).replace(/0+$/, '');
  const d = s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
  return Math.max(min, Math.min(6, d));
}

export function priceWords(p: number | null | undefined, decimals?: number): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  return formatPrice(p, decimals ?? decimalsOf(p, 2));
}

function clockWords(ns: number, zone: string = displayZone()): string {
  return new Date(normalizeEpochMs(ns)).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: zone,
  });
}

export function whenWords(ns: number, nowMs: number, zone: string = displayZone()): string {
  const ms = normalizeEpochMs(ns);
  const day = (t: number) => new Date(t).toLocaleDateString('en-US', { timeZone: zone });
  if (day(ms) === day(nowMs)) return clockWords(ns, zone);
  const d = new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: zone });
  const t = new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: zone,
  });
  return `${d} ${t}`;
}

export function fireWords(f: AlertFire): { title: string; detail: string } {
  const parts = [f.title];
  if (f.message) parts.push(f.message);
  const flow = f.size === undefined ? '' : `${String(f.size)} ${f.side === 'ask' ? 'at the ask' : 'at the bid'} · `;
  return { title: `${displaySymbol(f.instrument)} ${flow}${priceWords(f.price)}`, detail: parts.join(' · ') };
}

export function stateWords(a: Alert): { word: string; note: string | null } {
  const word = STATUS_WORD[a.status];
  if (a.status !== 'active') return { word, note: null };
  if (a.live.problem) return { word: 'Waiting', note: a.live.problem };
  if (a.steps.length > 1 && a.live.step > 0) {
    const of = `step ${String(a.live.step + 1)} of ${String(a.steps.length)}`;
    return { word, note: a.withinBars ? `${of}, ${String(a.live.bars)}/${String(a.withinBars)} bars` : of };
  }
  return { word, note: null };
}

export function deliverWords(a: Pick<Alert, 'deliver' | 'askAnalyst'>): string {
  const d = [a.deliver.sound && 'Sound', a.deliver.desktop && 'Desktop', a.deliver.discord && 'Discord'];
  if (a.askAnalyst) d.push('Analyst');
  const out = d.filter(Boolean).join(' · ');
  return out || 'In the app';
}
