import { FormRow, FormSection, Segmented, Select, Stepper, Switch } from '@tessera/ui';
import { TAPE_SIZES, TAPE_SPEED_WORDS, TAPE_SPEEDS, stepMinSize, type TapeParams, type TapeSide } from './tapeModel.ts';

const SIDES: readonly { value: TapeSide; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'buy', label: 'Buys' },
  { value: 'sell', label: 'Sells' },
];

const SPEEDS = TAPE_SPEEDS.map((value) => ({ value, label: TAPE_SPEED_WORDS[value] }));

const sizeWord = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });
const withCurrent = (current: number) =>
  [...new Set([...TAPE_SIZES, current])].filter((n) => n > 0).sort((a, b) => a - b);

export interface TapeSettingsProps {
  params: TapeParams;
  onChange: (patch: Partial<TapeParams>) => void;
  autoSize: number | null;
}

export function TapeSettings({ params: p, onChange, autoSize }: TapeSettingsProps) {
  const auto = autoSize !== null ? `Auto · ${sizeWord(autoSize)}` : 'Auto';
  return (
    <FormSection aria-label="Time & sales settings">
      <FormRow label="Min size" htmlFor="tape-min">
        <Stepper
          id="tape-min"
          size="s"
          label="Min size"
          value={p.minSize}
          min={0}
          fit
          format={(n) => (n === 0 ? 'Every size' : sizeWord(n))}
          onStep={(by) => onChange({ minSize: stepMinSize(p.minSize, by) })}
          onValueChange={(minSize) => onChange({ minSize })}
        />
      </FormRow>
      <FormRow label="Highlight from" htmlFor="tape-hl">
        <Select
          id="tape-hl"
          size="s"
          value={String(p.highlight)}
          options={[
            { value: 'auto', label: auto },
            ...withCurrent(p.highlight === 'auto' ? 25 : p.highlight).map((n) => ({
              value: String(n),
              label: `≥ ${sizeWord(n)}`,
            })),
          ]}
          onValueChange={(v) => onChange({ highlight: v === 'auto' ? 'auto' : Number(v) })}
        />
      </FormRow>
      <FormRow label="Side">
        <Segmented label="Side" options={SIDES} value={p.side} onChange={(side) => onChange({ side })} />
      </FormRow>
      <FormRow label="Speed">
        <Segmented label="Tape speed" options={SPEEDS} value={p.speed} onChange={(speed) => onChange({ speed })} />
      </FormRow>
      <FormRow label="Aggregate prints" htmlFor="tape-agg" hint="One row per aggressor order">
        <Switch id="tape-agg" checked={p.aggregate} onCheckedChange={(aggregate) => onChange({ aggregate })} />
      </FormRow>
      <FormRow label="Milliseconds" htmlFor="tape-ms">
        <Switch id="tape-ms" checked={p.millis} onCheckedChange={(millis) => onChange({ millis })} />
      </FormRow>
    </FormSection>
  );
}
