import { useChartLevels } from '../chart/useChartLevels.ts';
import { displaySymbol, printBarsShort } from '../market/instruments.ts';
import { layerWords, seesLine } from '../shell/analyst.ts';
import { useChartState } from '../state/layouts.ts';
import { useActiveChart } from '../state/workspace.ts';

export interface ChartSight {
  symbol: string | null;
  tf: string | null;
  words: string[];
  levels: boolean;
  sees: string | null;
}

export function useChartSight(): ChartSight {
  const chart = useActiveChart();
  const chartModel = useChartState(chart?.layoutId ?? '', chart?.tileId ?? '');
  const symbol = chart ? displaySymbol(chart.instrument) : null;
  const received = useChartLevels(chart?.instrument ?? null);
  const words = layerWords(chartModel?.layers ?? [], received);
  const tf = chartModel?.printBars ? printBarsShort(chartModel.printBars) : (chart?.tf ?? null);
  return {
    symbol,
    tf,
    words,
    levels: (chartModel?.layers ?? []).some((l) => l.kind === 'levels' && l.visible),
    sees: seesLine(chart ? `${symbol ?? ''} ${tf ?? ''}` : null, words, null),
  };
}
