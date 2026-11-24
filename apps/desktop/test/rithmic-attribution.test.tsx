import type { ConnectionInfo, HealthStatus, ProviderHealth } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionRows, rithmicLive } from '../src/accounts/connections.ts';
import { patch, read } from '../src/app/store.ts';
import { App } from '../src/areas/settings/categories/App.tsx';
import { settingsNavStore } from '../src/areas/settings/store.ts';
import { areaStore } from '../src/areas/store.ts';
import { RithmicMarks } from '../src/shell/RithmicMarks.tsx';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import { uiStore } from '../src/state/ui.ts';
import { connectionInfo, providerHealth } from './support/providers.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

afterEach(cleanup);

beforeEach(() => {
  patch(uiStore, { settingsSection: 'connections' });
  patch(areaStore, { area: 'desk', previous: null });
  patch(settingsNavStore, { query: '', target: null });
});

const health = (providerId: string, status: HealthStatus, kind: ProviderHealth['kind'] = 'market_data') =>
  providerHealth({ providerId, status, kind });

const info = (h: ProviderHealth, enabled: boolean): ConnectionInfo => connectionInfo(h, { enabled });

const MARKS = ['Trading Platform by Rithmic', 'Powered by OMNE'];

const NOTICES = [
  'The R | Protocol API™ software is Copyright © 2026 by Rithmic, LLC. All rights reserved.',
  'Trading Platform by Rithmic™ is a trademark of Rithmic, LLC. All rights reserved.',
  'The OMNE™ software is Copyright © 2026 by Omnesys, LLC and Omnesys Technologies, Inc. All rights reserved.',
  'Powered by OMNE™ is a trademark of Omnesys, LLC and Omnesys Technologies, Inc. All rights reserved.',
];

describe('a Rithmic login is live while it is logged in', () => {
  const live = (providers: ProviderHealth[], infos: ConnectionInfo[] = []) =>
    rithmicLive(connectionRows(providers, infos));

  it('counts a connected login and one whose data is late', () => {
    expect(live([health('rithmic-apex', 'ok')])).toBe(true);
    expect(live([health('rithmic-apex', 'degraded')])).toBe(true);
    expect(live([health('mock', 'down'), health('rithmic-tessera-test', 'ok')])).toBe(true);
  });

  it('does not count a login that is connecting, down, off or turned off, nor any other connection', () => {
    for (const status of ['unknown', 'down', 'disconnected', 'disabled'] as const)
      expect(live([health('rithmic-apex', status)])).toBe(false);
    const apex = health('rithmic-apex', 'ok');
    expect(live([apex], [info(apex, false)])).toBe(false);
    expect(live([health('mock', 'ok'), health('paper', 'ok', 'broker')])).toBe(false);
    expect(live([])).toBe(false);
  });
});

describe('the Rithmic and OMNE marks', () => {
  function mount(providers: ProviderHealth[], opensNotices: boolean) {
    const { client } = answeringClient({ 'connections.list': () => ({ connections: [], dataSource: null }) });
    setTestServices(client);
    seedTools(['connections.list']);
    const ui = (p: ProviderHealth[]) => (
      <TestRuntime client={client}>
        <TooltipProvider>
          <ShellDataContext.Provider value={{ ...EMPTY_SHELL_DATA, providers: p }}>
            <RithmicMarks opensNotices={opensNotices} />
          </ShellDataContext.Provider>
        </TooltipProvider>
      </TestRuntime>
    );
    const view = render(ui(providers));
    return { show: (p: ProviderHealth[]) => view.rerender(ui(p)) };
  }
  const shown = () => screen.queryAllByRole('img').map((i) => i.getAttribute('alt'));

  it('show in the status bar while Rithmic is logged in, go when it is not, and open the notices', () => {
    const bar = mount([health('mock', 'ok')], true);
    expect(shown()).toEqual([]);

    bar.show([health('mock', 'ok'), health('rithmic-apex', 'ok')]);
    expect(shown()).toEqual(MARKS);

    bar.show([health('rithmic-apex', 'disconnected')]);
    expect(shown()).toEqual([]);

    bar.show([health('rithmic-apex', 'degraded')]);
    fireEvent.click(screen.getByRole('button', { name: MARKS.join(' ') }));
    expect(read(areaStore).area).toBe('settings');
    expect(read(uiStore).settingsSection).toBe('app');
    expect(read(settingsNavStore).target?.id).toBe('app.notices');
  });

  it('show in a pop-out window too, as plain marks', () => {
    mount([health('rithmic-apex', 'ok')], false);
    const marks = screen.getByRole('group', { name: 'Rithmic attribution' });
    expect(
      within(marks)
        .getAllByRole('img')
        .map((i) => i.getAttribute('alt')),
    ).toEqual(MARKS);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Settings › App › Notices', () => {
  it('lists the Rithmic and OMNE copyright and trademark lines whether or not Rithmic is connected', () => {
    const { client } = answeringClient({});
    setTestServices(client);
    render(
      <TestRuntime client={client}>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </TestRuntime>,
    );
    const notices = screen.getByRole('region', { name: 'Notices' });
    expect(
      within(notices)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(NOTICES);
  });
});
