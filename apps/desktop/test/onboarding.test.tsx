import type { ConnectionInfo, Instrument, ProviderHealth } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstContract, needsOnboarding } from '../src/accounts/onboarding.ts';
import type * as Actions from '../src/markets/actions.ts';
import { read, write } from '../src/app/store.ts';
import { Arrival } from '../src/shell/Arrival.tsx';
import { arrivalStore } from '../src/shell/arrival.ts';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import {
  ALL_SAVED,
  UNMEASURED,
  deskOf,
  emptyDesk,
  estimate,
  estimates,
  pull,
  refusingClient,
  specs,
} from './support/history.tsx';
import { actPause } from './support/pause.ts';
import { connectionInfo, providerHealth } from './support/providers.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime, type FakeClient } from './support/runtime.tsx';

const { opened } = vi.hoisted(() => ({ opened: [] as [string, string][] }));
vi.mock('../src/markets/actions.ts', async (original) => ({
  ...(await original<typeof Actions>()),
  openMarket: (instrument: string, how: string) => {
    opened.push([instrument, how]);
    return Promise.resolve(true);
  },
}));

const health = (over: Partial<ProviderHealth> & Pick<ProviderHealth, 'providerId' | 'kind'>): ProviderHealth =>
  providerHealth(over);

const RUNTIME = health({ providerId: 'runtime', kind: 'runtime' });
const PAPER = health({ providerId: 'paper', kind: 'broker', displayName: 'Paper trading' });
const ZETA = health({ providerId: 'zeta', kind: 'intelligence', displayName: 'Zeta' });
const APEX = health({ providerId: 'rithmic-apex', kind: 'market_data', displayName: 'Apex · Rithmic' });

const info = (h: ProviderHealth, enabled: boolean | null = null): ConnectionInfo => connectionInfo(h, { enabled });

const contract = (id: string, root: string, isFront = true): Instrument => ({
  id,
  symbol: id.split('.')[0]!,
  name: `${root} Dec 2026`,
  assetClass: 'future',
  exchange: 'CME',
  currency: 'USD',
  root,
  expiry: '2026-12-18',
  isFront,
  tradable: true,
});

describe('whether a window opens on the onboarding', () => {
  it('waits for the health and the connection list', () => {
    expect(needsOnboarding([], [])).toBeNull();
    expect(needsOnboarding([RUNTIME, PAPER], null)).toBeNull();
  });

  it('asks for a login while nothing serves prices: paper trading and levels do not count', () => {
    expect(needsOnboarding([RUNTIME, PAPER], [info(PAPER)])).toBe(true);
    expect(needsOnboarding([RUNTIME, PAPER, ZETA], [info(PAPER), info(ZETA)])).toBe(true);
  });

  it('does not once a login is there: connected, still connecting, down, or switched off', () => {
    expect(needsOnboarding([RUNTIME, PAPER, APEX], [])).toBe(false);
    expect(needsOnboarding([RUNTIME, PAPER, { ...APEX, status: 'unknown' }], [])).toBe(false);
    expect(needsOnboarding([RUNTIME, PAPER, { ...APEX, status: 'down' }], [])).toBe(false);
    expect(needsOnboarding([RUNTIME, PAPER], [info(PAPER), info(APEX, false)])).toBe(false);
    const reading = info({ ...APEX, status: 'unknown' }, true);
    expect(needsOnboarding([RUNTIME, PAPER], [info(PAPER), reading])).toBe(false);
    const unreadable = { ...info({ ...APEX, status: 'down' }, true), credential: 'unreadable' as const };
    expect(needsOnboarding([RUNTIME, PAPER], [info(PAPER), unreadable])).toBe(false);
  });

  it('charts the login’s first front month', () => {
    const nq = contract('NQZ6.CME-RITHMIC', 'NQ');
    const es = contract('ESZ6.CME-RITHMIC', 'ES');
    expect(firstContract([nq, es])).toBe(nq.id);
    expect(firstContract([contract('NQH7.CME-RITHMIC', 'NQ', false), es])).toBe(es.id);
    expect(firstContract([contract('NQH7.CME-RITHMIC', 'NQ', false)])).toBe('NQH7.CME-RITHMIC');
    expect(firstContract([])).toBeNull();
  });
});

