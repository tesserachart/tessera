import { COLOR_SWATCHES, type LineDash } from '@tessera/protocol';
import {
  ColorPicker,
  Combobox,
  Menu,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  TextInput,
  Tooltip,
  cx,
} from '@tessera/ui';
import { useState, type KeyboardEvent } from 'react';
import { TIME_ZONE_OPTIONS, useDisplayZone, zoneLabel } from '../../state/timeZone.ts';
import { colorOf, isSessionHours, themeSwatches } from '../indicators.ts';
import { colorName, parseNumber, parseStudyTime, stepDecimals, stepNumber, studyTimeText, WIDTHS } from './model.ts';

export interface NumberInputProps {
  value: number;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  integer?: boolean;
  unit?: string;
  zeroLabel?: string | undefined;
  label: string;
  id?: string;
  onChange: (value: number) => void;
}

export function NumberInput({
  value,
  min,
  max,
  step,
  integer,
  unit,
  zeroLabel,
  label,
  id,
  onChange,
}: NumberInputProps) {
  const d = integer ? 0 : stepDecimals(step);
  const shown = zeroLabel !== undefined && value === 0 ? '' : value.toFixed(d);
  const [text, setText] = useState<string | null>(null);
  const draft = text ?? shown;
  const cleared = (t: string) => zeroLabel !== undefined && t.trim() === '';
  const valid = cleared(draft) || parseNumber(draft, { min, max, integer }) !== null;
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = parseNumber(draft, { integer }) ?? value;
      const next = stepNumber(base, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1), { step, min, max });
      setText(null);
      onChange(next);
    } else if (e.key === 'Enter' || e.key === 'Escape') {
      setText(null);
    }
  };
  return (
    <div className={cx('t-input', 'is-num', !valid && 'is-invalid')}>
      <input
        id={id}
        aria-label={label}
        aria-invalid={!valid || undefined}
        inputMode={integer ? 'numeric' : 'decimal'}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        placeholder={zeroLabel}
        onChange={(e) => {
          setText(e.target.value);
          const v = cleared(e.target.value) ? 0 : parseNumber(e.target.value, { min, max, integer });
          if (v !== null && v !== value) onChange(v);
        }}
        onBlur={() => setText(null)}
        onKeyDown={onKey}
      />
      {unit ? <span className="unit">{unit}</span> : null}
    </div>
  );
}

export function SessionHoursInput({
  value,
  label,
  id,
  onChange,
}: {
  value: string;
  label: string;
  id?: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const draft = text ?? value;
  const valid = isSessionHours(draft);
  const commit = () => {
    const next = text?.trim();
    if (next !== undefined && next !== value && isSessionHours(next)) onChange(next);
    setText(null);
  };
  return (
    <TextInput
      id={id}
      className={cx('is-num', !valid && 'is-invalid')}
      aria-label={label}
      aria-invalid={!valid || undefined}
      autoComplete="off"
      spellCheck={false}
      value={draft}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setText(null);
      }}
    />
  );
}

export function StudyTimeInput({
  value,
  label,
  id,
  onChange,
}: {
  value: string;
  label: string;
  id?: string;
  onChange: (value: string) => void;
}) {
  const zone = useDisplayZone();
  const [text, setText] = useState<string | null>(null);
  const shown = studyTimeText(value, zone);
  const draft = text ?? shown;
  const parsed = parseStudyTime(draft, zone);
  const commit = () => {
    if (text !== null && parsed !== null && parsed !== value) onChange(parsed);
    setText(null);
  };
  return (
    <TextInput
      id={id}
      className={cx('is-num', 'is-time', parsed === null && 'is-invalid')}
      aria-label={label}
      aria-invalid={parsed === null || undefined}
      autoComplete="off"
      spellCheck={false}
      placeholder="In view"
      value={draft}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setText(null);
      }}
    />
  );
}

