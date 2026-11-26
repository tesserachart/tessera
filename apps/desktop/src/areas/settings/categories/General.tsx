import { Choice, Combobox, Switch } from '@tessera/ui';
import { useHasTool, useToolValue } from '../../../app/tools.ts';
import { useServer } from '../../../app/runtimeContext.ts';
import { RETIRED_AREA_LAYOUTS } from '../../../state/layouts.ts';
import { useSetting, useSettingSave } from '../../../state/runtimeSettings.ts';
import { TIME_ZONE, TIME_ZONE_OPTIONS, useDisplayZone, zoneLabel } from '../../../state/timeZone.ts';
import { ACTIVE_LAYOUT } from '../../../frame/workspaces.ts';
import { setDensity, setReducedMotion, type Density, useUi } from '../../../state/ui.ts';
import { Row, Section, SettingSelect } from '../parts.tsx';

const DENSITIES: { value: Density; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'comfortable', label: 'Comfortable' },
];

function TimeZone() {
  const zone = useDisplayZone();
  const { save, error: failed } = useSettingSave(TIME_ZONE);
  const options = TIME_ZONE_OPTIONS.some((o) => o.value === zone)
    ? TIME_ZONE_OPTIONS
    : [{ value: zone, label: zoneLabel(zone) }, ...TIME_ZONE_OPTIONS];
  return (
    <Row id="app.timeZone" error={failed}>
      <Combobox
        label="Time zone"
        value={zone}
        align="end"
        searchPlaceholder="Search time zones"
        onValueChange={(v) => {
          if (v === zone) return;
          void save(v);
        }}
        options={options}
      />
    </Row>
  );
}

export function GeneralSection() {
  const active = useSetting(ACTIVE_LAYOUT);
  const { save: saveActive, error: wsErr } = useSettingSave(ACTIVE_LAYOUT);
  const server = useServer();
  const density = useUi((s) => s.density);
  const reduced = useUi((s) => s.reducedMotion);
  const layouts = useToolValue('layout.list', useHasTool('layout.list') ? {} : null, { keepFor: 0 });
  const workspaces = (layouts?.layouts ?? []).filter((l) => !RETIRED_AREA_LAYOUTS.includes(l.id));
  const activeId = active ?? layouts?.activeId ?? server?.defaultLayoutId ?? null;
  return (
    <Section id="app.general">
      <TimeZone />
      <Row id="app.workspace" error={wsErr}>
        {activeId && workspaces.length > 0 ? (
          <SettingSelect
            label="Workspace on open"
            value={activeId}
            onValueChange={(id) => void saveActive(id)}
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          />
        ) : null}
      </Row>
      <Row id="app.density">
        <Choice<Density> label="Row density" value={density} onChange={(v) => setDensity(v)} options={DENSITIES} />
      </Row>
      <Row id="app.reducedMotion">
        <Switch label="Reduce motion" checked={reduced} onCheckedChange={(on) => setReducedMotion(on)} />
      </Row>
    </Section>
  );
}
