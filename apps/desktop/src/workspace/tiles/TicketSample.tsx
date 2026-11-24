import type { Side } from '@tessera/protocol';
import { Icon, Segmented, Stepper, Switch, cx, formatMoney, PRICE_TEXT } from '@tessera/ui';
import { DayReadout } from '../../chart/ticket/Ticket.tsx';
import type { PositionReadout } from '../../chart/ticket/tradeRows.ts';
import { GRID_ORDERS, gridWord, type GridOrder } from '../../shell/ticket.ts';
import { SAMPLE_ACCOUNTS } from './samples.ts';

const ACCOUNT = SAMPLE_ACCOUNTS[0]!;
const POSITION: PositionReadout = { words: 'Long 2 @ 21,480.25', qty: 2, pnl: 450, instrument: 'NQZ6.CME' };
const FRESH = { position: null, prices: null };
const PRESETS = ['1', '2', '5', '10'].map((q) => ({ value: q, label: q }));
const EXITS = ['Cancel', 'Breakeven', 'Reverse', 'Flat'];
const TOUCH = '00,000.00';

const leaveTicket = () => undefined;

function OrderButton({ side, order }: { side: Side; order: GridOrder }) {
  const word = gridWord(side, order);
  return (
    <span className="tk-hit">
      <button type="button" className="tk-order" data-side={side}>
        {order === 'touch' ? (
          <>
            <span className="long">{word}</span>
            <span className="short">{side === 'buy' ? 'Bid' : 'Ask'}</span>
            <span className={PRICE_TEXT}>{TOUCH}</span>
          </>
        ) : (
          word
        )}
      </button>
    </span>
  );
}

export function TicketSample() {
  return (
    <section className="tk" aria-label="Ticket">
      <header className="tk-head">
        <b className="tk-sym">NQ Z6</b>
        <button type="button" className="tk-acct">
          <span className="nm">{ACCOUNT.account.displayName}</span>
          <span className={cx('nl', PRICE_TEXT)}>{formatMoney(ACCOUNT.summary.netLiq)}</span>
          <Icon name="chevron-down" className="chev" />
        </button>
      </header>
      <div className="tk-body">
        <DayReadout update={ACCOUNT} position={POSITION} stale={FRESH} />
        <section className="tk-sec tk-act" aria-label="Order">
          <div className="tk-size">
            <Stepper className="tk-amount" size="s" label="Contracts" value={1} min={1} onValueChange={leaveTicket} />
            <Segmented
              className="tk-presets"
              label="Contract presets"
              options={PRESETS}
              value="1"
              onChange={leaveTicket}
            />
            <span className="tk-risk">
              <Switch checked={false}>Risk</Switch>
            </span>
          </div>
          <div className="tk-grid" role="group" aria-label="Orders">
            {GRID_ORDERS.map((o) => (
              <div key={o} className="tk-grid-row" data-order={o}>
                <OrderButton side="buy" order={o} />
                {o === 'stop_limit' ? (
                  <span className="tk-hit">
                    <Stepper
                      className="tk-offset"
                      size="s"
                      buttons={false}
                      label="Stop limit’s limit, in ticks past its stop"
                      value={0}
                      min={0}
                      prefix="±"
                      suffix="t"
                      onValueChange={leaveTicket}
                    />
                  </span>
                ) : null}
                <OrderButton side="sell" order={o} />
              </div>
            ))}
            <div className="tk-grid-row is-exits">
              {EXITS.map((word) => (
                <span key={word} className="tk-hit">
                  <button type="button" className={cx('tk-exit', word === 'Flat' && 'is-primary')}>
                    {word}
                  </button>
                </span>
              ))}
            </div>
          </div>
        </section>
        <section className="tk-sec tk-bracket" aria-label="Bracket">
          <div className="tk-sec-head">
            <button type="button" className="tk-fold" data-press="none">
              <span className="t">Bracket</span>
              <span className={cx('sum', PRICE_TEXT)}>-20t · +40t</span>
              <Icon name="chevron-down" className="chev" />
            </button>
            <Switch label="Bracket" checked />
          </div>
        </section>
      </div>
    </section>
  );
}
