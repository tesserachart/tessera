import { Choice, Combobox, Switch } from '@tessera/ui';
import { useState } from 'react';
import { useHasTool, useToolValue } from '../../../app/tools.ts';
import { useServer } from '../../../app/runtimeContext.ts';
import { RETIRED_AREA_LAYOUTS } from '../../../state/layouts.ts';
import { useRuntimeSetting, useSetSetting } from '../../../state/runtimeSettings.ts';
import { TIME_ZONE_OPTIONS, TIME_ZONE_SETTING, useDisplayZone, zoneLabel } from '../../../state/timeZone.ts';
import { setDensity, setReducedMotion, type Density, useUi } from '../../../state/ui.ts';
import { Row, Section, SettingSelect } from '../parts.tsx';

const DENSITIES: { value: Density; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'comfortable', label: 'Comfortable' },
];

function TimeZone() {
  const set = useSetSetting();
  const zone = useDisplayZone();
  const [failed, setFailed] = useState<string | null>(null);
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
          setFailed(null);
          void set(TIME_ZONE_SETTING, v).then(setFailed);
        }}
        options={options}
      />
    </Row>
  );
}

export function GeneralSection() {
  const set = useSetSetting();
  const active = useRuntimeSetting('workspace.activeLayoutId');
  const server = useServer();
  const density = useUi((s) => s.density);
  const reduced = useUi((s) => s.reducedMotion);
  const layouts = useToolValue('layout.list', useHasTool('layout.list') ? {} : null, { keepFor: 0 });
  const [wsErr, setWsErr] = useState<string | null>(null);
  const workspaces = (layouts?.layouts ?? []).filter((l) => !RETIRED_AREA_LAYOUTS.includes(l.id));
  const activeId = typeof active === 'string' ? active : (layouts?.activeId ?? server?.defaultLayoutId ?? null);
  return (
    <Section id="app.general">
      <TimeZone />
      <Row id="app.workspace" error={wsErr}>
        {activeId && workspaces.length > 0 ? (
          <SettingSelect
            label="Workspace on open"
            value={activeId}
            onValueChange={(id) => void set('workspace.activeLayoutId', id).then(setWsErr)}
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
