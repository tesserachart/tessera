import type { AccountUpdate, ConnectionInfo } from '@tessera/protocol';
import {
  Button,
  Icon,
  Loaded,
  Menu,
  MenuContent,
  MenuTrigger,
  ScrollArea,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tooltip,
  Tr,
  cx,
  formatMoney,
  toneOf,
  PRICE_TEXT,
} from '@tessera/ui';
import type { IDockviewPanelProps } from 'dockview-react';
import { useState, type ReactNode } from 'react';
import { useAccountsUi, selectAccount } from '../../accounts/accountsUi.ts';
import { orThrow, switchEdits, useConnectionCall } from '../../accounts/connectionCall.ts';
import { useDraft } from '../../app/overlay.ts';
import { useAccountUpdates, useHoldings, type Holding } from '../../app/portfolio.ts';
import { copyWord, useCopyGroups, type CopyWord } from '../../accounts/copy.ts';
import { openCopyGroup } from '../../areas/copy/store.ts';
import { connectionOf, type ConnectionRow } from '../../accounts/connections.ts';
import {
  ENV_WORDS,
  contractLimitWords,
  dailyLeftLow,
  dailyLossLeft,
  lockedWords,
  trailLow,
  workingWords,
} from '../../accounts/figures.ts';
import { limitLockWords, standingWords } from '../../accounts/limits.ts';
import { lockChipWords } from '../../accounts/lock.ts';
import { LockOptions, UnlockDialog } from '../../accounts/LockMenu.tsx';
import { useConnections } from '../../accounts/useConnections.ts';
import { addConnection, openConnections } from '../../accounts/navigate.ts';
import { pickTicketAccount } from '../../chart/ticket/useTicketTrade.ts';
import { displaySymbol } from '../../market/instruments.ts';
import { ACCOUNT_KEY } from '../../shell/keys.ts';
import { orderEntrySwitchOf, useOrderEntry, type OrderEntrySwitch } from '../../shell/orderEntry.ts';
import { useShellData } from '../../shell/shellData.ts';
import { positionWord } from '../../shell/ticket.ts';
import { firstFailure, flatten } from '../../shell/tradeActions.ts';
import { useWorkspace } from '../../state/workspace.ts';
import { useConnectionsKnown, useTradingKnown } from './known.ts';
import { Refused } from './parts.tsx';
import { registerTile } from './registry.ts';
import { SAMPLE_ACCOUNTS, SAMPLE_RESTING } from './samples.ts';

function openWords(positions: readonly Holding[]): string {
  if (positions.length === 0) return '';
  const [p, ...rest] = positions;
  return `${positionWord(p!.qty)} ${displaySymbol(p!.instrument)}${rest.length ? ` +${String(rest.length)}` : ''}`;
}

function useOnActiveChart(): ((accountId: string) => void) | null {
  const tile = useWorkspace((s) => s.activeChart?.tileId ?? null);
  const { accounts } = useShellData();
  return tile ? (id) => pickTicketAccount(tile, id, accounts) : null;
}

interface RuleColumns {
  daily: boolean;
  trail: boolean;
}

