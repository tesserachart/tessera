import type { Side } from '@tessera/protocol';
import { Stepper, Tooltip, cx, parseStep, PRICE_TEXT } from '@tessera/ui';
import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { BREAKEVEN_KEY } from '../../shell/keys.ts';
import type { OrderKeyAction } from '../../shell/orderHotkeys.ts';
import { GRID_ORDERS, gridWord, type GridOrder } from '../../shell/ticket.ts';
import { MAX_STOP_LIMIT_TICKS, patchTicket } from '../../state/tickets.ts';
import { useOrderKeys } from './commands.ts';
import { keyOfButton } from './orderKeys.ts';
import { px, type TicketModel } from './useTicketModel.ts';

type ExitAction = 'cancelHere' | 'breakevenHere' | 'reverseHere' | 'flattenHere';

export function OrderGrid({ m, tileId }: { m: TicketModel; tileId: string }) {
  const keys = useOrderKeys();
  const shortcutOf = (action: OrderKeyAction | null) => (action ? keys[action] : undefined);
  const latest = useRef(m);
  useLayoutEffect(() => {
    latest.current = m;
  });
  const press = useCallback((side: Side, o: GridOrder) => latest.current.press(side, o), []);
  const exit = useCallback((action: ExitAction) => latest.current[action](), []);
  const button = (side: Side, o: GridOrder) => (
    <GridButton
      key={side}
      side={side}
      order={o}
      word={gridWord(side, o)}
      price={o === 'touch' ? px(side === 'buy' ? m.bid : m.ask, m.dp) : null}
      armed={m.armed(side, o)}
      disabled={m.off(side, o)}
      tip={m.tip(side, o)}
      shortcut={shortcutOf(keyOfButton(side, o))}
      onPress={press}
    />
  );
  const ticks = m.setup.stopLimitTicks;
  return (
    <div className="tk-grid" role="group" aria-label={`${m.symbol} orders`}>
      {GRID_ORDERS.map((o) => (
        <div
          key={o}
          className="tk-grid-row"
          data-order={o}
          data-trust={o === 'touch' ? m.stale.prices?.trust : undefined}
        >
          {button('buy', o)}
          {o === 'stop_limit' ? (
            <Tooltip
              content={
                ticks === 0
                  ? 'A stop limit’s limit sits at its stop'
                  : `A stop limit’s limit: ${String(ticks)} ${ticks === 1 ? 'tick' : 'ticks'} past its stop, above a buy’s and below a sell’s`
              }
            >
              <span className="tk-hit">
                <Stepper
                  className="tk-offset"
                  size="s"
                  buttons={false}
                  label="Stop limit’s limit, in ticks past its stop"
                  value={ticks}
                  min={0}
                  max={MAX_STOP_LIMIT_TICKS}
                  shiftSteps={1}
                  inputMode="numeric"
                  parse={(t) => {
                    const n = parseStep(t);
                    return n === null ? null : Math.floor(n);
                  }}
                  prefix="±"
                  suffix="t"
                  onValueChange={(n) => patchTicket(tileId, { stopLimitTicks: n })}
                />
              </span>
            </Tooltip>
          ) : null}
          {button('sell', o)}
        </div>
      ))}
      <div className="tk-grid-row is-exits">
        <ExitButton
          label="Cancel"
          action="cancelHere"
          tip={m.cancelTip}
          shortcut={shortcutOf('cancelAll')}
          disabled={m.cancelOff}
          onPress={exit}
        />
        <ExitButton
          label="Breakeven"
          action="breakevenHere"
          tip={m.beTip}
          shortcut={BREAKEVEN_KEY}
          disabled={m.beOff}
          onPress={exit}
        />
        <ExitButton
          label="Reverse"
          action="reverseHere"
          tip={m.revTip}
          shortcut={shortcutOf('reverse')}
          disabled={m.revOff}
          onPress={exit}
        />
        <ExitButton
          label="Flat"
          action="flattenHere"
          tip={m.flatTip}
          shortcut={shortcutOf('flatten')}
          disabled={m.flatOff}
          primary={m.position.qty !== 0}
          onPress={exit}
        />
      </div>
    </div>
  );
}

const GridButton = memo(function GridButton({
  side,
  order,
  word,
  price,
  armed,
  disabled,
  tip,
  shortcut,
  onPress,
}: {
  side: Side;
  order: GridOrder;
  word: string;
  price: string | null;
  armed: boolean;
  disabled: boolean;
  tip: string;
  shortcut: string | undefined;
  onPress: (side: Side, order: GridOrder) => void;
}) {
  return (
    <Tooltip content={tip} {...(shortcut ? { shortcut } : {})}>
      <span className="tk-hit">
        <button
          type="button"
          className={cx('tk-order', armed && 'is-armed')}
          data-side={side}
          aria-pressed={armed}
          aria-label={price === null ? word : `${word} ${price}`}
          disabled={disabled}
          onClick={() => onPress(side, order)}
        >
          {price === null ? (
            word
          ) : (
            <>
              <span className="long">{word}</span>
              <span className="short">{side === 'buy' ? 'Bid' : 'Ask'}</span>
              <span className={PRICE_TEXT}>{price}</span>
            </>
          )}
        </button>
      </span>
    </Tooltip>
  );
});

const ExitButton = memo(function ExitButton({
  label,
  action,
  tip,
  shortcut,
  disabled,
  primary = false,
  onPress,
}: {
  label: string;
  action: ExitAction;
  tip: string;
  shortcut: string | undefined;
  disabled: boolean;
  primary?: boolean;
  onPress: (action: ExitAction) => void;
}) {
  return (
    <Tooltip content={tip} {...(shortcut ? { shortcut } : {})}>
      <span className="tk-hit">
        <button
          type="button"
          className={cx('tk-exit', primary && 'is-primary')}
          disabled={disabled}
          onClick={() => onPress(action)}
        >
          {label}
        </button>
      </span>
    </Tooltip>
  );
});
