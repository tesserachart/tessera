import type { Command } from '../../commands/registry.ts';
import { formatMoney } from '@tessera/ui';
import { UNIT_WORD, type OcoConfig, type OcoLeg } from '../../shell/oco.ts';

function legWords(leg: OcoLeg): string {
  if (!leg.on) return 'off';
  if (leg.unit === 'usd') return formatMoney(leg.value);
  if (leg.unit === 'pct') return `${String(leg.value)}%`;
  return `${String(leg.value)} ${UNIT_WORD[leg.unit].toLowerCase()}`;
}

export function bracketWords(o: OcoConfig): string {
  if (!o.on) return 'No bracket';
  const parts = [`Stop ${legWords(o.stop)}`, `Target ${legWords(o.target)}`];
  if (o.breakeven.on) parts.push(`Breakeven at ${String(o.breakeven.trigger)}`);
  if (o.trail.on) parts.push(`Trail ${String(o.trail.ticks)}`);
  return parts.join(' · ');
}

export const BRACKET_MODES = [
  {
    value: 'per_entry',
    label: 'Each entry its own bracket',
    help: 'Every entry keeps its own stop and target; an exit shrinks the newest entry’s first.',
  },
  {
    value: 'grow',
    label: 'Grow the position’s bracket',
    help: 'One stop and one target for the whole position: an add grows them at their prices, an exit shrinks them.',
  },
] as const;

export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v).toString() : v.toFixed(1)} ${units[i]!}`;
}

export function keyedCommands(list: readonly Command[]): Command[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    if (!c.shortcut || seen.has(c.title)) return false;
    seen.add(c.title);
    return true;
  });
}

export const commandRow = (id: string) => `app.key.${id}`;