function AccountRowView({
  u,
  rules,
  connection,
  copying,
  resting,
  flatten,
  act,
  selected = false,
  onPick,
}: {
  u: AccountUpdate;
  rules: RuleColumns;
  connection: ConnectionRow | null;
  copying: ReactNode;
  resting: ReactNode;
  flatten: ReactNode;
  act: ReactNode;
  selected?: boolean;
  onPick?: () => void;
}) {
  const r = u.risk;
  const locked = limitLockWords(u) ?? lockedWords(r);
  const daily = dailyLossLeft(u);
  return (
    <Tr
      selected={selected}
      className="ac-row"
      tabIndex={0}
      aria-selected={selected}
      onClick={onPick}
      onKeyDown={(e) => {
        if (onPick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <Td className="c-name ac-name">
        <span className="nm">{u.account.displayName}</span>
        {locked ? <span className="lk">{lockChipWords(u) ?? locked.replace(/ until [^·]+/, '')}</span> : null}
        {copying}
      </Td>
      <Td align="right" className={cx('c-bal', PRICE_TEXT)}>
        {formatMoney(u.summary.balance)}
      </Td>
      <Td align="right" className={cx('c-day', PRICE_TEXT)} data-tone={toneOf(u.summary.dayPnl.amount)}>
        {formatMoney(u.summary.dayPnl, { signed: true })}
      </Td>
      {rules.daily ? (
        <Td align="right" className={cx('c-dll', PRICE_TEXT)} data-low={daily?.low === true ? true : undefined}>
          {daily ? formatMoney(daily.left) : ''}
        </Td>
      ) : null}
      {rules.trail ? (
        <Td align="right" className={cx('c-trl', PRICE_TEXT)} data-low={trailLow(r) || undefined}>
          {r?.trailingRoom ? formatMoney(r.trailingRoom) : ''}
        </Td>
      ) : null}
      <Td className="c-open ac-open">
        <span className="w">{resting}</span>
        {flatten}
      </Td>
      <Td className="c-conn ac-conn">
        <span className="text-t3">{connection?.name ?? u.account.connectionId}</span>
        {connection && connection.status !== 'ok' ? <span className="st"> · {connection.health}</span> : null}
      </Td>
      <Td align="right" className="c-act ac-act">
        {act}
      </Td>
    </Tr>
  );
}

function AccountRow({
  u,
  positions,
  working,
  connection,
  selected,
  current,
  rules,
}: {
  u: AccountUpdate;
  positions: Holding[];
  working: number;
  connection: ConnectionRow | null;
  selected: boolean;
  current: boolean;
  rules: RuleColumns;
}) {
  const entry = useOrderEntry(u.account);
  const assign = useOnActiveChart();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const copying = useCopyWord(u.account.id);
  const open = openWords(positions);
  const resting = [open, workingWords(working)].filter(Boolean).join(' · ');
  return (
    <AccountRowView
      u={u}
      rules={rules}
      connection={connection}
      selected={selected}
      onPick={() => selectAccount(selected ? null : u.account.id)}
      copying={
        copying ? (
          <button
            type="button"
            className="cp"
            onClick={(e) => {
              e.stopPropagation();
              openCopyGroup(copying.groupId);
            }}
          >
            {copying.text}
          </button>
        ) : null
      }
      resting={refused ? <Refused text={refused} /> : resting}
      flatten={
        open && entry.open ? (
          <Button
            size="s"
            variant="destructive"
            className={refused ? undefined : 'ac-hover'}
            disabled={busy}
            aria-label={`Flatten ${open} on ${u.account.displayName}`}
            onClick={(e) => {
              e.stopPropagation();
              setBusy(true);
              setRefused(null);
              void Promise.all(
                positions.map((p) => flatten(u.account.id, p.instrument, displaySymbol(p.instrument))),
              ).then((results) => {
                setBusy(false);
                setRefused(firstFailure(results)?.text ?? null);
              });
            }}
          >
            Flatten
          </Button>
        ) : null
      }
      act={
        assign && !current ? (
          <Button
            size="s"
            variant="quiet"
            className="ac-hover"
            onClick={(e) => {
              e.stopPropagation();
              assign(u.account.id);
            }}
          >
            Use on this chart
          </Button>
        ) : current ? (
          <span className="ac-here">On this chart</span>
        ) : null
      }
    />
  );
}

function useCopyWord(account: string): CopyWord | null {
  const groups = useCopyGroups();
  const { accounts } = useShellData();
  return copyWord(groups, account, (id) => accounts.find((a) => a.id === id)?.displayName ?? id);
}

function Fact({ label, children, tone }: { label: string; children: ReactNode; tone?: 'low' | 'up' | 'down' }) {
  return (
    <div className="ac-fact">
      <dt>{label}</dt>
      <dd className={PRICE_TEXT} data-tone={tone}>
        {children}
      </dd>
    </div>
  );
}

function OrderEntryRow({ u, sw }: { u: AccountUpdate; sw: OrderEntrySwitch }) {
  const { since, run } = useConnectionCall();
  const [failed, setFailed] = useState<string | null>(null);
  const on = useDraft(switchEdits, `entry/${sw.connectionId}/${u.account.id}`, sw.on);
  return (
    <div className="ac-entry">
      <Switch
        checked={on.value}
        disabled={since !== null}
        onCheckedChange={(next) => {
          setFailed(null);
          on.save(next, (enabled) =>
            run('connections.set_order_entry', { connectionId: sw.connectionId, accountId: u.account.id, enabled })
              .then((r) => {
                setFailed(r.ok ? null : r.why);
                return r;
              })
              .then(orThrow),
          );
        }}
      >
        Order entry
      </Switch>
      {failed ? <Refused text={failed} /> : null}
    </div>
  );
}

function AccountDetail({
  u,
  connection,
  current,
  infos,
}: {
  u: AccountUpdate;
  connection: ConnectionRow | null;
  current: boolean;
  infos: readonly ConnectionInfo[];
}) {
  const assign = useOnActiveChart();
  const entry = useOrderEntry(u.account);
  const sw = orderEntrySwitchOf(u.account, infos);
  const r = u.risk;
  const s = u.summary;
  const [unlocking, setUnlocking] = useState(false);
  return (
    <aside className="ac-detail" aria-label={`${u.account.displayName} details`}>
      <header className="ac-detail-head">
        <b>{u.account.displayName}</b>
        <Menu>
          <MenuTrigger asChild>
            <Button size="s" variant="quiet" className="ac-lock">
              {lockChipWords(u) ?? 'Lock trading'}
            </Button>
          </MenuTrigger>
          <MenuContent className="lk-pop" align="end" aria-label="Lock trading">
            <LockOptions update={u} instrument={null} onUnlock={() => setUnlocking(true)} />
          </MenuContent>
        </Menu>
        <UnlockDialog update={u} open={unlocking} onOpenChange={setUnlocking} />
        {assign && !current ? (
          <Button size="s" variant="quiet" className="ac-use" onClick={() => assign(u.account.id)}>
            Use on this chart
          </Button>
        ) : null}
        <Tooltip content="Close">
          <button type="button" className="dock-act" aria-label="Close" onClick={() => selectAccount(null)}>
            <Icon name="close" />
          </button>
        </Tooltip>
      </header>
      <ScrollArea className="ac-detail-body">
        <p className="ac-env">{ENV_WORDS[u.account.environment]}</p>
        {sw ? <OrderEntryRow u={u} sw={sw} /> : !entry.open ? <p className="ac-why">{entry.why}</p> : null}
        <dl className="ac-facts">
          <Fact label="Net liq">{formatMoney(s.netLiq)}</Fact>
          <Fact label="Balance">{formatMoney(s.balance)}</Fact>
          <Fact label="Buying power">{formatMoney(s.buyingPower)}</Fact>
          <Fact
            label="Realized today"
            tone={
              toneOf(s.realizedToday.amount) === 'flat' ? undefined : (toneOf(s.realizedToday.amount) as 'up' | 'down')
            }
          >
            {formatMoney(s.realizedToday, { signed: true })}
          </Fact>
          {s.feesToday.amount !== 0 ? <Fact label="Fees today">{formatMoney(s.feesToday)}</Fact> : null}
          {u.limits ? (
            <Fact label="Your limits" tone={u.limits.locked ? 'low' : undefined}>
              {standingWords(u.limits)}
            </Fact>
          ) : null}
          {r?.dailyLossLimit ? (
            <Fact label="Firm’s daily loss left" tone={dailyLeftLow(r) ? 'low' : undefined}>
              {formatMoney(r.dailyLossRemaining)} of {formatMoney(r.dailyLossLimit)}
            </Fact>
          ) : null}
          {r?.trailingThreshold ? (
            <>
              <Fact label="Firm’s drawdown left" tone={trailLow(r) ? 'low' : undefined}>
                {formatMoney(r.trailingRoom)}
              </Fact>
              <Fact label="Firm’s drawdown floor">{formatMoney(r.trailingThreshold)}</Fact>
            </>
          ) : null}
          {r?.highWaterMark ? <Fact label="High-water mark">{formatMoney(r.highWaterMark)}</Fact> : null}
          {lockedWords(r) ? <Fact label="Firm’s platform">{lockedWords(r)}</Fact> : null}
          {contractLimitWords(r) ? <Fact label="Firm’s contract limits">{contractLimitWords(r)}</Fact> : null}
          {u.account.externalRefMasked ? <Fact label="Account">{u.account.externalRefMasked}</Fact> : null}
          <Fact label="Connection">{connection?.name ?? u.account.connectionId}</Fact>
        </dl>
      </ScrollArea>
    </aside>
  );
}

function AccountsHead({ rules }: { rules: RuleColumns }) {
  return (
    <THead>
      <tr>
        <Th className="c-name">Account</Th>
        <Th align="right" className="c-bal">
          Balance
        </Th>
        <Th align="right" className="c-day">
          Day P&L
        </Th>
        {rules.daily ? (
          <Th align="right" className="c-dll">
            Daily loss left
          </Th>
        ) : null}
        {rules.trail ? (
          <Th align="right" className="c-trl">
            Trailing room
          </Th>
        ) : null}
        <Th className="c-open">Open</Th>
        <Th className="c-conn">Connection</Th>
        <Th className="c-act" />
      </tr>
    </THead>
  );
}

const SAMPLE_RULES: RuleColumns = { daily: false, trail: false };

const SAMPLE_USE = (
  <Button size="s" variant="quiet" className="ac-hover">
    Use on this chart
  </Button>
);

function AccountsSample() {
  return (
    <div className="ac">
      <ScrollArea className="ac-table">
        <Table className="ac-tbl">
          <AccountsHead rules={SAMPLE_RULES} />
          <TBody>
            {SAMPLE_ACCOUNTS.map((u, i) => (
              <AccountRowView
                key={u.account.id}
                u={u}
                rules={SAMPLE_RULES}
                connection={null}
                copying={null}
                resting={i === 0 ? SAMPLE_RESTING : ''}
                flatten={null}
                act={i === 0 ? <span className="ac-here">On this chart</span> : SAMPLE_USE}
              />
            ))}
          </TBody>
        </Table>
      </ScrollArea>
    </div>
  );
}

function AccountsList({ rows, infos }: { rows: ConnectionRow[]; infos: readonly ConnectionInfo[] }) {
  useTradingKnown();
  useConnectionsKnown();
  const { accountId, allOrders } = useShellData();
  const accountUpdates = useAccountUpdates() ?? [];
  const holdings = useHoldings() ?? [];
  const selected = useAccountsUi((s) => s.selected);
  const shown = accountUpdates.find((u) => u.account.id === selected) ?? null;
  const rules: RuleColumns = {
    daily: accountUpdates.some((u) => dailyLossLeft(u) !== null),
    trail: accountUpdates.some((u) => u.risk?.trailingRoom),
  };
  if (accountUpdates.length === 0) {
    return (
      <div className="ac-empty">
        <Button size="s" onClick={() => addConnection()}>
          Connect an account
        </Button>
      </div>
    );
  }
  return (
    <div className={cx('ac', shown && 'has-detail')}>
      <ScrollArea className="ac-table">
        <Table className="ac-tbl" aria-label="Accounts">
          <AccountsHead rules={rules} />
          <TBody>
            {accountUpdates.map((u) => (
              <AccountRow
                key={u.account.id}
                u={u}
                positions={holdings.filter((p) => p.accountId === u.account.id)}
                working={allOrders.filter((o) => o.request.accountId === u.account.id).length}
                connection={connectionOf(rows, u.account.connectionId)}
                selected={u.account.id === selected}
                current={u.account.id === accountId}
                rules={rules}
              />
            ))}
          </TBody>
        </Table>
      </ScrollArea>
      {shown ? (
        <AccountDetail
          u={shown}
          connection={connectionOf(rows, shown.account.connectionId)}
          current={shown.account.id === accountId}
          infos={infos}
        />
      ) : null}
    </div>
  );
}

function AccountsBody() {
  const { rows, infos } = useConnections();
  return <AccountsList rows={rows} infos={infos} />;
}

export function AccountsTile(_props: IDockviewPanelProps) {
  return (
    <div className="tile accounts-tile" data-focus-zone="accounts" data-view="accounts">
      <Loaded label="Loading accounts" sample={<AccountsSample />}>
        <AccountsBody />
      </Loaded>
    </div>
  );
}

registerTile({
  kind: 'accounts',
  private: true,
  title: 'Accounts',
  component: AccountsTile,
  home: 'bottom',
  singleton: true,
  icon: 'accounts',
  shortcut: ACCOUNT_KEY,
  order: 1,
  keywords: ['environment', 'paper', 'live', 'eval', 'funded', 'net liq', 'balance', 'daily loss', 'drawdown'],
  menu: () => [{ type: 'item', id: 'connections', label: 'Connections…', run: () => openConnections() }],
});
