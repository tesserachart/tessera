import type { Order } from '@tessera/protocol';
import { Icon, Tooltip, toneOf, PRICE_TEXT, cx, formatMoney } from '@tessera/ui';
import type { TradeRow } from './tradeRows.ts';

export function TicketOrders({
  rows,
  symbol,
  onCancel,
  merge,
}: {
  rows: readonly TradeRow[];
  symbol: string;
  onCancel?: (orders: readonly Order[], what: string) => void;
  merge?: { pairs: number; onMerge: () => void; busy?: boolean } | null;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="tk-trade" aria-label={`${symbol} orders`}>
      {merge ? (
        <div className="tk-row tk-merge" data-kind="merge">
          <span className="w">{`${String(merge.pairs)} brackets on the position`}</span>
          <Tooltip content="One stop at the tightest, one target at the nearest, for the whole position">
            <button type="button" className="tk-merge-go" disabled={merge.busy} onClick={merge.onMerge}>
              Merge into one
            </button>
          </Tooltip>
          <span className="tk-x-room" />
        </div>
      ) : null}
      {rows.map((r) => (
        <div
          key={r.key}
          className="tk-row"
          data-kind={r.kind}
          data-of={r.of ?? undefined}
          data-held={r.held || undefined}
        >
          <span className={cx('w', PRICE_TEXT)}>
            {r.words}
            {r.joins ? <span className="tk-joins"> · joins the bracket</span> : null}
          </span>
          <span className={cx('m', PRICE_TEXT)} data-tone={r.money === null ? undefined : toneOf(r.money)}>
            {r.money === null ? '' : formatMoney(r.money, { signed: true })}
          </span>
          {onCancel && r.cancels.length > 0 ? (
            <Tooltip
              content={
                r.joins
                  ? `Cancel ${lower(r.words)}; when it fills, the position's stop and target grow by its size`
                  : `Cancel ${lower(r.words)}`
              }
            >
              <button
                type="button"
                className="tk-x"
                aria-label={`Cancel ${lower(r.words)}`}
                onClick={() => onCancel(r.cancels, r.words)}
              >
                <Icon name="cancel" />
              </button>
            </Tooltip>
          ) : (
            <span className="tk-x-room" />
          )}
        </div>
      ))}
    </section>
  );
}

function lower(words: string): string {
  return words.charAt(0).toLowerCase() + words.slice(1);
}
