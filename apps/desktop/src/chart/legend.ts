import type { LegendItem } from '@tessera/chart';
import type { ChartLayer, Level } from '@tessera/protocol';
import { formatPrice, TOKENS } from '@tessera/ui';
import { earlierContractAt, type ContractSpan } from '../market/frontMonths.ts';
import { isLevelShown } from './levels.ts';

export interface LegendSource {
  layers: readonly ChartLayer[];
  levels: readonly Level[];
  precision: number;
  contracts: readonly ContractSpan[];
  charted: string | null;
}

export function legendItems(src: LegendSource, barTime: number | undefined): LegendItem[] {
  const items: LegendItem[] = [];
  const contract = barTime === undefined ? null : earlierContractAt(src.contracts, src.charted, barTime);
  if (contract) items.push({ text: contract, gap: 18 });
  const groups = new Map<string, Level[]>();
  for (const l of src.levels) {
    if (l.source.vendor === 'Tessera' || l.price === null || !isLevelShown(src.layers, l)) continue;
    groups.set(l.source.vendor, [...(groups.get(l.source.vendor) ?? []), l]);
  }
  for (const [name, levels] of groups) {
    items.push({ text: name, weight: 500, color: TOKENS.t2, gap: 6, keepWithNext: true });
    const decimals = levels.every((l) => Number.isInteger(l.price)) ? 0 : src.precision;
    levels
      .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))
      .forEach((l, k) => {
        const text = `${l.label} ${formatPrice(l.price, decimals)}`;
        items.push({ text: k === 0 ? text : `· ${text}`, gap: k === levels.length - 1 ? 18 : 4 });
      });
  }
  return items;
}
