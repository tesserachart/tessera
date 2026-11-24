import type { InputValue } from '@tessera/chart';
import type { IndicatorInput, IndicatorSpec } from '@tessera/protocol';
import { ColorPicker, ICON_BUTTON, Icon, Segmented, Tooltip, cx } from '@tessera/ui';
import { Fragment, useId, useState, type ReactNode } from 'react';
import { analystPlot, defaultSettings, isDefault, type IndicatorSettings } from '../indicators.ts';
import {
  Check,
  ColorControl,
  LineControl,
  NumberInput,
  SelectField,
  SessionHoursInput,
  StudyTimeInput,
  TimeZoneSelect,
} from './controls.tsx';
import { DefaultsMenu, type DefaultsTarget } from './DefaultsMenu.tsx';
import { DEFAULTS_LABEL, presetLabel } from '../presets/model.ts';
import {
  studyColorsChanged,
  studyThemeKeys,
  THEME_COLORS,
  themeChange,
  themeHex,
  themeKey,
  useChartTheme,
  type ThemeKey,
} from '../chartTheme.ts';
import { writeSetting } from '../../state/runtimeSettings.ts';
import { KEY as CHART_THEME } from '../../areas/settings/chartColours.ts';
import { usePresets } from '../presets/store.ts';
import { inputRows, liveOptionNotes, shownUnder, SOURCE_OPTIONS } from './model.ts';

type Tab = 'inputs' | 'style';

