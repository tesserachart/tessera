import { normalizeEpochMs, type Fill, type Order, type Position } from '@tessera/protocol';
import {
  Button,
  Loaded,
  NumberCell,
  ScrollArea,
  Table,
  TBody,
  TGroup,
  Td,
  Th,
  Tr,
  formatClock,
  formatPrice,
  PRICE_TEXT,
  cx,
} from '@tessera/ui';
import type { IDockviewPanelHeaderProps, IDockviewPanelProps } from 'dockview-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { useTodaysFills } from '../../accounts/fills.ts';
import { useHoldings, usePositions } from '../../app/portfolio.ts';
import { restingPrice } from '../../chart/brackets.ts';
import { displaySymbol, useInstrumentSpec } from '../../market/instruments.ts';
import { useQuoteSource } from '../../market/quotes.ts';
import { pricesStale, streamStale, useFeeds, type Feeds, type Stale } from '../../shell/freshness.ts';
import { useOrderEntry } from '../../shell/orderEntry.ts';
import { useShellData } from '../../shell/shellData.ts';
import { positionWord } from '../../shell/ticket.ts';
import { cancelOrders, firstFailure, flatten } from '../../shell/tradeActions.ts';
import { useTileEmpty } from '../dock/edgeRest.ts';
import { setTileParams, tileParams, useTileSettings, useTileSettingsVersion } from '../dock/tileSettings.ts';
import { useTradingKnown } from './known.ts';
import { Refused } from './parts.tsx';
import { registerTile, type TileScopeProps } from './registry.ts';
import { SAMPLE_FILLS, SAMPLE_ORDERS, SAMPLE_POSITIONS } from './samples.ts';
import { ScopeChip } from '../dock/header/Scope.tsx';
import { displayZone } from '../../state/timeZone.ts';

interface PositionsSettings {
  account: string;
}
const ALL = 'all';

type AccountNames = ReadonlyMap<string, string>;

function onAccount<T>(items: readonly T[], account: string, id: (t: T) => string): T[] {
  return account === ALL ? [...items] : items.filter((t) => id(t) === account);
}

function useRows(account: string) {
  const { allOrders, tradingKnown } = useShellData();
  const allPositions = usePositions();
  return useMemo(
    () => ({
      positions: onAccount(allPositions ?? [], account, (p) => p.accountId),
      orders: onAccount(allOrders, account, (o) => o.request.accountId),
      known: tradingKnown,
    }),
    [account, allPositions, allOrders, tradingKnown],
  );
}

function useFillsNewestFirst(account: string): Fill[] | null {
  const fills = useTodaysFills();
  return useMemo(() => (fills ? onAccount(fills, account, (f) => f.accountId).reverse() : null), [fills, account]);
}

function useAccountNames(): AccountNames {
  const { accounts } = useShellData();
  return useMemo(() => new Map(accounts.map((a) => [a.id, a.displayName])), [accounts]);
}

function nameOf(names: AccountNames, id: string): string {
  return names.get(id) ?? id;
}

function PositionCells({
  p,
  dp,
  account,
  position,
  pnl,
  act,
}: {
  p: Position;
  dp: number;
  account: string;
  position: Stale | null;
  pnl: Stale | null;
  act: ReactNode;
}) {
  return (
    <Tr data-trust={position?.trust}>
      <Td className="sym-cell">
        <b>{displaySymbol(p.instrument)}</b>
      </Td>
      <Td>
        <span className={p.qty >= 0 ? 'up' : 'down'}>{positionWord(p.qty)}</span>
      </Td>
      <NumberCell value={p.avgPrice} precision={dp} />
      <NumberCell value={p.mark} precision={dp} data-trust={pnl?.trust} />
      <NumberCell
        value={p.unrealizedPnl?.amount ?? null}
        kind="pnl"
        {...(pnl ? { tone: 'muted' as const, 'data-trust': pnl.trust } : {})}
      />
      <NumberCell value={p.realizedPnl.amount} kind="pnl" />
      <Td className="t3 col-account">{account}</Td>
      <Td align="right" className="col-act">
        <span className="pz-acts">{act}</span>
      </Td>
    </Tr>
  );
}

