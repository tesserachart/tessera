import { Choice, SettingsRow, SettingsSection, Switch, ToggleGroup } from '@tessera/ui';
import type { ReactNode } from 'react';
import {
  LABEL_WORD,
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
import { useTradeSettings, useTradeSettingsSync, tradeSettingsStore, setLevels } from '../../../state/tradeSettings.ts';
import { LevelHistorySection } from './LevelHistory.tsx';
import { Providers } from './Providers.tsx';
import { read } from '../../../app/store.ts';
import { setRuntimeSetting, useRuntimeSetting } from '../../../state/runtimeSettings.ts';

const store = () => read(tradeSettingsStore);
const save = (next: LevelSettings) => setLevels(next);

function setAll(settings: LevelSettings, src: SourceDef, patch: Parameters<typeof setLevelStyle>[2], defs: LevelDefs) {
  return src.levels.reduce((s, l) => setLevelStyle(s, l.key, patch, defs), settings);
}

export function Levels() {
  useTradeSettingsSync();
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

const IB_MINUTES = 'chart.initialBalanceMinutes';
const IB_WINDOWS = [30, 60] as const;

function InitialBalanceWindow() {
  const value = useRuntimeSetting(IB_MINUTES);
  const minutes = IB_WINDOWS.find((m) => m === value) ?? IB_WINDOWS[0];
  return (
    <SettingsRow label="Window" help="From each market’s regular-session open. The analyst and Research read the same">
      <Choice<string>
        label="Initial balance window"
        value={String(minutes)}
        options={IB_WINDOWS.map((m) => ({ value: String(m), label: `${String(m)} min` }))}
        onChange={(v) => void setRuntimeSetting(IB_MINUTES, Number(v))}
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
  const settings = useTradeSettings((s) => s.levels);
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
                onCheckedChange={(v) => save(setSourceOn(store().levels, src.key, v))}
              />
            </SettingsRow>
            {src.levels.length > 1 ? (
              <SettingsRow label="Levels" layout="stack">
                <ToggleGroup
                  label={`${src.name} levels to draw`}
                  disabled={!on}
                  options={src.levels.map((l) => ({ value: l.key, label: l.name }))}
                  value={shown}
                  onToggle={(key, show) => save(setLevelStyle(store().levels, key, { on: show }, defs))}
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
                onChange={(label) => save(setAll(store().levels, src, { label }, defs))}
              />
            </SettingsRow>
            <SettingsRow label="Distance from price" help="In points">
              <Switch
                label={`${src.name} distance from price`}
                disabled={!on}
                checked={first.distance}
                onCheckedChange={(distance) => save(setAll(store().levels, src, { distance }, defs))}
              />
            </SettingsRow>
          </SettingsSection>
        );
      })}
    </>
  );
}
