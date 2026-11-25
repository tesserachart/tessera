import type { CaseResult } from '@tessera/protocol';
import { Icon, NumberCell, PRICE_TEXT, TBody, TGroup, THead, Table, Td, Th, Tooltip, Tr, cx } from '@tessera/ui';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { EXIT_WORD } from '../../chart/linkedTradeLayer.ts';
import { SPLIT_WORD, numberedTrades, sideWord, sortTrades, tradeTime, type TradeKey } from './tester.ts';

const COLUMNS: readonly { key: TradeKey | null; label: string; align: 'left' | 'right' }[] = [
  { key: null, label: '#', align: 'right' },
  { key: 'entryTime', label: 'Entry', align: 'left' },
  { key: 'side', label: 'Side', align: 'left' },
  { key: null, label: 'Entry price', align: 'right' },
  { key: null, label: 'Exit price', align: 'right' },
  { key: 'exit', label: 'Exit', align: 'left' },
  { key: 'bars', label: 'Bars', align: 'right' },
  { key: 'mae', label: 'MAE', align: 'right' },
  { key: 'mfe', label: 'MFE', align: 'right' },
  { key: 'pnl', label: 'P&L', align: 'right' },
];

export function TradeList({
  base,
  picked,
  onShow,
}: {
  base: CaseResult;
  picked: number | null;
  onShow: (n: number) => void;
}) {
  const rows = useMemo(() => numberedTrades(base), [base]);
  const [sort, setSort] = useState<TradeKey>('entryTime');
  const [ascending, setAscending] = useState(true);
  const sorted = useMemo(() => sortTrades(rows, sort, ascending), [rows, sort, ascending]);
  const table = useRef<HTMLTableElement>(null);
  useEffect(() => {
    table.current?.querySelector('tr[data-selected]')?.scrollIntoView({ block: 'center' });
  }, []);
  const sortBy = (key: TradeKey) => {
    if (key === sort) setAscending(!ascending);
    else {
      setSort(key);
      setAscending(key === 'entryTime');
    }
  };
  if (!rows.length) return <p className="rs-quiet">No trades in this run.</p>;
  return (
    <Table ref={table} className="rs-tlist" aria-label="Trades">
      <THead>
        <tr>
          {COLUMNS.map((c) => (
            <Th
              key={c.label}
              align={c.align}
              aria-sort={c.key && c.key === sort ? (ascending ? 'ascending' : 'descending') : undefined}
            >
              {c.key ? (
                <button
                  type="button"
                  className={cx('rs-sort', c.key === sort && 'is-sorted')}
                  onClick={() => sortBy(c.key!)}
                >
                  {c.label}
                  {c.key === sort ? <Icon name={ascending ? 'sort-asc' : 'sort-desc'} aria-hidden /> : null}
                </button>
              ) : (
                c.label
              )}
            </Th>
          ))}
          <Th aria-label="Chart" />
        </tr>
      </THead>
      <TBody>
        {sorted.map((r, i) => {
          const t = r.trade;
          const opens = sort === 'entryTime' && r.split !== sorted[i - 1]?.split;
          const on = picked === r.n;
          return (
            <Fragment key={r.n}>
              {opens ? (
                <TGroup colSpan={COLUMNS.length + 1}>
                  {SPLIT_WORD[r.split]} · {rows.filter((x) => x.split === r.split).length}
                </TGroup>
              ) : null}
              <Tr selected={on} className="rs-trow" onDoubleClick={() => onShow(r.n)}>
                <Td align="right" className="t3">
                  {r.n}
                </Td>
                <Td>
                  <span className={PRICE_TEXT}>{tradeTime(t.entryTime)}</span>
                </Td>
                <Td className={t.qty > 0 ? 'up' : 'down'}>{sideWord(t)}</Td>
                <NumberCell value={t.entryPrice} kind="price" />
                <NumberCell value={t.exitPrice} kind="price" />
                <Td>
                  {EXIT_WORD[t.exit]}
                  {t.approximate ? (
                    <Tooltip content="Found on the bar's high and low: no saved prints that session">
                      <span className="rs-approx" tabIndex={0}>
                        {' '}
                        ≈
                      </span>
                    </Tooltip>
                  ) : null}
                </Td>
                <NumberCell value={t.bars} kind="int" />
                <NumberCell value={t.mae} kind="pnl" precision={0} />
                <NumberCell value={t.mfe} kind="pnl" precision={0} />
                <NumberCell value={t.pnl} kind="pnl" precision={0} />
                <Td align="right" className="rs-tchart">
                  <Tooltip content="Show on chart">
                    <button
                      type="button"
                      className="rs-chartlink"
                      aria-label={`Show trade ${String(r.n)} on the chart`}
                      onClick={() => onShow(r.n)}
                    >
                      <Icon name="chart" aria-hidden />
                    </button>
                  </Tooltip>
                </Td>
              </Tr>
            </Fragment>
          );
        })}
      </TBody>
    </Table>
  );
}