describe('the window’s arrival', () => {
  beforeEach(() => {
    write(arrivalStore, { shown: false, onboarding: false, arrived: false });
    opened.length = 0;
  });
  afterEach(() => {
    cleanup();
  });

  function arrive(client: FakeClient, providers: ProviderHealth[]) {
    setTestServices(client);
    seedTools(['connections.list', 'market.list_instruments']);
    return render(
      <TestRuntime client={client}>
        <ShellDataContext.Provider value={{ ...EMPTY_SHELL_DATA, providers }}>
          <Arrival />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
  }

  const DIRECTORY = {
    'connections.rithmic_directory': ({ system }: { system?: string }) => ({
      systems: ['Apex', 'Bulenox', 'Rithmic Paper Trading'],
      gateways: system ? ['Chicago Area', 'Europe'] : [],
      problem: null,
    }),
  };

  it('opens on the Rithmic login on a first run, the shell under it taking no keys', async () => {
    const { client } = answeringClient({
      ...DIRECTORY,
      'connections.list': () => ({ connections: [info(PAPER)], dataSource: null }),
    });
    arrive(client, [RUNTIME, PAPER, ZETA]);
    const dialog = await screen.findByRole('dialog', { name: 'Connect your Rithmic login' });
    expect(within(dialog).getByRole('button', { name: 'Firm' })).toBeTruthy();
    expect(within(dialog).getByLabelText('User')).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>('Password').type).toBe('password');
    expect(within(dialog).getByRole('heading', { name: 'Connect your Rithmic login' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Test' })).toBeTruthy();
    expect(within(dialog).getByText(/^Saved securely on this (Mac|computer), sent only to Rithmic$/)).toBeTruthy();
    expect(read(arrivalStore).onboarding).toBe(true);
  });

  it('goes straight to the desk when a login is there, and shows once a page', async () => {
    const { client } = answeringClient({
      'connections.list': () => ({ connections: [info(PAPER), info(APEX, true)], dataSource: 'rithmic-apex' }),
    });
    const first = arrive(client, [RUNTIME, PAPER, APEX]);
    await actPause();
    await actPause();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.t-sh-splash.is-exit')).not.toBeNull();
    expect(read(arrivalStore)).toEqual({ shown: true, onboarding: false, arrived: false });
    first.unmount();
    arrive(client, [RUNTIME, PAPER]);
    await actPause();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.t-sh-splash')).toBeNull();
  });

  it('does not ask while a saved login is switched off', async () => {
    const { client } = answeringClient({
      'connections.list': () => ({ connections: [info(PAPER), info(APEX, false)], dataSource: null }),
    });
    arrive(client, [RUNTIME, PAPER]);
    await actPause();
    await actPause();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Not now goes on to the app as it is', async () => {
    const { client, calls } = answeringClient({
      ...DIRECTORY,
      'connections.list': () => ({ connections: [], dataSource: null }),
    });
    arrive(client, [RUNTIME, PAPER]);
    const dialog = await screen.findByRole('dialog', { name: 'Connect your Rithmic login' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await actPause();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(read(arrivalStore).onboarding).toBe(false);
    expect(calls.map((c) => c.name)).not.toContain('connections.add_rithmic');
    expect(opened).toEqual([]);
  });

  const CONNECTED_LOGIN = {
    'connections.list': () => ({ connections: [], dataSource: null }),
    'connections.add_rithmic': () => ({ connection: info(APEX, true), storedIn: 'keyring' as const }),
    'market.list_instruments': () => ({
      connections: [
        {
          id: 'rithmic-apex',
          displayName: 'Apex · Rithmic',
          feedsDesk: true,
          instruments: [contract('NQZ6.CME-RITHMIC', 'NQ'), contract('ESZ6.CME-RITHMIC', 'ES')],
          error: null,
        },
      ],
    }),
  };

  async function signIn(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Firm' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Apex' }));
    await vi.waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Gateway' }).textContent).toContain('Chicago Area'),
    );
    fireEvent.change(within(dialog).getByLabelText('User'), { target: { value: 'trader' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
  }

  const OFFER = 'Your market data stays on this computer';
  const OFFER_TOOLS = [
    'connections.list',
    'market.list_instruments',
    'market.estimate_pull',
    'market.get_contract_spec',
    'market.pull_trades',
  ];

  it('connects the login and charts its first front month on the desk', async () => {
    const { client, calls } = answeringClient({ ...DIRECTORY, ...CONNECTED_LOGIN });
    arrive(client, [RUNTIME, PAPER]);
    seedTools(OFFER_TOOLS);
    const dialog = await screen.findByRole('dialog', { name: 'Connect your Rithmic login' });
    await signIn(dialog);

    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: OFFER })).not.toBeNull());
    expect(calls).toContainEqual({
      name: 'connections.add_rithmic',
      input: { system: 'Apex', gateway: 'Chicago Area', user: 'trader', password: 'secret' },
    });
    expect(calls).toContainEqual({
      name: 'market.list_instruments',
      input: { connection: 'rithmic-apex', assetClass: 'future', limit: 4 },
    });
    await vi.waitFor(() => expect(opened).toEqual([['NQZ6.CME-RITHMIC', 'chart']]));
    expect(read(arrivalStore).onboarding).toBe(true);
  });

  describe('the offer of a week of history after the login', () => {
    const NQ = estimate('NQ');
    const ES = estimate('ES', UNMEASURED);
    const MNQ = estimate('MNQ', ALL_SAVED);
    const MES = estimate('MES', { size: { bytes: 20 * 1024 * 1024, prints: 1, measuredPrints: 1 }, seconds: 60 });

    function offerAnswers(served = { NQ, ES, MNQ, MES }) {
      return {
        ...DIRECTORY,
        ...CONNECTED_LOGIN,
        ...specs(['NQ', 'ES']),
        ...estimates(served),
        'market.pull_trades': (r: { instrument: string }) => pull(r.instrument, 0),
      };
    }

    async function offered(served?: Parameters<typeof offerAnswers>[0]) {
      const { client, calls } = refusingClient(offerAnswers(served));
      deskOf(['NQ', 'ES']);
      arrive(client, [RUNTIME, PAPER]);
      seedTools([
        'connections.list',
        'market.list_instruments',
        'market.estimate_pull',
        'market.get_contract_spec',
        'market.pull_trades',
      ]);
      const login = await screen.findByRole('dialog', { name: 'Connect your Rithmic login' });
      await signIn(login);
      const dialog = await screen.findByRole('dialog', { name: OFFER });
      await vi.waitFor(() => expect(within(dialog).queryByRole('checkbox', { name: /^NQ Z6/ })).not.toBeNull());
      return { dialog, calls };
    }

    const pulled = (calls: { name: string; input: unknown }[]) =>
      calls.filter((c) => c.name === 'market.pull_trades').map((c) => c.input);

    afterEach(() => {
      emptyDesk();
    });

    it('says whose prices it saves and where, then lists the desk’s markets checked and the watchlists’ not', async () => {
      const { dialog } = await offered();
      expect(within(dialog).getByRole('heading', { name: OFFER })).toBeTruthy();
      expect(dialog.textContent).toContain(
        'Tessera charts the prices of your own feed, Apex · Rithmic, and saves what it reads here, nowhere else. Replay and the order-flow studies read that saved history, so a week of it fills them from the first day.',
      );
      expect(within(dialog).getByText('Download the last week')).toBeTruthy();
      const box = (name: RegExp) => within(dialog).getByRole<HTMLInputElement>('checkbox', { name });
      expect(box(/^NQ Z6/).checked).toBe(true);
      expect(box(/^NQ Z6/).labels?.[0]?.textContent).toBe('NQ Z65 days · about 410 MB');
      expect(box(/^ES Z6/).checked).toBe(true);
      expect(box(/^ES Z6/).labels?.[0]?.textContent).toBe('ES Z65 days · size not known yet');
      expect(box(/^MES Z6/).checked).toBe(false);
      expect(box(/^MNQ Z6/).checked).toBe(false);
      expect(box(/^MNQ Z6/).disabled).toBe(true);
      expect(box(/^MNQ Z6/).labels?.[0]?.textContent).toBe('MNQ Z65 days · saved');
      expect(within(dialog).queryByRole('checkbox', { name: /RTY/ })).toBeNull();
    });

    it('says what it does not know yet, with the reason in a tooltip', async () => {
      const { dialog } = await offered();
      expect(within(dialog).getByRole('status').textContent).toBe('Size not known yet');
      fireEvent.pointerMove(within(dialog).getByText('size not known yet'));
      fireEvent.focus(within(dialog).getByText('size not known yet'));
      expect(
        (
          await screen.findAllByText(
            'Tessera measures a day’s size from the trades of ES it has saved from this connection. None are saved yet.',
          )
        ).length,
      ).toBeGreaterThan(0);
    });

    it('totals the checked rows once every one of them is measured', async () => {
      const { dialog } = await offered();
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /^ES Z6/ }));
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /^MES Z6/ }));
      expect(within(dialog).getByRole('status').textContent).toBe(
        'About 430 MB and 5 minutes. It runs in the background while you chart.',
      );
    });

    it('starts the checked rows’ own requests, and only those, then leaves saying so', async () => {
      const { dialog, calls } = await offered();
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /^ES Z6/ }));
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /^MES Z6/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(pulled(calls)).toEqual([NQ.request, MES.request]);
      expect(screen.getByText('Downloading the last week')).toBeTruthy();
      expect(read(arrivalStore).onboarding).toBe(false);
    });

    it('Not now pulls nothing and says where to do it later', async () => {
      const { dialog, calls } = await offered();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(pulled(calls)).toEqual([]);
      expect(screen.getByText('Settings › Data can download it later')).toBeTruthy();
    });

    it('cannot download with nothing checked, and says what to do', async () => {
      const { dialog, calls } = await offered();
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /^NQ Z6/ }));
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /^ES Z6/ }));
      const download = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Download' });
      expect(download.disabled).toBe(true);
      expect(within(dialog).queryByRole('status')).toBeNull();
      fireEvent.pointerMove(download.parentElement!);
      fireEvent.focus(download.parentElement!);
      expect((await screen.findAllByText('Pick a market to download')).length).toBeGreaterThan(0);
      fireEvent.click(download);
      expect(pulled(calls)).toEqual([]);
    });

    it('keeps the dialog open and says which market refused to start', async () => {
      const { client, calls } = refusingClient({
        ...offerAnswers(),
        'market.pull_trades': ({ instrument }: { instrument: string }) => {
          throw new Error(`${instrument} cannot start`);
        },
      });
      deskOf(['NQ', 'ES']);
      arrive(client, [RUNTIME, PAPER]);
      seedTools([
        'connections.list',
        'market.list_instruments',
        'market.estimate_pull',
        'market.get_contract_spec',
        'market.pull_trades',
      ]);
      await signIn(await screen.findByRole('dialog', { name: 'Connect your Rithmic login' }));
      const dialog = await screen.findByRole('dialog', { name: OFFER });
      await vi.waitFor(() => expect(within(dialog).queryByRole('checkbox', { name: /^NQ Z6/ })).not.toBeNull());
      fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
      expect((await within(dialog).findByRole('alert')).textContent).toBe('NQ Z6: NQ cannot start');
      expect(screen.queryByRole('dialog', { name: OFFER })).not.toBeNull();
      expect(pulled(calls).length).toBe(2);
    });

    it('follows the desk’s charts as they appear, until a box is touched', async () => {
      const { client } = refusingClient(offerAnswers());
      emptyDesk();
      arrive(client, [RUNTIME, PAPER]);
      seedTools([
        'connections.list',
        'market.list_instruments',
        'market.estimate_pull',
        'market.get_contract_spec',
        'market.pull_trades',
      ]);
      await signIn(await screen.findByRole('dialog', { name: 'Connect your Rithmic login' }));
      const dialog = await screen.findByRole('dialog', { name: OFFER });
      await vi.waitFor(() => expect(within(dialog).queryByRole('checkbox', { name: /^NQ Z6/ })).not.toBeNull());
      const checked = () =>
        within(dialog)
          .getAllByRole<HTMLInputElement>('checkbox')
          .filter((c) => c.checked)
          .map((c) => c.closest('label')?.querySelector('.nm')?.textContent);
      expect(checked()).toEqual([]);
      act(() => deskOf(['ES']));
      await vi.waitFor(() => expect(checked()).toEqual(['ES Z6']));
      act(() => deskOf(['ES', 'NQ']));
      await vi.waitFor(() => expect(checked()).toEqual(['ES Z6', 'NQ Z6']));
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /^MES Z6/ }));
      act(() => deskOf(['NQ']));
      await actPause();
      expect(checked()).toEqual(['NQ Z6', 'ES Z6', 'MES Z6']);
    });
  });

  it('says plainly that Rithmic refused a login and what to check, and keeps the form', async () => {
    const refusing: FakeClient = {
      request: (method: string, params: { name?: string; input?: { system?: string } } | undefined) => {
        if (method !== 'tools.invoke') return new Promise(() => undefined);
        if (params?.name === 'connections.add_rithmic')
          return Promise.resolve({
            ok: false,
            error: { message: 'Rithmic refused the login: permission denied (code 13)' },
          });
        if (params?.name === 'connections.list')
          return Promise.resolve({ ok: true, output: { connections: [], dataSource: null } });
        if (params?.name === 'connections.rithmic_directory')
          return Promise.resolve({ ok: true, output: DIRECTORY['connections.rithmic_directory'](params.input ?? {}) });
        return new Promise(() => undefined);
      },
    };
    arrive(refusing, [RUNTIME, PAPER]);
    const dialog = await screen.findByRole('dialog', { name: 'Connect your Rithmic login' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Firm' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Apex' }));
    await vi.waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Gateway' }).textContent).toContain('Chicago Area'),
    );
    fireEvent.change(within(dialog).getByLabelText('User'), { target: { value: 'trader' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(within(dialog).getByRole('status').textContent).toMatch(/^Logging in to Apex · /);
    await vi.waitFor(() =>
      expect(within(dialog).getByRole('status').textContent).toBe(
        'Rithmic refused the login. Check the user name and password. Nothing saved.',
      ),
    );
    expect(screen.getByRole('dialog', { name: 'Connect your Rithmic login' })).toBeTruthy();
    expect(opened).toEqual([]);
  });
});
