import type { ChartLayer } from '@tessera/protocol';
import type { ReactNode } from 'react';
import { Icon, MenuCheckboxItem, MenuItem, MenuLabel, Tooltip } from '@tessera/ui';
import { updateChart } from '../../workspace/controller.ts';
import { actWithoutLeavingRow } from '../focus.ts';
import { removeLayer, showLayer } from '../indicators.ts';
import { openAddIndicator } from './actions.ts';
import { indicatorName } from './model.ts';
import { ADD_INDICATOR_KEY, type ChartRef } from './store.ts';

export function IndicatorMenuItems({
  chart,
  layers,
  add = true,
  templates,
}: {
  chart: ChartRef;
  layers: readonly ChartLayer[];
  add?: boolean;
  templates?: ReactNode;
}) {
  const edit = (fn: (ls: readonly ChartLayer[]) => ChartLayer[]) =>
    void updateChart(chart.layoutId, chart.tileId, (c) => ({ ...c, layers: fn(c.layers) }));
  const rows = layers.flatMap((l) => {
    const name = indicatorName(l);
    return name ? [{ layer: l, name }] : [];
  });
  return (
    <>
      {add ? (
        <MenuItem shortcut={ADD_INDICATOR_KEY} onSelect={() => openAddIndicator(chart)}>
          Add indicator…
        </MenuItem>
      ) : null}
      {templates}
      {rows.length > 0 ? <MenuLabel>Indicators</MenuLabel> : null}
      {rows.map(({ layer, name }) => (
        <MenuCheckboxItem
          key={layer.id}
          className="ind-mi"
          checked={layer.visible}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => edit((ls) => showLayer(ls, layer.id, on))}
          onKeyDown={(e) => {
            if (e.key !== 'Backspace' && e.key !== 'Delete') return;
            e.preventDefault();
            edit((ls) => removeLayer(ls, layer.id));
          }}
        >
          <span className="nm">{name}</span>
          <Tooltip content="Remove" side="right">
            <button
              type="button"
              className="x"
              aria-label={`Remove ${name}`}
              {...actWithoutLeavingRow(() => edit((ls) => removeLayer(ls, layer.id)))}
            >
              <Icon name="remove" />
            </button>
          </Tooltip>
          <span className="st" aria-hidden="true">
            {layer.visible ? null : <Icon name="hidden" />}
          </span>
        </MenuCheckboxItem>
      ))}
    </>
  );
}
