import { THEME_TABLES, type JsonValue } from '@tessera/protocol';
import { Button, Choice, ColorPicker, Switch, TOKENS, TextInput, Tooltip, cx } from '@tessera/ui';
import { useState, type KeyboardEvent } from 'react';
import {
  THEME_COLORS,
  THEME_FONTS,
  THEME_PRESETS,
  themeHex,
  themeKey,
  useChartTheme,
  type PresetId,
  type ResolvedChartTheme,
} from '../../../chart/chartTheme.ts';
import { useUi, type UpDownPalette, setUpDown } from '../../../state/ui.ts';
import { upDownOwnWords } from '../themes.ts';
import { BANDS, KEY, refusalWords, zonesChange, zonesShown } from '../chartColours.ts';
import { Row, Section, SettingSelect } from '../parts.tsx';
import { failureText } from '../../../app/tools.ts';
import { writeSetting } from '../../../state/runtimeSettings.ts';

const PALETTES: { id: UpDownPalette; label: string; up: string; down: string }[] = [
  { id: 'tessera', label: 'Tessera', up: TOKENS.up, down: TOKENS.down },
  { id: 'jade-coral', label: 'Jade · coral', ...THEME_TABLES.upDownPairs.jade_coral },
];

const fontRow = (key: string) => `chart.font.${key}`;

function SizeField({
  label,
  value,
  min,
  max,
  onSave,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onSave: (n: number) => Promise<void>;
}) {
  const [text, setText] = useState<string | null>(null);
  const out = text !== null && !(Number(text) >= min && Number(text) <= max);
  const commit = () => {
    if (text === null) return;
    const n = Number(text);
    if (out || !Number.isFinite(n) || n === value) {
      setText(null);
      return;
    }
    void onSave(n).then(() => setText(null));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && text !== null) {
      e.preventDefault();
      e.stopPropagation();
      setText(null);
    }
  };
  return (
    <span className="st-num">
      <TextInput
        inputMode="decimal"
        aria-label={label}
        unit="px"
        className={cx(out && 'is-invalid')}
        value={text ?? String(value)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </span>
  );
}

const CHART_KEYS: ReadonlySet<string> = new Set(THEME_COLORS.map(themeKey));

function chartOwn(r: ResolvedChartTheme): number {
  return [...r.overridden].filter((k) => CHART_KEYS.has(k)).length;
}

function useThemeChange() {
  const resolved = useChartTheme((s) => s.resolved);
  const [refused, setRefused] = useState<{ key: string; message: string } | null>(null);
  const preset = THEME_PRESETS.find((p) => p.id === resolved.chartPreset) ?? THEME_PRESETS[0];
  const change = async (value: JsonValue, key: string) => {
    const failed = await writeSetting(KEY, value, { merge: true }).then(
      () => null,
      (e: unknown) => failureText(e),
    );
    if (failed === null) setRefused((x) => (x?.key === key ? null : x));
    else setRefused({ key, message: refusalWords(failed, key) });
  };
  return { resolved, preset, refused, change };
}

export function LookSection() {
  const updown = useUi((s) => s.updown);
  const { resolved, preset, refused, change } = useThemeChange();
  const own = chartOwn(resolved);
  const changed = own > 0 || resolved.chartPreset !== THEME_PRESETS[0].id;
  const pair = PALETTES.find((p) => p.id === updown) ?? PALETTES[0]!;
  const themesPair = upDownOwnWords(resolved);
  const choice = (
    <Choice<UpDownPalette>
      label="Up and down colours"
      value={updown}
      locked={themesPair !== null}
      onChange={(v) => setUpDown(v)}
      options={PALETTES.map((p) => ({ value: p.id, label: p.label }))}
    />
  );
  return (
    <Section id="chart.look">
      <Row
        id="chart.updown"
        help={
          <span className="st-swatches">
            <i style={{ background: pair.up }} />
            <i style={{ background: pair.down }} />
          </span>
        }
      >
        {themesPair ? (
          <Tooltip content={themesPair}>
            <span>{choice}</span>
          </Tooltip>
        ) : (
          choice
        )}
      </Row>
      <Row
        id="chart.theme"
        help={
          own > 0 ? `${String(own)} ${own === 1 ? 'colour' : 'colours'} of your own over ${preset.label}` : undefined
        }
        error={refused?.key === 'preset' ? refused.message : null}
      >
        {changed ? (
          <Button size="s" variant="quiet" onClick={() => void change({ reset: true }, 'preset')}>
            Reset
          </Button>
        ) : null}
        <SettingSelect<PresetId>
          label="Chart look"
          value={resolved.chartPreset}
          onValueChange={(id) => void change({ preset: id }, 'preset')}
          options={THEME_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        />
      </Row>
      <Row id="chart.positionZones" error={refused?.key === 'zones' ? refused.message : null}>
        <Switch
          label="Position zones"
          checked={zonesShown(resolved)}
          onCheckedChange={(on) => void change(zonesChange(on), 'zones')}
        />
      </Row>
      {THEME_FONTS.map((f) => (
        <Row key={f.key} id={fontRow(f.key)}>
          <SizeField
            label={f.label}
            value={resolved.fonts[f.key]}
            min={f.min}
            max={f.max}
            onSave={(n) => change({ fonts: { [f.key]: n } }, `fonts.${f.key}`)}
          />
        </Row>
      ))}
    </Section>
  );
}

export function ChartColoursSection() {
  const { resolved, preset, refused, change } = useThemeChange();
  return (
    <Section id="chart.colours" bare>
      {BANDS.map((b) => (
        <div key={b.role} className="st-colours-band" data-setting={`chart.band.${b.groups[0]!}`}>
          <h3 className="st-sub">
            {b.role}
            {b.note ? <span className="st-sub-note">{b.note}</span> : null}
          </h3>
          <div className="st-colours">
            {THEME_COLORS.filter((c) => b.groups.includes(c.group)).map((c) => {
              const key = themeKey(c);
              const mine = resolved.overridden.has(key);
              return (
                <div key={key} className="st-colour" data-setting={`chart.colour.${key}`}>
                  <span className={cx('nm', mine && 'is-own')}>{c.label}</span>
                  <ColorPicker
                    label={c.label}
                    hint={c.about}
                    value={themeHex(resolved, key)}
                    alpha
                    error={refused?.key === key ? refused.message : null}
                    onChange={(hex) => void change({ [c.group]: { [c.key]: hex } }, key)}
                    {...(mine
                      ? {
                          onReset: () => void change({ [c.group]: { [c.key]: null } }, key),
                          resetLabel: `Back to ${preset.label}'s`,
                        }
                      : {})}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Section>
  );
}