function PositionRow({ p, account, feeds }: { p: Position; account: string; feeds: Feeds }) {
  const { accounts } = useShellData();
  const position = streamStale(feeds);
  const pnl = pricesStale(feeds, useQuoteSource(p.instrument));
  const spec = useInstrumentSpec(p.instrument);
  const entry = useOrderEntry(accounts.find((a) => a.id === p.accountId) ?? null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const symbol = displaySymbol(p.instrument);
  return (
    <PositionCells
      p={p}
      dp={spec?.priceDecimals ?? 2}
      account={account}
      position={position}
      pnl={pnl}
      act={
        <>
          <Refused text={refused} />
          {entry.open ? (
            <Button
              size="s"
              variant="destructive"
              className={refused ? undefined : 'pz-hover'}
              disabled={busy}
              aria-label={`Flatten ${symbol} on ${account}`}
              onClick={() => {
                setBusy(true);
                setRefused(null);
                void flatten(p.accountId, p.instrument, symbol).then((r) => {
                  setBusy(false);
                  setRefused(firstFailure([r])?.text ?? null);
                });
              }}
            >
              Flatten
            </Button>
          ) : null}
        </>
      }
    />
  );
}

function OrderCells({ o, dp, account, act }: { o: Order; dp: number; account: string; act: ReactNode }) {
  const r = o.request;
  const price = restingPrice(r);
  const filled = o.filledQty > 0 ? ` · ${String(o.filledQty)} filled` : '';
  return (
    <Tr>
      <Td className="sym-cell">
        <b>{displaySymbol(r.instrument)}</b>
      </Td>
      <Td>
        <span className={r.side === 'buy' ? 'up' : 'down'}>{r.side === 'buy' ? 'Buy' : 'Sell'}</span> {String(r.qty)}
      </Td>
      <Td align="right" className={PRICE_TEXT}>
        {price === null ? 'market' : formatPrice(price, dp)}
      </Td>
      <Td className="t3">
        {r.orderType.replace('_', ' ')}
        {filled}
      </Td>
      <Td />
      <Td />
      <Td className="t3 col-account">{account}</Td>
      <Td align="right" className="col-act">
        <span className="pz-acts">{act}</span>
      </Td>
    </Tr>
  );
}

const OrderRow = memo(function OrderRow({ o, account }: { o: Order; account: string }) {
  const { accounts } = useShellData();
  const spec = useInstrumentSpec(o.request.instrument);
  const entry = useOrderEntry(accounts.find((a) => a.id === o.request.accountId) ?? null);
  const r = o.request;
  const symbol = displaySymbol(r.instrument);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <OrderCells
      o={o}
      dp={spec?.priceDecimals ?? 2}
      account={account}
      act={
        <>
          <Refused text={refused} />
          {entry.open ? (
            <Button
              size="s"
              variant="quiet"
              className={refused ? undefined : 'pz-hover'}
              disabled={busy}
              aria-label={`Cancel ${r.side} ${String(r.qty)} ${symbol}`}
              onClick={() => {
                setBusy(true);
                setRefused(null);
                void cancelOrders([o]).then((res) => {
                  setBusy(false);
                  setRefused(firstFailure([res])?.text ?? null);
                });
              }}
            >
              Cancel
            </Button>
          ) : null}
        </>
      }
    />
  );
});

function FillCells({ f, dp, time, account }: { f: Fill; dp: number; time: string; account: string }) {
  return (
    <Tr>
      <Td className="sym-cell">
        <b>{displaySymbol(f.instrument)}</b>
      </Td>
      <Td>
        <span className={f.side === 'buy' ? 'up' : 'down'}>{f.side === 'buy' ? 'Bought' : 'Sold'}</span> {String(f.qty)}
      </Td>
      <NumberCell value={f.price} precision={dp} />
      <Td className={cx('t3', PRICE_TEXT)}>{time}</Td>
      <Td />
      <NumberCell value={f.realizedPnl?.amount ?? null} kind="pnl" />
      <Td className="t3 col-account">{account}</Td>
      <Td />
    </Tr>
  );
}

function FillRow({ f, account }: { f: Fill; account: string }) {
  const spec = useInstrumentSpec(f.instrument);
  return (
    <FillCells
      f={f}
      dp={spec?.priceDecimals ?? 2}
      time={formatClock(normalizeEpochMs(f.ts), displayZone())}
      account={account}
    />
  );
}

const COLS = 8;
const OPEN_COLS = {
  cols: ['Side · Qty', 'Avg', 'Mark', 'Unrealized', 'Realized'],
  numeric: [false, true, true, true, true],
};
const WORKING_COLS = { cols: ['Side · Qty', 'Price', 'Type', '', ''], numeric: [false, true, false, false, false] };
const FILL_COLS = { cols: ['Side · Qty', 'Price', 'Time', '', 'Realized'], numeric: [false, true, false, false, true] };

const FillsToday = memo(function FillsToday({ fills, names }: { fills: readonly Fill[]; names: AccountNames }) {
  return (
    <TBody>
      <Cols label={`Fills today · ${String(fills.length)}`} {...FILL_COLS} />
      {fills.map((f) => (
        <FillRow key={f.id} f={f} account={nameOf(names, f.accountId)} />
      ))}
    </TBody>
  );
});

const Cols = memo(function Cols({
  label,
  cols,
  numeric,
}: {
  label: string;
  cols: readonly string[];
  numeric: readonly boolean[];
}) {
  return (
    <tr className="pz-cols">
      <Th className="pz-group">{label}</Th>
      {cols.map((c, i) => (
        <Th key={`${String(i)}-${c}`} align={numeric[i] ? 'right' : 'left'}>
          {c}
        </Th>
      ))}
      <Th className="col-account">Account</Th>
      <Th className="col-act" />
    </tr>
  );
});

