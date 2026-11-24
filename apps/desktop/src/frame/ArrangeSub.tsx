import {
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from '@tessera/ui';
import { useSyncExternalStore } from 'react';
import { useLayouts, useStageView, type LayoutPreset } from '../state/layouts.ts';
import { chartPanes } from '../workspace/deskPlace.ts';
import {
  allChartsLinked,
  applyLayoutPreset,
  linkAllCharts,
  setSyncInterval,
  workspaceContext,
} from '../workspace/controller.ts';
import { dockRevision, subscribeDock } from '../workspace/dock/edges.ts';
import { PRESETS, presetFor } from '../workspace/presets.ts';

function ArrangeGlyph({ preset }: { preset: LayoutPreset }) {
  const n = PRESETS.find((p) => p.id === preset)?.count ?? 1;
  return (
    <span className="arr-glyph" data-preset={preset} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

export function ArrangeSub({
  layoutId,
  open,
  onOpenChange,
}: {
  layoutId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const view = useStageView(layoutId);
  const byId = useLayouts((s) => s.layouts[layoutId]?.charts);
  const charts = Object.values(byId ?? {});
  const linked = allChartsLinked(charts);
  useSyncExternalStore(subscribeDock, dockRevision);
  const ctx = workspaceContext();
  const panes = ctx?.layoutId === layoutId ? chartPanes(ctx.api).length : charts.length;
  const preset = view.preset ?? presetFor(panes);
  const label = PRESETS.find((p) => p.id === preset)?.label ?? '';
  return (
    <MenuSub open={open} onOpenChange={onOpenChange}>
      <MenuSubTrigger aria-label={`Arrange charts: ${label}`} hint={<ArrangeGlyph preset={preset} />}>
        Arrange charts
      </MenuSubTrigger>
      <MenuSubContent style={{ width: 200 }} onFocusOutside={(e) => e.preventDefault()}>
        <MenuRadioGroup className="arr-grid" value={preset} onValueChange={(v) => applyLayoutPreset(v as LayoutPreset)}>
          {PRESETS.map((p) => (
            <MenuRadioItem key={p.id} value={p.id} className="arr-item" aria-label={p.label} title={p.label}>
              <ArrangeGlyph preset={p.id} />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuCheckboxItem
          checked={linked}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => void linkAllCharts(on)}
        >
          Link all charts
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={view.syncInterval}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => void setSyncInterval(on)}
        >
          Share interval
        </MenuCheckboxItem>
      </MenuSubContent>
    </MenuSub>
  );
}
