import type { AccountUpdate } from '@tessera/protocol';
import '../styles/app.css';
import { LevelsBands } from '../areas/settings/categories/Levels.tsx';
import { DEFAULT_LEVEL_SETTINGS, defsOf, setLevelStyle, sourceDefs } from '../chart/levelSettings.ts';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../shell/shellData.ts';
import { tradeSettingsStore } from '../state/tradeSettings.ts';
import { patch } from '../app/store.ts';

const money = (amount: number) => ({ amount, currency: 'USD' as const });
const account = (id: string, displayName: string, environment: 'paper' | 'eval', nl: number): AccountUpdate =>
  ({
    account: { id, displayName, environment },
    summary: { accountId: id, netLiq: money(nl), balance: money(nl), dayPnl: money(0) },
    risk: null,
  }) as unknown as AccountUpdate;

const ACCOUNTS = [account('paper-main', 'Paper', 'paper', 124_820), account('eval-50k', 'Eval 50K', 'eval', 51_240)];

const declared = (field: string, label: string, short: string, color: 'up' | 'down' | 'mist' | 'teal' | 'brass') => ({
  key: `acme.${field.startsWith('major_long') || field.startsWith('major_short') ? 'state' : 'classic'}.${field}`,
  field,
  label,
  short,
  group: 'gamma',
  endpoint: null,
  description: null,
  concept: null,
  style: { color, line: 'solid' as const },
});
const SOURCES = sourceDefs([
  {
    providerId: 'acme',
    displayName: 'Acme',
    vendor: 'Acme',
    packages: [
      {
        key: 'acme.classic',
        vendor: 'Acme',
        package: 'Classic',
        open: false,
        levels: [
          declared('zero_gamma', 'Zero Gamma', 'ZG', 'mist'),
          declared('major_pos_vol', 'Major Positive Volume', 'MPV', 'up'),
          declared('major_neg_vol', 'Major Negative Volume', 'MNV', 'down'),
        ],
      },
      {
        key: 'acme.state',
        vendor: 'Acme',
        package: 'State',
        open: false,
        levels: [
          declared('major_long_gamma', 'Major Long Gamma', 'MLG', 'teal'),
          declared('major_short_gamma', 'Major Short Gamma', 'MSG', 'brass'),
        ],
      },
    ],
    instruments: ['NQ', 'ES'],
    schedule: 'Every 2 min, US market hours',
    callsToday: [],
    spec: null,
    editable: false,
    sendsSecret: true,
    history: null,
    health: null as never,
  },
]);
const DEFS = defsOf(SOURCES);

patch(tradeSettingsStore, {
  status: 'local',
  levels: setLevelStyle(
    setLevelStyle(DEFAULT_LEVEL_SETTINGS, 'tessera.concepts.pdc', { on: false }),
    'acme.classic.zero_gamma',
    { color: 'brass' },
    DEFS,
  ),
});

export function HomeKit(_props: { section: string }) {
  return (
    <ShellDataContext.Provider
      value={{
        ...EMPTY_SHELL_DATA,
        accounts: ACCOUNTS.map((u) => u.account),
        accountId: ACCOUNTS[0]!.account.id,
        env: 'paper',
      }}
    >
      <div className="st-page">
        <div className="st-col">
          <LevelsBands sources={SOURCES} defs={DEFS} />
        </div>
      </div>
    </ShellDataContext.Provider>
  );
}
