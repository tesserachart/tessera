import type { Side } from '@tessera/protocol';
import { Stepper, Tooltip, cx, parseStep, PRICE_TEXT } from '@tessera/ui';
import { BREAKEVEN_KEY } from '../../shell/keys.ts';
import type { OrderKeyAction } from '../../shell/orderHotkeys.ts';
import { GRID_ORDERS, gridWord, type GridOrder } from '../../shell/ticket.ts';
import { MAX_STOP_LIMIT_TICKS, patchTicket } from '../../state/tickets.ts';
import { useOrderKeys } from './commands.ts';
import { keyOfButton } from './orderKeys.ts';
import { px, type TicketModel } from './useTicketModel.ts';

export function OrderGrid({ m, tileId }: { m: TicketModel; tileId: string }) {
  const keys = useOrderKeys();
  const keyOf = (action: OrderKeyAction | null) => {
    const k = action ? keys[action] : undefined;
    return k ? { shortcut: k } : {};
  };
  const button = (side: Side, o: GridOrder) => {
    const armed = m.armed(side, o);
    const at = o === 'touch' ? (side === 'buy' ? m.bid : m.ask) : null;
    const word = gridWord(side, o);
    return (
      <Tooltip key={side} content={m.tip(side, o)} {...keyOf(keyOfButton(side, o))}>
        <span className="tk-hit">
          <button
            type="button"
            className={cx('tk-order', armed && 'is-armed')}
            data-side={side}
            aria-pressed={armed}
            aria-label={o === 'touch' ? `${word} ${px(at, m.dp)}` : word}
            disabled={m.off(side, o)}
            onClick={() => m.press(side, o)}
          >
            {o === 'touch' ? (
              <>
                <span className="long">{word}</span>
                <span className="short">{side === 'buy' ? 'Bid' : 'Ask'}</span>
                <span className={PRICE_TEXT}>{px(at, m.dp)}</span>
              </>
            ) : (
              word
            )}
          </button>
        </span>
      </Tooltip>
    );
  };
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
        <Tooltip content={m.cancelTip} {...keyOf('cancelAll')}>
          <span className="tk-hit">
            <button type="button" className="tk-exit" disabled={m.cancelOff} onClick={m.cancelHere}>
              Cancel
            </button>
          </span>
        </Tooltip>
        <Tooltip content={m.beTip} shortcut={BREAKEVEN_KEY}>
          <span className="tk-hit">
            <button type="button" className="tk-exit" disabled={m.beOff} onClick={m.breakevenHere}>
              Breakeven
            </button>
          </span>
        </Tooltip>
        <Tooltip content={m.revTip} {...keyOf('reverse')}>
          <span className="tk-hit">
            <button type="button" className="tk-exit" disabled={m.revOff} onClick={m.reverseHere}>
              Reverse
            </button>
          </span>
        </Tooltip>
        <Tooltip content={m.flatTip} {...keyOf('flatten')}>
          <span className="tk-hit">
            <button
              type="button"
              className={cx('tk-exit', m.position.qty !== 0 && 'is-primary')}
              disabled={m.flatOff}
              onClick={m.flattenHere}
            >
              Flat
            </button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
