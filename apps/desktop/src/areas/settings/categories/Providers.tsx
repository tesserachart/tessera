import type { LevelSourceInfo } from '@tessera/protocol';
import { Button, Choice, SettingsRow, SettingsSection, Switch, ToggleGroup } from '@tessera/ui';
import {
  LABEL_WORD,
  LEVELS,
  LEVEL_LABELS,
  levelStyle,
  setLevelStyle,
  setSourceOn,
  sourceOn,
  type LevelDefs,
  type LevelLabel,
  type LevelSettings,
  type SourceDef,
} from '../../../chart/levelSettings.ts';
import { openConnection, openConnections } from '../../../accounts/navigate.ts';
import { setLevels } from '../../../state/tradeSettings.ts';
import { readSetting, useSetting } from '../../../state/runtimeSettings.ts';
import { Section } from '../parts.tsx';

const save = (next: LevelSettings) => setLevels(next);

const packageHelp = (pkg: string, endpoint: string | null) =>
  endpoint && endpoint.toLowerCase() !== pkg.toLowerCase() ? endpoint : undefined;

export function Providers({
  sources,
  defs,
  bands,
}: {
  sources: readonly LevelSourceInfo[];
  defs: LevelDefs;
  bands: ReadonlyMap<string, SourceDef>;
}) {
  return (
    <div className="st-group">
      <Section
        id="levels.providers"
        description={sources.length === 0 ? 'None connected. Add one in Connections.' : undefined}
        actions={
          <Button size="s" variant="quiet" onClick={() => openConnections()}>
            Connections
          </Button>
        }
      />
      {sources.map((s) => (
        <ProviderSection key={s.providerId} info={s} defs={defs} bands={bands} />
      ))}
    </div>
  );
}

function ProviderSection({
  info,
  defs,
  bands,
}: {
  info: LevelSourceInfo;
  defs: LevelDefs;
  bands: ReadonlyMap<string, SourceDef>;
}) {
  const settings = useSetting(LEVELS);
  const packages = info.packages.flatMap((p) => {
    const band = bands.get(p.key);
    return band && band.levels.length > 0 ? [{ p, band }] : [];
  });
  const firstLevel = packages[0]?.band.levels[0];
  const first = firstLevel ? levelStyle(settings, firstLevel.key, defs) : null;
  const anyOn = packages.some(({ p }) => sourceOn(settings, p.key));
  const setAll = (patch: Parameters<typeof setLevelStyle>[2]) =>
    save(
      packages.reduce(
        (s, { band }) => band.levels.reduce((acc, l) => setLevelStyle(acc, l.key, patch, defs), s),
        readSetting(LEVELS),
      ),
    );
  const name = info.displayName;
  return (
    <SettingsSection
      data-setting={`levels.provider.${info.providerId}`}
      title={name}
      description={info.instruments.join(', ') || undefined}
      aria-label={name}
      actions={
        <Button size="s" variant="quiet" onClick={() => openConnection(info.providerId)}>
          Connection
        </Button>
      }
    >
      {packages.map(({ p, band }) => {
        const on = sourceOn(settings, p.key);
        const shown = band.levels.filter((l) => levelStyle(settings, l.key, defs).on).map((l) => l.key);
        return [
          <SettingsRow
            key={p.key}
            data-setting={`levels.package.${p.key}`}
            label={p.package}
            help={packageHelp(p.package, p.levels[0]?.endpoint ?? null)}
          >
            <Switch
              label={`${band.name} levels`}
              checked={on}
              onCheckedChange={(v) => save(setSourceOn(readSetting(LEVELS), p.key, v))}
            />
          </SettingsRow>,
          band.levels.length > 1 ? (
            <SettingsRow key={`${p.key}.levels`} className="st-own" label="Shown" layout="stack">
              <ToggleGroup
                label={`${band.name} levels to draw`}
                disabled={!on}
                options={band.levels.map((l) => ({ value: l.key, label: l.name }))}
                value={shown}
                onToggle={(key, show) => save(setLevelStyle(readSetting(LEVELS), key, { on: show }, defs))}
              />
            </SettingsRow>
          ) : null,
        ];
      })}
      {first && firstLevel ? (
        <SettingsRow label="Labels">
          <Choice<LevelLabel>
            label={`${name} labels`}
            value={first.label}
            locked={!anyOn}
            options={LEVEL_LABELS.map((l) => ({
              value: l,
              label: l === 'short' ? `Short (${firstLevel.short})` : LABEL_WORD[l],
            }))}
            onChange={(label) => setAll({ label })}
          />
        </SettingsRow>
      ) : null}
      {first ? (
        <SettingsRow label="Distance from price" help="In points">
          <Switch
            label={`${name} distance from price`}
            disabled={!anyOn}
            checked={first.distance}
            onCheckedChange={(distance) => setAll({ distance })}
          />
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
