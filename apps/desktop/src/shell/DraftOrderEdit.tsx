import type { OrderInput, Side } from '@tessera/protocol';
import { Button, Check, FormRow, PriceInput, Segmented, Stepper, parseStep } from '@tessera/ui';
import { useId, useState } from 'react';
import { useAccountUpdates } from '../app/portfolio.ts';
import { stableStringify } from '../app/stableJson.ts';
import { useInstrumentSpec } from '../market/instruments.ts';
import { useQuote } from '../market/quotes.ts';
import { useTradeSettings } from '../state/tradeSettings.ts';
import { DEFAULT_OCO, contractMath, instrumentRoot, knownContract, planOco } from './oco.ts';
import {
  ORDER_TYPES,
  ORDER_TYPE_WORD,
  OrderEditError,
  editedOrderInput,
  entryPrice,
  legHint,
  orderEditOf,
  stepPriceText,
  usesLimit,
  usesStop,
  withLegOn,
  withOrderType,
  type LegRole,
  type OrderEdit,
} from './orderEdit.ts';
import { ocoMarket, resolveOco } from './tradeContext.ts';

const SIDES: readonly { value: Side; label: string }[] = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
];

const LEG_WORD: Record<LegRole, string> = { stop: 'Stop', target: 'Target' };

function whole(text: string): number | null {
  const n = parseStep(text);
  return n === null ? null : Math.floor(n);
}

export function DraftOrderEdit({
  input,
  busy,
  error,
  onSave,
  onCancel,
}: {
  input: OrderInput;
  busy: boolean;
  error: string | null;
  onSave: (next: OrderInput | null) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const spec = useInstrumentSpec(input.instrument);
  const root = instrumentRoot(input.instrument, spec?.root ?? null);
  const math = spec ? contractMath(spec) : knownContract(root);
  const last = useQuote(spec?.instrument ?? input.instrument)?.last ?? null;
  const update = useAccountUpdates()?.find((u) => u.account.id === input.accountId) ?? null;
  const oco = useTradeSettings((s) => resolveOco(s, input.accountId, root));
  const [edit, setEdit] = useState<OrderEdit>(() => orderEditOf(input, math));
  const [invalid, setInvalid] = useState<string | null>(null);
  const market = ocoMarket(math, edit.qty, update);
  const plan = market ? planOco(oco, market) : null;
  const ticksFor = (role: LegRole) =>
    (role === 'stop' ? plan?.stopTicks : plan?.targetTicks) ?? DEFAULT_OCO[role].value;
  const change = (next: OrderEdit) => {
    setInvalid(null);
    setEdit(next);
  };
  const fallback = entryPrice(edit, math) ?? last;

  const priceRow = (field: 'limitPrice' | 'stopPrice', label: string) => (
    <FormRow label={label} htmlFor={`${id}-${field}`} layout="fill">
      <PriceInput
        id={`${id}-${field}`}
        aria-label={label}
        value={edit[field]}
        onChange={(text) => change({ ...edit, [field]: text })}
        onStep={(n) => change({ ...edit, [field]: stepPriceText(edit[field], n, math, last) })}
      />
    </FormRow>
  );

  const legRow = (role: LegRole) => {
    const leg = edit[role];
    const word = LEG_WORD[role];
    return (
      <FormRow
        className="leg"
        data-role={role}
        label={
          <Check checked={leg.on} onChange={(on) => change(withLegOn(edit, role, on, math, ticksFor(role)))}>
            {word}
          </Check>
        }
        hint={legHint(edit, role, math) ?? undefined}
        layout="fill"
      >
        {leg.at.kind === 'price' ? (
          <PriceInput
            aria-label={`${word} price`}
            disabled={!leg.on}
            value={leg.at.text}
            onChange={(text) => change({ ...edit, [role]: { ...leg, at: { kind: 'price', text } } })}
            onStep={(n) => {
              const text = leg.at.kind === 'price' ? leg.at.text : '';
              change({
                ...edit,
                [role]: { ...leg, at: { kind: 'price', text: stepPriceText(text, n, math, fallback) } },
              });
            }}
          />
        ) : (
          <Stepper
            size="s"
            label={`${word} distance in ticks`}
            value={leg.at.ticks}
            min={1}
            parse={whole}
            inputMode="numeric"
            suffix="t"
            disabled={!leg.on}
            onValueChange={(ticks) => change({ ...edit, [role]: { ...leg, at: { kind: 'ticks', ticks } } })}
          />
        )}
      </FormRow>
    );
  };

  return (
    <section className="approval is-editing" aria-label="Edit the draft">
      <form
        className="edit-order"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const next = editedOrderInput(input, edit, math);
            onSave(stableStringify(next) === stableStringify(input) ? null : next);
          } catch (err) {
            if (!(err instanceof OrderEditError)) throw err;
            setInvalid(err.message);
          }
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          onCancel();
        }}
      >
        <FormRow label="Side" layout="fill">
          <Segmented<Side>
            label="Side"
            options={SIDES}
            value={edit.side}
            onChange={(side) => change({ ...edit, side })}
          />
        </FormRow>
        <FormRow label="Type" layout="fill">
          <Segmented
            label="Order type"
            options={ORDER_TYPES.map((t) => ({ value: t, label: ORDER_TYPE_WORD[t] }))}
            value={edit.orderType}
            onChange={(t) => change(withOrderType(edit, t, math, last))}
          />
        </FormRow>
        <FormRow label="Contracts" htmlFor={`${id}-qty`} layout="fill">
          <Stepper
            id={`${id}-qty`}
            size="s"
            label="Contracts"
            value={edit.qty}
            min={1}
            shiftSteps={5}
            inputMode="numeric"
            parse={whole}
            onValueChange={(qty) => change({ ...edit, qty })}
          />
        </FormRow>
        {usesStop(edit.orderType) ? priceRow('stopPrice', 'Stop price') : null}
        {usesLimit(edit.orderType) ? priceRow('limitPrice', 'Limit price') : null}
        {input.reduceOnly ? null : (
          <>
            {legRow('stop')}
            {legRow('target')}
          </>
        )}
        <div className="foot">
          <Button size="s" variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="s" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
      {invalid || error ? (
        <p className="err" role="alert" data-selectable>
          {invalid ?? error}
        </p>
      ) : null}
    </section>
  );
}
