import { Icon, Tooltip, cx } from '@tessera/ui';
import { useMemo, useSyncExternalStore } from 'react';
import { ChartTypeMenu, IntervalTools, FxButton, type ToolChart } from '../../chart/ChartTools.tsx';
import { HoursPill } from '../../chart/HoursPill.tsx';
import { TemplateChip } from '../../chart/templates/TemplateMenu.tsx';
import { useClosedNote } from '../../markets/sessions.ts';
import { TRADE_KEY } from '../../shell/keys.ts';
import { useChartState } from '../../state/layouts.ts';
import { useWorkspace } from '../../state/workspace.ts';
import { activateChart } from '../controller.ts';
import { dockRevision, subscribeDock } from '../dock/edges.ts';
import type { ChartTileParams } from '../layouts.ts';
import { isTradeShown, notePress, tradeChart } from './trade.ts';

function TradeToggle({ chart }: { chart: { layoutId: string; tileId: string } }) {
  useSyncExternalStore(subscribeDock, dockRevision);
  const active = useWorkspace(
    (s) => s.activeChart?.layoutId === chart.layoutId && s.activeChart.tileId === chart.tileId,
  );
  const on = active && isTradeShown();
  const label = on ? 'Hide Trade' : 'Trade';
  return (
    <Tooltip content={label} shortcut={TRADE_KEY}>
      <button
        type="button"
        className={cx('dock-act', on && 'is-on')}
        aria-label={label}
        aria-pressed={on}
        onPointerDownCapture={() => notePress(chart, on)}
        onClick={() => tradeChart(chart, 'pointer', on)}
      >
        <Icon name="ticket" />
      </button>
    </Tooltip>
  );
}

export function ChartBar({ layoutId, tileId }: ChartTileParams) {
  const model = useChartState(layoutId, tileId);
  const chart = useMemo<ToolChart | null>(
    () =>
      model
        ? { layoutId, tileId, instrument: model.instrument, tf: model.timeframe, printBars: model.printBars ?? null }
        : null,
    [model, layoutId, tileId],
  );
  const closed = useClosedNote(model?.instrument ?? null);
  if (!chart) return null;
  const activate = () => activateChart(chart.layoutId, chart.tileId);
  return (
    <div
      className="chart-tools"
      role="toolbar"
      aria-label="Chart"
      onPointerDownCapture={activate}
      onFocusCapture={activate}
    >
      <IntervalTools chart={chart} />
      <ChartTypeMenu chart={chart} />
      <FxButton chart={chart} />
      <TemplateChip chart={chart} />
      <span className="fill" />
      {closed ? (
        <span className="chart-closed" role="status" title={closed}>
          {closed}
        </span>
      ) : null}
      <HoursPill chart={chart} />
      <TradeToggle chart={chart} />
    </div>
  );
}
