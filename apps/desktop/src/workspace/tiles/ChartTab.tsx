import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { useRef } from 'react';
import { displaySymbol, printBarsShort, useInstrumentSpec } from '../../market/instruments.ts';
import { useChartState } from '../../state/layouts.ts';
import { uiStore, openSymbolSearch } from '../../state/ui.ts';
import { workspaceStore } from '../../state/workspace.ts';
import { activateChart } from '../controller.ts';
import type { ChartTileParams } from '../layouts.ts';
import { read } from '../../app/store.ts';

export function ChartTab({ params, api }: IDockviewPanelHeaderProps<ChartTileParams>) {
  const chart = useChartState(params.layoutId, params.tileId);
  const contract = useInstrumentSpec(chart?.instrument ?? null)?.instrument;
  const wasOpen = useRef(false);
  if (!chart) return <span className="dock-tab-title">{api.title}</span>;
  const symbol = displaySymbol(contract ?? chart.instrument);
  const interval = chart.printBars ? printBarsShort(chart.printBars) : chart.timeframe;
  return (
    <span className="dock-tab-title" title={`${symbol} · ${interval}`}>
      <b
        className="dock-tab-symbol"
        role="button"
        aria-label={`${symbol}: change symbol`}
        aria-haspopup="dialog"
        onPointerDown={() => {
          const active = read(workspaceStore).activeChart;
          wasOpen.current = read(uiStore).symbolSearch !== null && active?.tileId === params.tileId;
        }}
        onClick={() => {
          if (wasOpen.current) return;
          activateChart(params.layoutId, params.tileId);
          openSymbolSearch('');
        }}
      >
        {symbol}
      </b>
      <span className="sep"> · </span>
      {interval}
    </span>
  );
}
