import type { ProviderHealth, TradingAccount } from '@tessera/protocol';
import { screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analystStore, setProviders } from '../src/analyst/analystStore.ts';
import { healthStore } from '../src/app/health.ts';
import { patch, useStore } from '../src/app/store.ts';
import { SECTIONS, SETTINGS_CATEGORIES, categoryDef } from '../src/areas/settings/model.ts';
import { SettingsPage } from '../src/areas/settings/SettingsPage.tsx';
import type { ToolOutput } from '../src/app/tools.ts';
import { EMPTY_SHELL_DATA, type ShellData } from '../src/shell/shellData.ts';
import { runtimeSettingsStore } from '../src/state/runtimeSettings.ts';
import { setSettingsSection } from '../src/state/ui.ts';
import {
  expectLoadsInOneGo,
  heldReads,
  mountSurface,
  RuntimeSettingsFeed,
  settle,
  SIM,
  unmountSurface,
  type HeldReads,
} from './support/loading.tsx';

const TOOLS = [...Object.keys(SIM.tools), 'runtime.data_info', 'connections.list_credentials', 'mcp.list_clients'];

const SHELL: ShellData = {
  ...EMPTY_SHELL_DATA,
  providers: (SIM.topics.health![0] as { providers: ProviderHealth[] }).providers,
  accounts: SIM.topics.accounts!.map((u) => (u as { account: TradingAccount }).account),
  accountId: 'paper-main',
};

beforeEach(() => {
  patch(runtimeSettingsStore, { values: {}, loaded: false });
  patch(analystStore, { providers: [], healthKnown: false });
});

afterEach(unmountSurface);

function SettingsFeed() {
  const health = useStore(healthStore);
  useEffect(() => {
    if (health) setProviders(health.providers);
  }, [health]);
  return (
    <RuntimeSettingsFeed>
      <SettingsPage />
    </RuntimeSettingsFeed>
  );
}

function mount(held: HeldReads) {
  return mountSurface(held.client, <SettingsFeed />, { tools: TOOLS, shell: SHELL });
}

const dataInfo = (): ToolOutput<'runtime.data_info'> => ({
  dataDir: '/var/tessera',
  files: [{ what: 'database', path: '/var/tessera/db', bytes: 4_200_000 }],
  totalBytes: 4_200_000,
  counts: [{ what: 'workspaces', count: 3 }],
  secretStore: 'dev_file',
  secretsDir: null,
  keyringService: null,
  profile: 'release',
  version: '0.1.0',
});

const clients = (): ToolOutput<'mcp.list_clients'> => ({
  clients: [
    { id: 'cl-1', name: 'Claude Code', kind: 'claude-code', policy: 'supervised', createdAt: 1, lastUsedAt: null },
  ],
});

const settingInfos = (): ToolOutput<'settings.get'> => ({
  settings: {
    'paper.commissionStandard': {
      key: 'paper.commissionStandard',
      value: 2.5,
      default: 2.5,
      description: 'Commission',
      schema: { type: 'number' },
      userOnly: false,
    },
  },
});

const ANSWERS = { 'runtime.data_info': dataInfo, 'mcp.list_clients': clients, 'settings.get': settingInfos };

describe('Settings pages load as one unit', () => {
  it('Connections shows its logins and its exchange routes together', async () => {
    setSettingsSection('connections');
    const held = heldReads(SIM);
    const { container } = mount(held);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    expect(loading).not.toMatch(/Mock market|Default/);
    expect(loaded).toContain('Mock market');
    expect(loaded).toContain('Default · Mock market');
    expect(screen.queryByRole('status', { name: 'Loading Connections' })).toBeNull();
  });

  it.each(SETTINGS_CATEGORIES)('%s draws its skeleton from its own sections', async (category) => {
    setSettingsSection(category);
    mount(heldReads(SIM, ANSWERS));
    await settle();
    const skeleton = screen.getByRole('status', { name: `Loading ${categoryDef(category).label}` });
    const titles = [...skeleton.querySelectorAll('.t-set-sec .t-set-title')].map((t) => t.textContent);
    expect(titles).toEqual(SECTIONS[category].map((s) => s.title));
  });

  it.each([
    ['data', 'Data directory', '/var/tessera'],
    ['analyst', 'Claude Code', 'Supervised'],
    ['trading', 'Risk limits', 'Paper 2'],
    ['app', 'Tessera desktop', 'Protocol'],
    ['chart', 'Drawing tools', 'Chart colours'],
    ['levels', 'Mock gamma levels'],
    ['alerts', 'Sounds'],
  ] as const)('%s shows every section at once', async (category, ...words) => {
    setSettingsSection(category);
    const held = heldReads(SIM, ANSWERS);
    const { container } = mount(held);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    for (const w of words) {
      expect(loading).not.toContain(w);
      expect(loaded).toContain(w);
    }
  });
});
