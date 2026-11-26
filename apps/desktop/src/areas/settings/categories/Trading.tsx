import type { ConnectionInfo, TradingAccount } from '@tessera/protocol';
import { ConfirmButton, SettingsRow, Switch } from '@tessera/ui';
import { Fragment, useState } from 'react';
import { POSITION_BRACKET } from '../../../chart/brackets.ts';
import { orThrow, switchEdits, useConnectionCall } from '../../../accounts/connectionCall.ts';
import { useDraft } from '../../../app/overlay.ts';
import { connectionOf, type ConnectionRow } from '../../../accounts/connections.ts';
import { useConnections } from '../../../accounts/useConnections.ts';
import { orderEntryOf, orderEntrySwitchOf } from '../../../shell/orderEntry.ts';
import { useShellData } from '../../../shell/shellData.ts';
import { useSetting, useSettingInfos, useSettingSave } from '../../../state/runtimeSettings.ts';
import { defineSetting } from '../../../state/setting.ts';
import { useTradeSettings, tradeSettingsStore } from '../../../state/tradeSettings.ts';
import { NumberSetting } from '../NumberSetting.tsx';
import { OrderHotkeys } from './OrderHotkeys.tsx';
import { RiskSections } from './Risk.tsx';
import { useShellKnown } from '../hooks.ts';
import { Row, Section, SettingSelect } from '../parts.tsx';
import { BRACKET_MODES, bracketWords } from '../words.ts';
import { read, patch } from '../../../app/store.ts';

function OrderEntry({
  account,
  infos,
  rows,
}: {
  account: TradingAccount;
  infos: readonly ConnectionInfo[];
  rows: readonly ConnectionRow[];
}) {
  const { since, run } = useConnectionCall();
  const [failed, setFailed] = useState<string | null>(null);
  const sw = orderEntrySwitchOf(account, infos);
  const on = useDraft(switchEdits, sw ? `entry/${sw.connectionId}/${account.id}` : null, sw?.on ?? false);
  const entry = orderEntryOf(account, infos);
  const conn = connectionOf(rows, account.connectionId)?.name ?? account.connectionId;
  return (
    <SettingsRow
      data-setting={`trading.account.${account.id}`}
      label={account.displayName}
      help={sw ? conn : entry.open ? conn : entry.why}
      error={failed}
    >
      {sw ? (
        <Switch
          label={`Order entry for ${account.displayName}`}
          checked={on.value}
          disabled={since !== null}
          onCheckedChange={(next) => {
            setFailed(null);
            on.save(next, (enabled) =>
              run('connections.set_order_entry', { connectionId: sw.connectionId, accountId: account.id, enabled })
                .then((r) => {
                  setFailed(r.ok ? null : r.why);
                  return r;
                })
                .then(orThrow),
            );
          }}
        />
      ) : (
        <span className="st-fact">{entry.open ? 'Takes orders' : 'Read only'}</span>
      )}
    </SettingsRow>
  );
}

type AccountType = 'eval' | 'funded' | 'live' | 'sim';

const TYPE_WORDS: Record<AccountType, string> = {
  eval: 'Evaluation',
  funded: 'Funded',
  live: 'Live',
  sim: 'Paper',
};

const DETECTED = 'detected';

function readTypes(stored: unknown): Record<string, AccountType> {
  if (typeof stored !== 'object' || stored === null) return {};
  return Object.fromEntries(
    Object.entries(stored).filter((e): e is [string, AccountType] => typeof e[1] === 'string' && e[1] in TYPE_WORDS),
  );
}

const ACCOUNT_TYPES = defineSetting('accounts.types', readTypes);

