import { FormRow, FormSection, Segmented, Select, Switch, modifierLabel, usePlatform } from '@tessera/ui';
import {
  DOM_ROW_TICKS,
  PULL_STACK_WINDOWS,
  rowWord,
  type DomParams,
  type DomRowTicks,
  type PullStackWindow,
  type TradedColumns,
  type VolumeColumn,
} from './ladderModel.ts';

const TRADED: readonly { value: TradedColumns; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'session', label: 'Session' },
  { value: 'recent', label: 'Last minute' },
];

const VOLUMES: readonly { value: VolumeColumn; label: string }[] = [
  { value: 'session', label: 'Session' },
  { value: 'recent', label: 'Last minute' },
  { value: 'off', label: 'Off' },
];

export interface DomSettingsProps {
  params: DomParams;
  onChange: (patch: Partial<DomParams>) => void;
}

export function DomSettings({ params: p, onChange }: DomSettingsProps) {
  const platform = usePlatform();
  return (
    <FormSection aria-label="Ladder settings">
      <FormRow label="Row size" htmlFor="dom-rows" hint={`${modifierLabel('mod', platform)} + scroll steps it`}>
        <Select
          id="dom-rows"
          size="s"
          value={String(p.rowTicks)}
          options={DOM_ROW_TICKS.map((n) => ({ value: String(n), label: rowWord(n) }))}
          onValueChange={(v) => onChange({ rowTicks: Number(v) as DomRowTicks })}
        />
      </FormRow>
      <FormRow label="Volume">
        <Segmented
          label="Volume column"
          options={VOLUMES}
          value={p.volumeColumn}
          onChange={(volumeColumn) => onChange({ volumeColumn })}
        />
      </FormRow>
      <FormRow label="Traded at bid · ask">
        <Segmented
          label="Traded at the bid and the ask"
          options={TRADED}
          value={p.traded}
          onChange={(traded) => onChange({ traded })}
        />
      </FormRow>
      <FormRow label="Pulled · stacked" htmlFor="dom-ps" hint="Fills excluded; shows when the ladder has room">
        <Select
          id="dom-ps"
          size="s"
          value={String(p.pullStack)}
          options={PULL_STACK_WINDOWS.map((n) => ({
            value: String(n),
            label: n === 0 ? 'Off' : `Last ${String(n)} s`,
          }))}
          onValueChange={(v) => onChange({ pullStack: Number(v) as PullStackWindow })}
        />
      </FormRow>
      <FormRow label="Orders per level" htmlFor="dom-orders">
        <Switch id="dom-orders" checked={p.orders} onCheckedChange={(orders) => onChange({ orders })} />
      </FormRow>
      <FormRow label="Refills" htmlFor="dom-refills" hint="Levels that traded more than they showed">
        <Switch id="dom-refills" checked={p.refills} onCheckedChange={(refills) => onChange({ refills })} />
      </FormRow>
      <FormRow label="Queue position" htmlFor="dom-queue">
        <Switch id="dom-queue" checked={p.queue} onCheckedChange={(queue) => onChange({ queue })} />
      </FormRow>
      <FormRow label="P&L in ticks" htmlFor="dom-pnl">
        <Switch id="dom-pnl" checked={p.pnl} onCheckedChange={(pnl) => onChange({ pnl })} />
      </FormRow>
      <FormRow label="Auto-centre" htmlFor="dom-centre" hint="Never while the pointer is on the ladder">
        <Switch id="dom-centre" checked={p.autoCentre} onCheckedChange={(autoCentre) => onChange({ autoCentre })} />
      </FormRow>
    </FormSection>
  );
}
