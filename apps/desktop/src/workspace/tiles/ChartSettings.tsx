import { FormRow, FormSection, Switch } from '@tessera/ui';
import { chartLabel, pickedSources, sharedLabels, sourceChoices } from '../../chart/drawings/sources.ts';
import { displaySymbol } from '../../market/instruments.ts';
import { useLayouts } from '../../state/layouts.ts';
import { chartPlace } from '../chartPlace.ts';
import { setDrawingSources } from '../controller.ts';
import { tileParams } from '../dock/tileSettings.ts';
import type { ChartTileParams } from '../layouts.ts';
import type { TileSettingsProps } from './registry.ts';

export function ChartSettingsForm({ panel }: TileSettingsProps) {
  const { layoutId = '', tileId = '' } = tileParams<ChartTileParams>(panel.api);
  const charts = useLayouts((s) => s.layouts[layoutId]?.charts);
  const chart = charts?.[tileId];
  if (!charts || !chart) return null;
  const choices = sourceChoices(charts, tileId);
  const shared = sharedLabels(choices, chartLabel(chart));
  const pick = (source: string, on: boolean) => {
    const now = pickedSources(charts, tileId);
    const next = on ? [...now, source] : now.filter((t) => t !== source);
    void setDrawingSources(next, { layoutId, tileId });
  };
  return (
    <FormSection title="Drawings from" aria-label="Drawings from">
      {choices.length === 0 ? (
        <p className="t-form-note">No other {displaySymbol(chart.instrument)} chart in this workspace</p>
      ) : (
        choices.map((c) => {
          const place = shared.has(c.label) ? (chartPlace(layoutId, c.tileId) ?? charts[c.tileId]?.title) : undefined;
          const id = `drawings-from-${c.tileId}`;
          return (
            <FormRow key={c.tileId} label={c.label} htmlFor={id} hint={place}>
              <Switch
                id={id}
                label={place ? `${c.label}, ${place}` : c.label}
                checked={c.picked}
                onCheckedChange={(on) => pick(c.tileId, on)}
              />
            </FormRow>
          );
        })
      )}
    </FormSection>
  );
}
