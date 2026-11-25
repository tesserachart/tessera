import type { ChartApi } from '@tessera/chart';
import { Icon } from '@tessera/ui';
import { useEffect } from 'react';
import { orderColorsOf, useChartTheme } from './chartTheme.ts';
import { linkTrade, useLinkedTrade } from './linkedTrade.ts';
import { LinkedTradeLayer } from './linkedTradeLayer.ts';
import type { ChartTarget } from './viewportRequests.ts';

const LAYER_ID = 'linked-trade';

export function ChartLinkedTrade({
  chart,
  ids,
  target,
}: {
  chart: ChartApi | null;
  ids: ReadonlySet<string>;
  target: ChartTarget;
}) {
  const linked = useLinkedTrade();
  const resolved = useChartTheme((s) => s.resolved);
  const mutedText = useChartTheme((s) => s.theme.mutedText);
  const shown =
    linked?.target.layoutId === target.layoutId && linked.target.tileId === target.tileId && ids.has(linked.instrument)
      ? linked
      : null;

  useEffect(() => {
    if (!chart || !shown) return;
    const oc = orderColorsOf(resolved);
    const layer = new LinkedTradeLayer(LAYER_ID);
    chart.addLayer(layer);
    layer.set(shown.trade, { entry: oc.mist, up: oc.up, down: oc.down, label: mutedText });
    return () => {
      chart.removeLayer(LAYER_ID);
    };
  }, [chart, shown, resolved, mutedText]);

  if (!shown) return null;
  return (
    <div className="chart-linked" role="group" aria-label="Research trade">
      <button type="button" className="chart-linked-back" onClick={shown.back}>
        <Icon name="chevron-left" aria-hidden />
        {shown.label}
      </button>
      <button
        type="button"
        className="chart-linked-close"
        aria-label="Hide the research trade"
        onClick={() => linkTrade(null)}
      >
        <Icon name="close" aria-hidden />
      </button>
    </div>
  );
}
