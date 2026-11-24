import type { AccountUpdate } from '@tessera/protocol';
import {
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  PrivateScope,
  Tooltip,
  formatMoney,
  toneOf,
  PRICE_TEXT,
  cx,
} from '@tessera/ui';
import { useState } from 'react';
import { track } from '../app/telemetry.ts';
import { ACCOUNT_KEY } from '../shell/keys.ts';
import { revealTile } from '../workspace/dock/open.ts';
import { todayWords } from './figures.ts';
import { lockChipWords } from './lock.ts';
import { LockTradingMenu, UnlockDialog } from './LockMenu.tsx';

export function AccountSwitcher({
  updates,
  current,
  onPick,
  disabled,
  compact = false,
  instrument = null,
}: {
  updates: readonly AccountUpdate[];
  current: AccountUpdate;
  onPick: (accountId: string) => void;
  disabled?: boolean;
  compact?: boolean;
  instrument?: string | null;
}) {
  const name = current.account.displayName;
  const locked = lockChipWords(current);
  const [unlocking, setUnlocking] = useState(false);
  const pick = (id: string) => {
    if (id !== current.account.id) track({ event: 'account switched', accounts: updates.length });
    onPick(id);
  };
  return (
    <PrivateScope>
      <Menu>
        <Tooltip
          content={current.limits?.lockedWhy ?? (compact ? `${name} · ${formatMoney(current.summary.netLiq)}` : name)}
        >
          <MenuTrigger asChild>
            <button
              type="button"
              className="tk-acct"
              data-private=""
              disabled={disabled}
              aria-label={`Account: ${name}, ${locked ?? formatMoney(current.summary.netLiq)}`}
            >
              <span className="nm">{name}</span>
              {locked ? (
                <span className="lk">
                  <Icon name="lock" className="lk-i" />
                  {locked}
                </span>
              ) : compact ? null : (
                <span className={cx('nl', PRICE_TEXT)}>{formatMoney(current.summary.netLiq)}</span>
              )}
              <Icon name="chevron-down" className="chev" />
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent className="tk-acct-pop" align="end" aria-label="Accounts">
          {updates.map((u) => {
            const on = u.account.id === current.account.id;
            return (
              <MenuItem
                key={u.account.id}
                current={on}
                className="tk-acct-row"
                textValue={u.account.displayName}
                aria-current={on ? 'true' : undefined}
                onSelect={() => pick(u.account.id)}
              >
                <span className="nm">{u.account.displayName}</span>
                <span className={cx('nl', PRICE_TEXT)}>{formatMoney(u.summary.netLiq)}</span>
                <span className={cx('day', PRICE_TEXT)} data-tone={toneOf(u.summary.dayPnl.amount)}>
                  {todayWords(u.summary.dayPnl)}
                </span>
              </MenuItem>
            );
          })}
          <MenuSeparator />
          <LockTradingMenu update={current} instrument={instrument} onUnlock={() => setUnlocking(true)} />
          <MenuItem
            className="tk-acct-foot"
            shortcut={ACCOUNT_KEY}
            onSelect={() => void revealTile('accounts', { via: 'pointer', focus: true })}
          >
            Accounts & connections
          </MenuItem>
        </MenuContent>
      </Menu>
      <UnlockDialog update={current} open={unlocking} onOpenChange={setUnlocking} />
    </PrivateScope>
  );
}
