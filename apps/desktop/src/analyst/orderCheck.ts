import { FAMILIES } from '../market/families.ts';
import { displaySymbol } from '../market/instruments.ts';
import { layoutsStore } from '../state/layouts.ts';
import { placementStore } from '../state/placement.ts';
import { ticketOf, ticketsStore } from '../state/tickets.ts';
import { activeChartTarget } from '../workspace/controller.ts';
import { placementCheck, ticketCheck } from './checkPrompt.ts';
import { read } from '../app/store.ts';

export function tradedWords(execute: 'chart' | 'full' | 'micro', chartInstrument: string): string {
  const shown = displaySymbol(chartInstrument);
  if (execute === 'chart') return shown;
  const root = shown.split(' ')[0] ?? shown;
  const f = FAMILIES.find((x) => x.full === root || x.micro === root);
  const other = f ? (execute === 'full' ? f.full : f.micro) : root;
  return other === root ? shown : `${other} on the ${shown} chart`;
}

export function orderToCheck(): string | null {
  const placing = read(placementStore).placing;
  if (placing) return placementCheck(placing);
  const inTicket = document.activeElement?.closest('[data-focus-zone="ticket"]');
  const target = activeChartTarget();
  if (!inTicket || !target) return null;
  const chart = read(layoutsStore).layouts[target.layoutId]?.charts[target.tileId];
  if (!chart) return null;
  const t = ticketOf(read(ticketsStore).tickets, target.tileId);
  return ticketCheck({
    qty: t.qty,
    symbol: tradedWords(t.execute, chart.instrument),
    sizing: t.sizing,
    risk: t.risk,
  });
}
