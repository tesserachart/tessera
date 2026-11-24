import type { IndicatorSpec } from '@tessera/protocol';
import { Dialog, DialogContent } from '@tessera/ui';
import { indicatorSpec, resolveIndicator, withSettings } from '../indicators.ts';
import { indicatorOf } from '../presets/model.ts';
import { useChartState } from '../../state/layouts.ts';
import { updateChart } from '../../workspace/controller.ts';
import { IndicatorSettingsForm } from './IndicatorSettings.tsx';
import type { ChartRef } from './store.ts';

export function StudySettingsDialog({
  chart,
  layerId,
  open,
  notes,
  spec: given,
  onOpenChange,
}: {
  chart: ChartRef;
  layerId: string | null;
  spec?: IndicatorSpec | undefined;
  open: boolean;
  notes?: Readonly<Record<string, string>> | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const layer = useChartState(chart.layoutId, chart.tileId)?.layers.find((l) => l.id === layerId) ?? null;
  const spec = given ?? (layer ? indicatorSpec(layer.kind) : null);
  const indicator = layer ? indicatorOf(layer) : null;
  return (
    <Dialog open={open && !!layer && !!spec} onOpenChange={onOpenChange}>
      {layer && spec ? (
        <DialogContent
          title={`${spec.title} settings`}
          hideTitle
          className="ind-modal"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <IndicatorSettingsForm
            spec={spec}
            settings={resolveIndicator(spec, layer.params)}
            agent={layer.namespace === 'agent'}
            notes={notes}
            defaults={indicator ? { chart, layerId: layer.id, indicator } : undefined}
            onChange={(fn) =>
              void updateChart(chart.layoutId, chart.tileId, (c) => {
                const l = c.layers.find((x) => x.id === layer.id);
                return l ? { ...c, layers: withSettings(c.layers, layer.id, fn(resolveIndicator(spec, l.params))) } : c;
              })
            }
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
