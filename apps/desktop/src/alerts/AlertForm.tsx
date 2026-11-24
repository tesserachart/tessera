import type { AlertDelivery, EvaluateOn, Timeframe } from '@tessera/protocol';
import {
  Button,
  Check,
  FormActions,
  FormHint,
  FormRow,
  PriceInput,
  Segmented,
  Select,
  Switch,
  TextInput,
} from '@tessera/ui';
import { useId, type SyntheticEvent } from 'react';
import {
  EXPIRIES,
  FORM_INTERVALS,
  FORM_OPS,
  PRICE,
  VALUE_KEY,
  eventSubject,
  isEvent,
  isSweep,
  readsPlot,
  stackSubject,
  stepValue,
  usesInterval,
  withOp,
  withSubject,
  withTarget,
  type AlertForm,
  type Expiry,
  type FormOp,
} from './form.ts';

export interface AlertFormViewProps {
  form: AlertForm;
  onChange: (f: AlertForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
  price: number | null;
  discord: boolean;
  busy?: boolean;
  error?: string | null;
  saved?: { paused: boolean; onPause: () => void; onDelete: () => void } | null;
}

const ON: readonly { value: EvaluateOn; label: string }[] = [
  { value: 'trade', label: 'Any trade' },
  { value: 'bar_close', label: 'Bar close' },
];

const REPEAT: readonly { value: 'once' | 'every'; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'every', label: 'Every time' },
];

