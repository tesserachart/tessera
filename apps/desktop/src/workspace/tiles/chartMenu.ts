import type { IDockviewPanel } from 'dockview-react';
import { TRADE_KEY } from '../../shell/keys.ts';
import { SERIES_TYPES, CHART_TYPE_WORD, DEFAULT_VIEW, chartTypeOf, layoutsStore } from '../../state/layouts.ts';
import { CHART_TYPE_VIEWS, kindShown, toggleChartView } from '../../chart/orderflowCommands.ts';
import { uiStore, openSymbolSearch } from '../../state/ui.ts';
import { chartPanels, openBesideChart } from '../chartPanels.ts';
import { activateChart, setChartType } from '../controller.ts';
import type { TabEntry } from '../dock/tabMenu.ts';
import { tileParams } from '../dock/tileSettings.ts';
import type { ChartTileParams } from '../layouts.ts';
import { isTradeShownFor, tradeChart } from './trade.ts';
import { openReplayPicker } from '../../chart/replay/actions.ts';
import { read } from '../../app/store.ts';
import { accountStore } from '../../account/account.ts';
import { canShare } from '../../share/model.ts';
import { shareChart } from '../../share/store.ts';

export function chartMenu(panel: IDockviewPanel): TabEntry[] {
  const p = tileParams<ChartTileParams>(panel.api);
  const target = p.layoutId && p.tileId ? { layoutId: p.layoutId, tileId: p.tileId } : null;
  if (!target) return [];
  const shown = isTradeShownFor(target);
  const store = read(layoutsStore);
  const chart = store.layouts[target.layoutId]?.charts[target.tileId] ?? null;
  const type = chartTypeOf(
    store.views[target.layoutId] ?? DEFAULT_VIEW,
    target.tileId,
    read(uiStore).defaultChartType,
    chart,
  );
  const panels: TabEntry[] = chartPanels().map(({ kind, label }) => ({
    type: 'item',
    id: `chart-open-${kind}`,
    label,
    run: () => void openBesideChart(kind, target),
  }));
  return [
    {
      type: 'item',
      id: 'chart-symbol',
      label: 'Change symbol…',
      run: () => {
        activateChart(target.layoutId, target.tileId);
        openSymbolSearch('');
      },
    },
    {
      type: 'item',
      id: 'chart-replay',
      label: 'Replay a saved day…',
      run: () => openReplayPicker(target),
    },
    {
      type: 'sub',
      id: 'chart-type',
      label: 'Chart type',
      items: [
        ...SERIES_TYPES.map((t) => ({
          type: 'item' as const,
          id: `chart-type-${t}`,
          label: CHART_TYPE_WORD[t],
          current: t === type,
          run: () => void setChartType(t, target),
        })),
        { type: 'sep' as const, id: 'chart-type-views' },
        ...CHART_TYPE_VIEWS.map((v) => ({
          type: 'item' as const,
          id: `chart-type-${v.kind}`,
          label: v.name,
          current: kindShown(chart?.layers ?? [], v.kind),
          shortcut: v.shortcut,
          run: () => void toggleChartView(target, v.kind),
        })),
      ],
    },
    {
      type: 'item',
      id: 'chart-trade',
      label: shown ? 'Hide Trade' : 'Trade this chart',
      shortcut: TRADE_KEY,
      run: () => tradeChart(target, 'pointer', shown),
    },
    ...(canShare(read(accountStore))
      ? [
          { type: 'sep' as const, id: 'chart-share-sep' },
          { type: 'item' as const, id: 'chart-share', label: 'Share chart…', run: () => void shareChart(target) },
        ]
      : []),
    ...(panels.length > 0 ? [{ type: 'sep' as const, id: 'chart-panels' }, ...panels] : []),
  ];
}
