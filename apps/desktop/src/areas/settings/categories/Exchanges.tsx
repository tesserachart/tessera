import type { TradingAccount } from '@tessera/protocol';
import { SettingsRow, type SelectOption } from '@tessera/ui';
import { useState } from 'react';
import { useConnections } from '../../../accounts/useConnections.ts';
import { dataConnections, shownDataSource, useDataFrom } from '../../../market/dataFrom.ts';
import { useListing } from '../../../markets/listing.ts';
import {
  ACCOUNT_BY_EXCHANGE,
  DATA_BY_EXCHANGE,
  accountsFor,
  exchangeRows,
  feederOf,
  marketsWords,
  withRoute,
  type ExchangeRow,
} from '../../../markets/routes.ts';
import { followRoute, useExchangeRoutes } from '../../../markets/useRoutes.ts';
import { useShellData } from '../../../shell/shellData.ts';
import { useRuntimeSetting, useSetSetting } from '../../../state/runtimeSettings.ts';
import { ticketAccountId } from '../../../state/tickets.ts';
import { useUi, setTradeAccount } from '../../../state/ui.ts';
import { Section, SettingSelect } from '../parts.tsx';

const DEFAULT = '\u0000default';

type RouteKey = typeof DATA_BY_EXCHANGE | typeof ACCOUNT_BY_EXCHANGE;

export function ExchangesSections() {
  const { infos, dataSource } = useConnections();
  const { listings, loading } = useListing();
  const routes = useExchangeRoutes();
  const { accounts } = useShellData();
  const tradeAccount = useUi((s) => s.tradeAccount);
  const storedDefault = useRuntimeSetting('market.dataSource');
  const dataFrom = useDataFrom();
  const set = useSetSetting();
  const [failed, setFailed] = useState<{ key: RouteKey; why: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = exchangeRows(listings, routes.data, routes.accounts);
  const sources = dataConnections(infos);
  const nameOf = (id: string | null) => {
    const c = id ? infos.find((i) => i.id === id) : undefined;
    return c ? c.displayName : (id ?? '');
  };
  const shownDefault = shownDataSource(typeof storedDefault === 'string' ? storedDefault : null, infos, dataSource);
  const defaultAccount = ticketAccountId(accounts, null, null, tradeAccount);
  const defaultAccountName = accounts.find((a) => a.id === defaultAccount)?.displayName ?? null;
  const accountOptions = (list: readonly TradingAccount[]): SelectOption[] =>
    list.map((a) => ({ value: a.id, label: a.displayName, group: nameOf(a.connectionId) }));

  const route = (key: RouteKey, exchange: string, v: string) => {
    const now = key === DATA_BY_EXCHANGE ? routes.data : routes.accounts;
    const next = withRoute(now, exchange, v === DEFAULT ? null : v);
    setFailed(null);
    setBusy(`${key}:${exchange}`);
    void set(key, next).then((why) => {
      setBusy(null);
      setFailed(why ? { key, why } : null);
      if (!why && key === ACCOUNT_BY_EXCHANGE) followRoute(exchange, next);
    });
  };
  if (rows.length === 0 && !loading) return null;

  return (
    <>
      <Section id="connections.exchanges">
        <SettingsRow
          data-setting="connections.exchanges.default"
          label="Every exchange"
          help="Unless one below has its own"
          error={dataFrom.failed ?? (failed?.key === DATA_BY_EXCHANGE ? failed.why : null)}
        >
          {sources.length > 0 ? (
            <SettingSelect
              label="Market data from"
              value={shownDefault ?? undefined}
              disabled={dataFrom.busy}
              onValueChange={(id) => id !== shownDefault && dataFrom.run(id)}
              options={sources.map((c) => ({ value: c.id, label: c.displayName }))}
            />
          ) : null}
        </SettingsRow>
        {rows.map((r) => (
          <SettingsRow
            key={r.exchange}
            data-setting={`connections.exchanges.${r.exchange}`}
            label={r.exchange}
            help={
              r.data !== null && !sources.some((c) => c.id === r.data)
                ? `${nameOf(r.data)} is not connected, so ${nameOf(feederOf(r.exchange, routes.data, infos, dataSource, listings))} feeds it meanwhile`
                : marketsWords(r.markets)
            }
          >
            <SettingSelect
              label={`${r.exchange} market data from`}
              value={r.data ?? DEFAULT}
              disabled={busy === `${DATA_BY_EXCHANGE}:${r.exchange}`}
              onValueChange={(v) => route(DATA_BY_EXCHANGE, r.exchange, v)}
              options={[
                defaultOption(nameOf(feederOf(r.exchange, {}, infos, dataSource, listings))),
                ...dataOptions(r, sources, nameOf),
              ]}
            />
          </SettingsRow>
        ))}
      </Section>
      {accounts.length > 0 ? (
        <Section id="connections.orders">
          <SettingsRow
            data-setting="connections.orders.default"
            label="Every exchange"
            help="Unless one below has its own, or a chart picked its own"
            error={failed?.key === ACCOUNT_BY_EXCHANGE ? failed.why : null}
          >
            <SettingSelect
              label="Orders go from"
              value={defaultAccount ?? undefined}
              onValueChange={(id) => {
                setTradeAccount(id);
                followRoute(null, routes.accounts);
              }}
              options={accountOptions(accounts)}
            />
          </SettingsRow>
          {rows.map((r) => {
            const options = accountOptions(accountsFor(accounts, r, listings));
            const missing = r.account !== null && !accounts.some((a) => a.id === r.account);
            return (
              <SettingsRow
                key={r.exchange}
                data-setting={`connections.orders.${r.exchange}`}
                label={r.exchange}
                help={
                  missing
                    ? 'Its account is not listed now, so the default trades it meanwhile'
                    : marketsWords(r.markets)
                }
              >
                <SettingSelect
                  label={`${r.exchange} orders go from`}
                  value={r.account ?? DEFAULT}
                  disabled={busy === `${ACCOUNT_BY_EXCHANGE}:${r.exchange}` || options.length === 0}
                  onValueChange={(v) => route(ACCOUNT_BY_EXCHANGE, r.exchange, v)}
                  options={[
                    defaultOption(defaultAccountName),
                    ...options,
                    ...(missing && r.account ? [{ value: r.account, label: r.account }] : []),
                  ]}
                />
              </SettingsRow>
            );
          })}
        </Section>
      ) : null}
    </>
  );
}

function defaultOption(name: string | null): SelectOption {
  return { value: DEFAULT, label: name ? `Default · ${name}` : 'Default' };
}

function dataOptions(
  r: ExchangeRow,
  sources: ReturnType<typeof dataConnections>,
  nameOf: (id: string | null) => string,
): SelectOption[] {
  const ids = sources.filter((c) => r.connections.includes(c.id)).map((c) => c.id);
  if (r.data !== null && !ids.includes(r.data)) ids.push(r.data);
  return ids.map((id) => ({ value: id, label: nameOf(id) }));
}