export function AlertFormView({
  form,
  onChange,
  onSubmit,
  onCancel,
  price,
  discord,
  busy,
  error,
  saved,
}: AlertFormViewProps) {
  const id = useId();
  const f = form;
  const set = (patch: Partial<AlertForm>) => onChange({ ...f, ...patch });
  const subjects = f.choices
    .filter((c) => c.key === PRICE.key || c.operand.kind === 'plot' || isEvent(c.operand))
    .map((c) => ({ value: c.key, label: c.label }));
  const targets = [
    { value: VALUE_KEY, label: 'A price' },
    ...f.choices
      .filter((c) => c.key !== PRICE.key && !isEvent(c.operand))
      .map((c) => ({ value: c.key, label: c.label })),
  ];
  const flow = eventSubject(f);
  const stack = stackSubject(f);
  const sweep = isSweep(f.op);
  const plot = readsPlot(f);
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!busy) onSubmit();
  };
  const deliver = (k: keyof AlertDelivery) => (on: boolean) => set({ deliver: { ...f.deliver, [k]: on } });
  return (
    <form className="al-form" onSubmit={submit} aria-label={f.id ? 'Change the alert' : 'New alert'}>
      <div className="al-form-head">
        <b>{f.symbol}</b>
        <span className="text-t3 font-normal">{f.id ? 'Alert' : 'New alert'}</span>
      </div>
      {f.fixed ? (
        <FormHint className="al-fixed">{f.fixed.title}</FormHint>
      ) : (
        <>
          <FormRow label="When" htmlFor={`${id}-subject`} layout="fill">
            <Select
              id={`${id}-subject`}
              size="s"
              label="When"
              value={f.subject}
              options={subjects}
              onValueChange={(k) => onChange(withSubject(f, k))}
            />
          </FormRow>
          <FormRow label="Condition" htmlFor={`${id}-op`} layout="fill">
            <Select<FormOp>
              id={`${id}-op`}
              size="s"
              label="Condition"
              value={f.op}
              options={FORM_OPS.map((o) => ({
                ...o,
                disabled: flow
                  ? o.value !== 'at_least'
                  : o.value === 'at_least' || (isSweep(o.value) && f.subject !== PRICE.key),
              }))}
              onValueChange={(op) => onChange(withOp(f, op))}
            />
          </FormRow>
          {flow ? (
            <FormRow label={stack ? 'Stack' : 'Size'} htmlFor={`${id}-size`} layout="fill">
              <TextInput
                id={`${id}-size`}
                size="s"
                inputMode="numeric"
                value={f.value}
                unit={stack ? 'rows' : 'contracts'}
                onChange={(e) => set({ value: e.target.value })}
                autoFocus={f.id === null}
              />
            </FormRow>
          ) : (
            <FormRow label={sweep ? 'Level' : 'Of'} htmlFor={`${id}-target`} layout="fill">
              <Select
                id={`${id}-target`}
                size="s"
                label="Target"
                value={f.target}
                options={targets}
                onValueChange={(k) => onChange(withTarget(f, k, price))}
              />
            </FormRow>
          )}
          {f.target === VALUE_KEY && !flow ? (
            <FormRow label="Price" htmlFor={`${id}-price`} layout="fill">
              <PriceInput
                id={`${id}-price`}
                aria-label="Price"
                value={f.value}
                onChange={(value) => set({ value })}
                onStep={(ticks) => onChange(stepValue(f, ticks, price))}
                autoFocus={f.id === null}
              />
            </FormRow>
          ) : null}
          {flow ? null : sweep ? (
            <FormRow label="Within" htmlFor={`${id}-within`} layout="fill">
              <TextInput
                id={`${id}-within`}
                size="s"
                inputMode="numeric"
                value={f.within}
                unit="bars"
                onChange={(e) => set({ within: e.target.value })}
              />
            </FormRow>
          ) : (
            <FormRow label="On" layout="fill">
              <Segmented<EvaluateOn>
                label="Evaluated on"
                value={plot ? 'bar_close' : f.on}
                options={ON.map((o) => ({ ...o, disabled: plot && o.value === 'trade' }))}
                onChange={(on) => set({ on })}
              />
            </FormRow>
          )}
        </>
      )}
      {f.fixed && f.fixed.steps.length > 1 ? (
        <FormRow label="Within" htmlFor={`${id}-within`} layout="fill">
          <TextInput
            id={`${id}-within`}
            size="s"
            inputMode="numeric"
            value={f.within}
            unit="bars"
            onChange={(e) => set({ within: e.target.value })}
          />
        </FormRow>
      ) : null}
      {usesInterval(f) ? (
        <FormRow label="Interval" htmlFor={`${id}-tf`} layout="fill">
          <Select<Timeframe>
            id={`${id}-tf`}
            size="s"
            label="Interval"
            value={f.interval}
            options={(FORM_INTERVALS.includes(f.interval) ? FORM_INTERVALS : [f.interval, ...FORM_INTERVALS]).map(
              (t) => ({ value: t, label: t }),
            )}
            onValueChange={(interval) => set({ interval })}
          />
        </FormRow>
      ) : null}
      <FormRow label="Fires" layout="fill">
        <span className="al-repeat">
          <Segmented label="Fires" value={f.repeat} options={REPEAT} onChange={(repeat) => set({ repeat })} />
          {f.repeat === 'every' ? (
            <TextInput
              size="s"
              aria-label="Cool-down"
              className="al-cool"
              inputMode="numeric"
              value={f.cooldown}
              unit="s apart"
              onChange={(e) => set({ cooldown: e.target.value })}
            />
          ) : null}
        </span>
      </FormRow>
      <FormRow label="Expires" htmlFor={`${id}-exp`} layout="fill">
        <Select<Expiry>
          id={`${id}-exp`}
          size="s"
          label="Expires"
          value={f.expiry}
          options={[...(f.expiry === 'keep' ? [{ value: 'keep' as const, label: 'As set' }] : []), ...EXPIRIES]}
          onValueChange={(expiry) => set({ expiry })}
        />
      </FormRow>
      <FormRow label="Message" htmlFor={`${id}-msg`} layout="fill">
        <TextInput
          id={`${id}-msg`}
          size="s"
          maxLength={500}
          value={f.message}
          onChange={(e) => set({ message: e.target.value })}
        />
      </FormRow>
      <div className="al-deliver" role="group" aria-label="Deliver to">
        <Check checked={f.deliver.sound} onChange={deliver('sound')}>
          Sound
        </Check>
        <Check checked={f.deliver.desktop} onChange={deliver('desktop')}>
          Desktop
        </Check>
        <Check
          checked={f.deliver.discord}
          onChange={deliver('discord')}
          title={discord ? undefined : 'Set a Discord webhook in Settings › Alerts & sounds'}
        >
          Discord{discord ? '' : ' (not set)'}
        </Check>
      </div>
      {f.canAsk ? (
        <FormRow label="Ask the analyst to look" hint="A turn in the session that set it" htmlFor={`${id}-ask`}>
          <Switch id={`${id}-ask`} checked={f.askAnalyst} onCheckedChange={(askAnalyst) => set({ askAnalyst })} />
        </FormRow>
      ) : null}
      {error ? (
        <p className="al-err" role="alert">
          {error}
        </p>
      ) : null}
      <FormActions
        start={
          saved ? (
            <>
              <Button size="s" variant="quiet" disabled={busy} onClick={saved.onDelete}>
                Delete
              </Button>
              <Button size="s" variant="quiet" disabled={busy} onClick={saved.onPause}>
                {saved.paused ? 'Resume' : 'Pause'}
              </Button>
            </>
          ) : undefined
        }
      >
        <Button size="s" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="s" variant="primary" type="submit" disabled={busy}>
          {f.id ? 'Save' : 'Create'}
        </Button>
      </FormActions>
    </form>
  );
}
