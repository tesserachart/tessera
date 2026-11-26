import { Choice, SettingsRow, SettingsSection, Switch, ToggleGroup } from '@tessera/ui';
import type { ReactNode } from 'react';
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
import { providerPackageKeys } from '../../../accounts/providers.ts';
import { useLevelSources } from '../../../chart/useLevelSources.ts';
import { setLevels } from '../../../state/tradeSettings.ts';
import { LevelHistorySection } from './LevelHistory.tsx';
import { Providers } from './Providers.tsx';
import { readSetting, saveSetting, useSetting } from '../../../state/runtimeSettings.ts';
import { defineSetting } from '../../../state/setting.ts';

const save = (next: LevelSettings) => setLevels(next);

function setAll(settings: LevelSettings, src: SourceDef, patch: Parameters<typeof setLevelStyle>[2], defs: LevelDefs) {
  return src.levels.reduce((s, l) => setLevelStyle(s, l.key, patch, defs), settings);
}

export function Levels() {
  const { sources, defs, infos } = useLevelSources();
  const theirs = providerPackageKeys(infos);
  const bands = new Map(sources.map((s) => [s.key, s] as const));
  return (
    <>
      <Providers sources={infos} defs={defs} bands={bands} />
      <div data-setting="levels.sources" className="st-group">
        <LevelsBands
          sources={sources.filter((s) => !theirs.has(s.key))}
          defs={defs}
          rows={{ 'tessera.ib': <InitialBalanceWindow /> }}
        />
      </div>
      <LevelHistorySection providerVendors={infos.map((p) => p.vendor)} />
    </>
  );
}

const IB_WINDOWS = [30, 60] as const;
const IB_MINUTES = defineSetting(
  'chart.initialBalanceMinutes',
  (v) => IB_WINDOWS.find((m) => m === v) ?? IB_WINDOWS[0],
);

function InitialBalanceWindow() {
  const minutes = useSetting(IB_MINUTES);
  return (
    <SettingsRow label="Window" help="From each market’s regular-session open. The analyst and Research read the same">
      <Choice<string>
        label="Initial balance window"
        value={String(minutes)}
        options={IB_WINDOWS.map((m) => ({ value: String(m), label: `${String(m)} min` }))}
        onChange={(v) => void saveSetting(IB_MINUTES, Number(v))}
      />
    </SettingsRow>
  );
}

export function LevelsBands({
  sources,
  defs,
  rows = {},
}: {
  sources: readonly SourceDef[];
  defs: LevelDefs;
  rows?: Readonly<Record<string, ReactNode>>;
}) {
  const settings = useSetting(LEVELS);
  return (
    <>
      {sources.map((src) => {
        const on = sourceOn(settings, src.key);
        const shown = src.levels.filter((l) => levelStyle(settings, l.key, defs).on).map((l) => l.key);
        const first = levelStyle(settings, src.levels[0]!.key, defs);
        return (
          <SettingsSection key={src.key} title={src.name} description={src.note} aria-label={src.name}>
            {rows[src.key] ?? null}
            <SettingsRow label="Draw its levels">
              <Switch
                label={`${src.name} levels`}
                checked={on}
                onCheckedChange={(v) => save(setSourceOn(readSetting(LEVELS), src.key, v))}
              />
            </SettingsRow>
            {src.levels.length > 1 ? (
              <SettingsRow label="Levels" layout="stack">
                <ToggleGroup
                  label={`${src.name} levels to draw`}
                  disabled={!on}
                  options={src.levels.map((l) => ({ value: l.key, label: l.name }))}
                  value={shown}
                  onToggle={(key, show) => save(setLevelStyle(readSetting(LEVELS), key, { on: show }, defs))}
                />
              </SettingsRow>
            ) : null}
            <SettingsRow label="Labels">
              <Choice<LevelLabel>
                label={`${src.name} labels`}
                value={first.label}
                locked={!on}
                options={LEVEL_LABELS.map((l) => ({
                  value: l,
                  label: l === 'short' ? `Short (${src.levels[0]!.short})` : LABEL_WORD[l],
                }))}
                onChange={(label) => save(setAll(readSetting(LEVELS), src, { label }, defs))}
              />
            </SettingsRow>
            <SettingsRow label="Distance from price" help="In points">
              <Switch
                label={`${src.name} distance from price`}
                disabled={!on}
                checked={first.distance}
                onCheckedChange={(distance) => save(setAll(readSetting(LEVELS), src, { distance }, defs))}
              />
            </SettingsRow>
          </SettingsSection>
        );
      })}
    </>
  );
}
