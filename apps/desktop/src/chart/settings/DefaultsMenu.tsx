import { type IndicatorSpec } from '@tessera/protocol';
import { ICON_BUTTON, Icon, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, cx } from '@tessera/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  DEFAULTS_LABEL,
  matches,
  NAME_MAX,
  presetNamed,
  presetsOf,
  resetSettings,
  sameSettings,
  settingsFrom,
} from '../presets/model.ts';
import { saveDefault, savePreset } from '../presets/actions.ts';
import { usePresets } from '../presets/store.ts';
import type { IndicatorSettings } from '../indicators.ts';
import type { ChartRef } from './store.ts';
import { failureText, toolCode, toolReason } from '../../app/tools.ts';
import { afterOpenerTakesFocus } from '../focus.ts';

export interface DefaultsTarget {
  chart: ChartRef;
  layerId: string;
  indicator: string;
}

function message(err: unknown): string {
  if (toolCode(err) === null) return failureText(err);
  const why = toolReason(err);
  return why.charAt(0).toUpperCase() + why.slice(1);
}

/** Radix's menu typeahead takes the character keys typed anywhere inside the menu. */
function NameForm({
  taken,
  error,
  busy,
  onChange,
  onCommit,
}: {
  taken: (name: string) => boolean;
  error: string | null;
  busy: boolean;
  onChange: () => void;
  onCommit: (name: string) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => afterOpenerTakesFocus(() => ref.current?.focus()), []);
  const ok = text.trim() !== '' && !busy;
  return (
    <div className="tpl-form" role="group" aria-label="Save preset as">
      <div className="tpl-form-row">
        <div className={cx('t-input', 'tpl-name', error && 'is-error')}>
          <input
            ref={ref}
            aria-label="Preset name"
            placeholder="Preset name"
            value={text}
            maxLength={NAME_MAX}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              onChange();
            }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Escape') return;
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                if (ok) onCommit(text);
              }
            }}
          />
        </div>
        <button type="button" className="tpl-verb" disabled={!ok} onClick={() => onCommit(text)}>
          {taken(text) ? 'Replace' : 'Save'}
        </button>
      </div>
      {error ? (
        <div className="tpl-err" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function DefaultsMenu({
  target,
  spec,
  settings,
  onChange,
  colorsChanged = false,
  onResetColors,
}: {
  target: DefaultsTarget;
  spec: IndicatorSpec;
  settings: IndicatorSettings;
  onChange: (fn: (s: IndicatorSettings) => IndicatorSettings) => void;
  colorsChanged?: boolean;
  onResetColors?: () => void;
}) {
  const presets = usePresets((s) => s.presets);
  const defaults = usePresets((s) => s.defaults);
  const all = { presets, defaults };
  const mine = presetsOf(all, target.indicator);
  const saved = defaults[target.indicator] ?? null;
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = resetSettings(all, target.indicator, spec, settings);
  const atReset = sameSettings(spec, settings, reset);
  const isDefault = saved !== null && matches(spec, settings, saved);

  const run = async (act: () => Promise<unknown>, close = true) => {
    setBusy(true);
    setError(null);
    try {
      await act();
      if (close) setOpen(false);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setNaming(false);
          setError(null);
        }
      }}
    >
      <MenuTrigger asChild>
        <button
          type="button"
          className={cx(
            ICON_BUTTON,
            'flex items-center gap-1 w-auto h-7 pr-1 pl-2 font-sans text-meta leading-none font-normal normal-nums data-[state=open]:text-t1 data-[state=open]:bg-raise',
          )}
          aria-label={DEFAULTS_LABEL}
        >
          {DEFAULTS_LABEL}
          <Icon name="chevron-down" className="text-inherit [--icon:14px]" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="ct-menu ind-defaults-menu">
        <MenuItem
          disabled={atReset && !colorsChanged}
          onSelect={() => {
            onChange((s) => resetSettings(all, target.indicator, spec, s));
            onResetColors?.();
          }}
        >
          Reset settings
        </MenuItem>
        <MenuItem
          current={isDefault}
          disabled={busy || isDefault}
          onSelect={(e) => {
            e.preventDefault();
            void run(() => saveDefault(target.chart, target.layerId));
          }}
        >
          Save as default
        </MenuItem>
        {mine.length > 0 ? <MenuSeparator /> : null}
        {mine.map((p) => (
          <MenuItem
            key={p.id}
            current={matches(spec, settings, p.params)}
            onSelect={() => onChange((s) => settingsFrom(spec, p.params, s))}
          >
            {p.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        {naming ? (
          <NameForm
            taken={(name) => presetNamed(all, target.indicator, name) !== null}
            error={error}
            busy={busy}
            onChange={() => setError(null)}
            onCommit={(name) => void run(() => savePreset(target.chart, target.layerId, name.trim()))}
          />
        ) : (
          <MenuItem
            onSelect={(e) => {
              e.preventDefault();
              setNaming(true);
            }}
          >
            Save preset as…
          </MenuItem>
        )}
        {error && !naming ? (
          <div className="tpl-err" role="alert">
            {error}
          </div>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