export function TimeZoneSelect({
  value,
  label,
  id,
  onChange,
}: {
  value: string;
  label: string;
  id?: string;
  onChange: (zone: string) => void;
}) {
  return (
    <Combobox
      id={id}
      size="s"
      align="end"
      className="ind-select"
      label={label}
      value={value}
      placeholder={zoneLabel(value)}
      searchPlaceholder="Search time zones"
      options={TIME_ZONE_OPTIONS}
      onValueChange={onChange}
    />
  );
}

export function Check({
  checked,
  label,
  hideLabel,
  onChange,
}: {
  checked: boolean;
  label: string;
  hideLabel?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      className={cx('t-check', 'ind-check', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="box" />
      {hideLabel ? null : label}
    </button>
  );
}

export function SelectField<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  label: string;
  onChange: (value: T) => void;
}) {
  return (
    <Select<T>
      size="s"
      align="end"
      className="ind-select"
      contentClassName="ind-menu"
      label={label}
      value={value}
      options={options}
      onValueChange={onChange}
    />
  );
}

export interface ColorControlChange {
  color: string;
  opacity?: number;
}

export function ColorControl({
  color,
  opacity,
  analyst = false,
  label,
  onChange,
}: {
  color: string;
  opacity?: number;
  analyst?: boolean;
  label: string;
  onChange: (next: ColorControlChange, gesture: string) => void;
}) {
  const palette = themeSwatches();
  const swatches = COLOR_SWATCHES.map((s) => ({ value: s, name: colorName(s), color: colorOf(s, palette) }));
  return (
    <ColorPicker
      label={label}
      hint={analyst ? `${label}: the analyst's aqua until you choose one` : label}
      value={analyst ? colorOf('aqua', palette) : color}
      {...(analyst ? { valueName: "the analyst's aqua" } : {})}
      {...(opacity !== undefined ? { opacity } : {})}
      alpha
      swatches={swatches}
      align="center"
      triggerClassName="ind-swatch-btn"
      onChange={(c, change) =>
        onChange(opacity === undefined ? { color: c } : { color: c, opacity: change.opacity }, change.gesture)
      }
    />
  );
}

const DASHES: readonly { value: LineDash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dash', label: 'Dashed' },
  { value: 'dot', label: 'Dotted' },
];

function Stroke({ width, line }: { width: number; line: LineDash }) {
  const dash =
    line === 'dash'
      ? `${String(5 * Math.max(1, width * 0.8))} 4`
      : line === 'dot'
        ? `${String(Math.max(1, width))} 3`
        : undefined;
  return (
    <svg className="ind-stroke" width="28" height="12" viewBox="0 0 28 12" aria-hidden="true">
      <line x1="0" x2="28" y1="6" y2="6" stroke="currentColor" strokeWidth={width} strokeDasharray={dash} />
    </svg>
  );
}

export function LineControl({
  width,
  line,
  label,
  onChange,
}: {
  width: number;
  line: LineDash;
  label: string;
  onChange: (next: { width?: number; line?: LineDash }) => void;
}) {
  const dashWord = DASHES.find((d) => d.value === line)?.label ?? line;
  return (
    <Menu modal={false}>
      <Tooltip content={label}>
        <MenuTrigger asChild>
          <button
            type="button"
            className="ind-line-btn"
            aria-label={`${label}: ${String(width)} px, ${dashWord.toLowerCase()}`}
          >
            <Stroke width={width} line={line} />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" className="ind-menu" style={{ minWidth: 168 }}>
        <MenuLabel>Width</MenuLabel>
        <MenuRadioGroup value={String(width)} onValueChange={(v) => onChange({ width: Number(v) })}>
          {WIDTHS.map((w) => (
            <MenuRadioItem key={w} value={String(w)} hint={`${String(w)} px`}>
              <Stroke width={w} line="solid" />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>Line</MenuLabel>
        <MenuRadioGroup value={line} onValueChange={(v) => onChange({ line: v as LineDash })}>
          {DASHES.map((d) => (
            <MenuRadioItem key={d.value} value={d.value} hint={d.label}>
              <Stroke width={Math.max(1.5, width)} line={d.value} />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