function AccountTypeRow({ account }: { account: TradingAccount }) {
  const types = useSetting(ACCOUNT_TYPES);
  const { save: keep, error: failed } = useSettingSave(ACCOUNT_TYPES);
  const own = types[account.id];
  const shown = account.environment === 'paper' ? null : account.environment;
  if (shown === null) return null;
  const save = (v: string) => {
    if (v === (own ?? shown)) return;
    const { [account.id]: _was, ...rest } = types;
    void keep(v === DETECTED ? rest : { ...rest, [account.id]: v });
  };
  return (
    <SettingsRow
      className="st-own"
      data-setting={`trading.accountType.${account.id}`}
      label="Type"
      help={own ? 'Set by you' : 'Read from its name at the firm or broker'}
      error={failed}
    >
      <SettingSelect
        label={`Type of ${account.displayName}`}
        value={own ?? shown}
        onValueChange={save}
        options={[
          ...(own ? [{ value: DETECTED, label: 'As its name says' }] : []),
          ...(Object.keys(TYPE_WORDS) as AccountType[]).map((t) => ({ value: t, label: TYPE_WORDS[t] })),
        ]}
      />
    </SettingsRow>
  );
}

const DRAFT_KEYS = { seconds: 'approvals.staleAfterSeconds', ticks: 'approvals.staleAfterTicks' } as const;

function BracketMode() {
  const value = useSetting(POSITION_BRACKET);
  const { save, error: failed } = useSettingSave(POSITION_BRACKET);
  const shown = BRACKET_MODES.find((m) => m.value === value)!;
  return (
    <Row id="trading.bracketMode" help={shown.help} error={failed}>
      <SettingSelect
        label="A position’s stop and target"
        value={value}
        onValueChange={(v) => {
          if (v === value) return;
          void save(v);
        }}
        options={BRACKET_MODES.map((m) => ({ value: m.value, label: m.label }))}
      />
    </Row>
  );
}

export function Trading() {
  useShellKnown();
  const { accounts } = useShellData();
  const { rows, infos } = useConnections();
  const settings = useSettingInfos();
  const lastOco = useTradeSettings((s) => s.lastOco);
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? id;
  const brackets = Object.entries(lastOco);
  const standard = settings?.['paper.commissionStandard'];
  const micro = settings?.['paper.commissionMicro'];
  const staleSeconds = settings?.[DRAFT_KEYS.seconds];
  const staleTicks = settings?.[DRAFT_KEYS.ticks];
  return (
    <>
      <Section id="trading.accounts">
        {accounts.map((a) => (
          <Fragment key={a.id}>
            <OrderEntry account={a} infos={infos} rows={rows} />
            <AccountTypeRow account={a} />
          </Fragment>
        ))}
      </Section>
      <RiskSections />
      <Section id="trading.positionBracket">
        <BracketMode />
      </Section>
      <OrderHotkeys />
      <Section id="trading.drafts">
        <Row id="trading.staleSeconds">
          {staleSeconds ? <NumberSetting info={staleSeconds} unit="s" label="A draft goes stale after" /> : null}
        </Row>
        <Row id="trading.staleTicks">
          {staleTicks ? <NumberSetting info={staleTicks} unit="trades" label="Or after this many trades" /> : null}
        </Row>
      </Section>
      {brackets.length > 0 ? (
        <Section id="trading.brackets">
          {brackets.map(([key, oco]) => {
            const [account = '', root = ''] = key.split('|');
            return (
              <SettingsRow
                key={key}
                data-setting={`trading.bracket.${key}`}
                label={`${root} · ${nameOf(account)}`}
                help={bracketWords(oco)}
              >
                <ConfirmButton
                  what={`${root} · ${nameOf(account)}`}
                  question="Its ticket starts from the default bracket."
                  onConfirm={() => {
                    const { [key]: _gone, ...rest } = read(tradeSettingsStore).lastOco;
                    patch(tradeSettingsStore, { lastOco: rest });
                  }}
                >
                  Forget
                </ConfirmButton>
              </SettingsRow>
            );
          })}
        </Section>
      ) : null}
      <Section id="trading.paper">
        <Row id="trading.commission">
          {standard ? (
            <NumberSetting info={standard} unit="USD" label="Commission per standard contract, per side" />
          ) : null}
        </Row>
        <Row id="trading.commissionMicro">
          {micro ? <NumberSetting info={micro} unit="USD" label="Commission per micro contract, per side" /> : null}
        </Row>
      </Section>
    </>
  );
}