function PositionsBody({ api }: IDockviewPanelProps) {
  useTradingKnown();
  const [settings] = useTileSettings<PositionsSettings>(api, { account: ALL });
  const { positions, orders, known } = useRows(settings.account);
  const fills = useFillsNewestFirst(settings.account);
  const names = useAccountNames();
  const feeds = useFeeds();
  const stream = streamStale(feeds);
  const empty = positions.length + orders.length + (fills?.length ?? 0) === 0;
  useTileEmpty(api.id, known && fills !== null ? empty : null);
  if (empty) {
    return (
      <div className="tile positions-tile is-flat" data-focus-zone="table">
        <p className="pz-flat">Flat</p>
      </div>
    );
  }
  return (
    <div className="tile positions-tile" data-focus-zone="table">
      <ScrollArea className="pz-scroll">
        <Table className="pz-table" aria-label="Positions, orders and fills">
          {positions.length > 0 ? (
            <TBody>
              <Cols
                label={[`Open · ${String(positions.length)}`, stream?.words].filter(Boolean).join(' · ')}
                {...OPEN_COLS}
              />
              {positions.map((p) => (
                <PositionRow
                  key={`${p.accountId}|${p.instrument}`}
                  p={p}
                  account={nameOf(names, p.accountId)}
                  feeds={feeds}
                />
              ))}
            </TBody>
          ) : (
            <TBody>
              <TGroup colSpan={COLS}>Flat</TGroup>
            </TBody>
          )}
          {orders.length > 0 ? (
            <TBody>
              <Cols label={`Working · ${String(orders.length)}`} {...WORKING_COLS} />
              {orders.map((o) => (
                <OrderRow key={o.id} o={o} account={nameOf(names, o.request.accountId)} />
              ))}
            </TBody>
          ) : null}
          {fills && fills.length > 0 ? <FillsToday fills={fills} names={names} /> : null}
        </Table>
      </ScrollArea>
    </div>
  );
}

const SAMPLE_ACCOUNT = 'Paper 50K Main';

const SAMPLE_FLATTEN = (
  <Button size="s" variant="destructive" className="pz-hover">
    Flatten
  </Button>
);

const SAMPLE_CANCEL = (
  <Button size="s" variant="quiet" className="pz-hover">
    Cancel
  </Button>
);

function PositionsSample() {
  return (
    <div className="tile positions-tile">
      <ScrollArea className="pz-scroll">
        <Table className="pz-table">
          <TBody>
            <Cols label={`Open · ${String(SAMPLE_POSITIONS.length)}`} {...OPEN_COLS} />
            {SAMPLE_POSITIONS.map((p) => (
              <PositionCells
                key={p.instrument}
                p={p}
                dp={2}
                account={SAMPLE_ACCOUNT}
                position={null}
                pnl={null}
                act={SAMPLE_FLATTEN}
              />
            ))}
          </TBody>
          <TBody>
            <Cols label={`Working · ${String(SAMPLE_ORDERS.length)}`} {...WORKING_COLS} />
            {SAMPLE_ORDERS.map((o) => (
              <OrderCells key={o.id} o={o} dp={2} account={SAMPLE_ACCOUNT} act={SAMPLE_CANCEL} />
            ))}
          </TBody>
          <TBody>
            <Cols label={`Fills today · ${String(SAMPLE_FILLS.length)}`} {...FILL_COLS} />
            {SAMPLE_FILLS.map((f) => (
              <FillCells key={f.id} f={f} dp={2} time="00:00:00" account={SAMPLE_ACCOUNT} />
            ))}
          </TBody>
        </Table>
      </ScrollArea>
    </div>
  );
}

export function PositionsTile(props: IDockviewPanelProps) {
  return (
    <Loaded label="Loading positions" sample={<PositionsSample />}>
      <PositionsBody {...props} />
    </Loaded>
  );
}

function PositionsTab({ api }: IDockviewPanelHeaderProps) {
  useTileSettingsVersion();
  const account = tileParams<PositionsSettings>(api).account ?? ALL;
  const n = (useHoldings() ?? []).filter((p) => account === ALL || p.accountId === account).length;
  return (
    <span className="dock-tab-title">
      Positions
      {n > 0 ? <span className={cx('pz-count', PRICE_TEXT)}> {String(n)}</span> : null}
    </span>
  );
}

function PositionsScope({ panel }: TileScopeProps) {
  useTileSettingsVersion();
  const { accounts } = useShellData();
  if (accounts.length < 2) return null;
  const want = tileParams<PositionsSettings>(panel.api).account ?? ALL;
  const account = accounts.find((a) => a.id === want) ?? null;
  const pick = (v: string) => setTileParams<PositionsSettings>(panel.api, { account: v });
  return (
    <ScopeChip
      model={{
        label: account?.displayName ?? 'All accounts',
        tip: account ? `Positions of ${account.displayName}` : 'Positions of every account',
        link: null,
        choices: [
          { id: ALL, label: 'All accounts', current: !account, run: () => pick(ALL) },
          ...accounts.map((a) => ({
            id: a.id,
            label: a.displayName,
            current: a.id === account?.id,
            run: () => pick(a.id),
          })),
        ],
      }}
    />
  );
}

registerTile({
  kind: 'positions',
  private: true,
  title: 'Positions',
  component: PositionsTile,
  home: 'bottom',
  singleton: true,
  icon: 'positions',
  order: 0,
  tab: PositionsTab,
  scope: PositionsScope,
});