export function IndicatorSettingsForm({
  spec,
  settings,
  agent,
  side = 'bottom',
  notes,
  defaults,
  onChange,
}: {
  spec: IndicatorSpec;
  settings: IndicatorSettings;
  defaults?: DefaultsTarget | undefined;
  agent: boolean;
  side?: 'top' | 'bottom';
  notes?: Readonly<Record<string, string>> | undefined;
  onChange: (fn: (s: IndicatorSettings) => IndicatorSettings) => void;
}) {
  const hasInputs = spec.inputs.length > 0;
  const themed = studyThemeKeys(spec.kind);
  const hasStyle = spec.plots.length > 0 || spec.fills.length > 0 || themed.length > 0;
  const resolved = useChartTheme((s) => s.resolved);
  const presets = usePresets((s) => s);
  const label = presetLabel(presets, defaults?.indicator ?? null, spec, settings);
  const modified = label === null || studyColorsChanged(resolved, spec.kind);
  const shownLabel = defaults && label === DEFAULTS_LABEL ? null : label;
  const setThemed = (k: ThemeKey, hex: string | null) =>
    void writeSetting(CHART_THEME, themeChange(k, hex), { merge: true }).catch((err: unknown) => {
      console.warn(`[chart theme] ${k} not saved`, err);
    });
  const resetColors = () => {
    for (const k of themed) if (resolved.overridden.has(k)) setThemed(k, null);
  };
  const [tab, setTab] = useState<Tab>(hasInputs ? 'inputs' : 'style');
  const id = useId();
  const setInput = (key: string, v: InputValue) => onChange((s) => ({ ...s, inputs: { ...s.inputs, [key]: v } }));
  const setPlot = (key: string, patch: Partial<IndicatorSettings['plots'][string]>) =>
    onChange((s) => ({ ...s, plots: { ...s.plots, [key]: { ...s.plots[key]!, ...patch } } }));
  const setFill = (key: string, patch: Partial<IndicatorSettings['fills'][string]>) =>
    onChange((s) => ({ ...s, fills: { ...s.fills, [key]: { ...s.fills[key]!, ...patch } } }));
  const setLabels = (patch: Partial<NonNullable<IndicatorSettings['labels']>>) =>
    onChange((s) => (s.labels ? { ...s, labels: { ...s.labels, ...patch } } : s));
  const labels = settings.labels;
  const pristine = isDefault(spec, settings);
  const on = (by: string | null) => by === null || settings.inputs[by] === true;
  const shown = spec.plots.filter((p) => on(p.shownBy));
  const series = shown.filter((p) => p.kind !== 'hline');
  const guides = shown.filter((p) => p.kind === 'hline');
  const plots = [...series, ...guides];
  const fills = spec.fills.filter((f) => on(f.shownBy));
  const aqua = analystPlot(spec, settings, agent);

  const control = (i: IndicatorInput, unit?: string): ReactNode => {
    const v = settings.inputs[i.key] ?? i.default;
    switch (i.type) {
      case 'int':
      case 'number':
        return (
          <NumberInput
            id={`${id}-${i.key}`}
            label={i.label}
            value={typeof v === 'number' ? v : Number(i.default)}
            min={i.min}
            max={i.max}
            step={i.step}
            integer={i.type === 'int'}
            zeroLabel={i.zeroLabel}
            {...(unit ? { unit } : {})}
            onChange={(n) => setInput(i.key, n)}
          />
        );
      case 'source':
        return (
          <SelectField
            value={String(v)}
            options={SOURCE_OPTIONS}
            label={i.label}
            onChange={(s) => setInput(i.key, s)}
          />
        );
      case 'enum':
        if (i.segmented)
          return (
            <Segmented
              label={i.label}
              value={String(v)}
              options={(i.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
              onChange={(s) => setInput(i.key, s)}
            />
          );
        return (
          <SelectField
            value={String(v)}
            options={(i.options ?? []).map((o) => {
              const note = notes?.[`${i.key}.${o.value}`];
              return note ? { value: o.value, label: `${o.label} · ${note}` } : o;
            })}
            label={i.label}
            onChange={(s) => setInput(i.key, s)}
          />
        );
      case 'bool':
        return <Check checked={v === true} label={i.label} onChange={(on) => setInput(i.key, on)} />;
      case 'color':
        return <ColorControl color={String(v)} label={i.label} onChange={(c) => setInput(i.key, c.color)} />;
      case 'session':
        return (
          <SessionHoursInput
            id={`${id}-${i.key}`}
            label={i.label}
            value={String(v)}
            onChange={(s) => setInput(i.key, s)}
          />
        );
      case 'time':
        return (
          <StudyTimeInput
            id={`${id}-${i.key}`}
            label={i.label}
            value={String(v)}
            onChange={(t) => setInput(i.key, t)}
          />
        );
      case 'timezone':
        return (
          <TimeZoneSelect
            id={`${id}-${i.key}`}
            label={i.label}
            value={String(v)}
            onChange={(z) => setInput(i.key, z)}
          />
        );
    }
  };

  const aside = (i: IndicatorInput): ReactNode => {
    const live = liveOptionNotes(i, notes);
    if (live === null && !i.hint) return null;
    return (
      <div className="ind-aside">
        {live === null ? null : <p className="is-live">{live}</p>}
        {i.hint ? <p>{i.hint}</p> : null}
      </div>
    );
  };

  const under = (inputs: readonly IndicatorInput[]): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (let k = 0; k < inputs.length; k++) {
      const u = inputs[k]!;
      if (u.type === 'bool') {
        const checks = [u];
        while (inputs[k + 1]?.type === 'bool') checks.push(inputs[++k]!);
        rows.push(
          <div key={u.key} className="ind-row is-sub is-checks">
            {checks.map((c) => (
              <span key={c.key}>{control(c)}</span>
            ))}
          </div>,
        );
      } else
        rows.push(
          <Fragment key={u.key}>
            <div className="ind-row is-sub">
              <label className="lab" htmlFor={`${id}-${u.key}`}>
                {u.label}
              </label>
              {control(u)}
            </div>
            {aside(u)}
          </Fragment>,
        );
    }
    return rows;
  };

  const inputsPanel = (
    <div className="ind-rows" role="group" aria-label="Inputs">
      {inputRows(spec.inputs).map((row) => {
        const { input, paired } = row;
        return row.under ? (
          <div key={input.key} className="ind-pair">
            <div className="ind-row">
              <label className="lab" htmlFor={`${id}-${input.key}`}>
                {input.label}
              </label>
              {control(input)}
            </div>
            {aside(input)}
            {under(shownUnder(row, settings.inputs[input.key]))}
          </div>
        ) : paired ? (
          <div key={input.key} className="ind-row">
            {control(input)}
            {control(paired, paired.label.slice(input.label.length + 1))}
          </div>
        ) : input.type === 'bool' ? (
          <Fragment key={input.key}>
            <div className="ind-row">{control(input)}</div>
            {aside(input)}
          </Fragment>
        ) : (
          <Fragment key={input.key}>
            <div className="ind-row">
              <label className="lab" htmlFor={`${id}-${input.key}`}>
                {input.label}
              </label>
              {control(input)}
            </div>
            {aside(input)}
          </Fragment>
        );
      })}
    </div>
  );
  const stylePanel = (
    <div className="ind-rows" role="group" aria-label="Style">
      {plots.map((p, k) => {
        const st = settings.plots[p.key] ?? p.default;
        return (
          <div
            key={p.key}
            className={cx(
              'ind-row',
              'ind-style',
              !st.visible && 'is-off',
              k === series.length && k > 0 && 'is-first-guide',
            )}
          >
            <Check checked={st.visible} label={p.label} hideLabel onChange={(on) => setPlot(p.key, { visible: on })} />
            <span className="lab">{p.label}</span>
            <ColorControl
              color={st.color}
              opacity={st.opacity}
              analyst={aqua === p.key}
              label={p.kind === 'histogram' && p.colorBy ? `${p.label} up colour` : `${p.label} colour`}
              onChange={(c) => setPlot(p.key, c)}
            />
            {p.kind === 'histogram' ? (
              p.colorBy ? (
                <ColorControl
                  color={st.downColor ?? st.color}
                  label={`${p.label} down colour`}
                  onChange={(c) => setPlot(p.key, { downColor: c.color })}
                />
              ) : (
                <span />
              )
            ) : (
              <LineControl
                width={st.width}
                line={st.line}
                label={`${p.label} line`}
                onChange={(l) => setPlot(p.key, l)}
              />
            )}
          </div>
        );
      })}
      {fills.length > 0 ? <div className="ind-sep" /> : null}
      {fills.map((f) => {
        const st = settings.fills[f.key] ?? f.default;
        return (
          <div key={f.key} className={cx('ind-row', 'ind-style', !st.visible && 'is-off')}>
            <Check checked={st.visible} label={f.label} hideLabel onChange={(on) => setFill(f.key, { visible: on })} />
            <span className="lab">{f.label}</span>
            <ColorControl
              color={st.color}
              opacity={st.opacity}
              label={`${f.label} colour`}
              onChange={(c) => setFill(f.key, c)}
            />
            <span />
          </div>
        );
      })}
      {themed.length > 0 ? (
        <div className="ind-themed" role="group" aria-label="Colours">
          {themed.map((k) => {
            const name = THEME_COLORS.find((c) => themeKey(c) === k)?.label ?? k;
            return (
              <div key={k} className="ind-row ind-style">
                <span />
                <span className="lab">{name}</span>
                <ColorPicker
                  label={name}
                  value={themeHex(resolved, k)}
                  alpha
                  align="center"
                  triggerClassName="ind-swatch-btn"
                  onChange={(hex) => setThemed(k, hex)}
                />
                <span />
              </div>
            );
          })}
        </div>
      ) : null}
      {labels ? (
        <div className="ind-labels" role="group" aria-label="Labels">
          <div className="ind-row">
            <Check
              checked={labels.priceScale}
              label="Labels on price scale"
              onChange={(on) => setLabels({ priceScale: on })}
            />
          </div>
          <div className="ind-row">
            <Check checked={labels.name} label="Name at line end" onChange={(on) => setLabels({ name: on })} />
            {labels.name ? (
              <Check checked={labels.value} label="With value" onChange={(on) => setLabels({ value: on })} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );

  const tabs =
    hasInputs && hasStyle ? (
      <Segmented<Tab>
        label="Settings"
        className="ind-tabs"
        options={[
          { value: 'inputs', label: 'Inputs' },
          { value: 'style', label: 'Style' },
        ]}
        value={tab}
        onChange={setTab}
      />
    ) : null;
  const body = tab === 'inputs' && hasInputs ? inputsPanel : stylePanel;

  return (
    <div className="ind-form" data-side={side}>
      <div className="ind-form-head">
        <span className="ttl">{spec.title}</span>
        <span className="ind-preset" role="status" aria-label="Preset">
          {shownLabel ?? ''}
          {modified ? <span className="ind-modified">Modified</span> : null}
        </span>
        {defaults ? (
          <DefaultsMenu
            target={defaults}
            spec={spec}
            settings={settings}
            onChange={onChange}
            colorsChanged={studyColorsChanged(resolved, spec.kind)}
            onResetColors={resetColors}
          />
        ) : (
          <Tooltip content="Reset to defaults">
            <button
              type="button"
              className={cx(ICON_BUTTON, 'ind-act')}
              aria-label="Reset to defaults"
              disabled={pristine && !studyColorsChanged(resolved, spec.kind)}
              onClick={() => {
                onChange((s) => defaultSettings(spec, s));
                resetColors();
              }}
            >
              <Icon name="reset" className="text-inherit" />
            </button>
          </Tooltip>
        )}
      </div>
      {side === 'top' ? (
        <>
          {body}
          {tabs}
        </>
      ) : (
        <>
          {tabs}
          {body}
        </>
      )}
      <p className="ind-agent-note">You can also ask your agent to change this.</p>
    </div>
  );
}
