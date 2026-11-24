import type { AccountSummary, AccountUpdate, Environment } from '@tessera/protocol';
import { TooltipProvider, useDocumentEnv } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';
import { EMPTY_SHELL_DATA, ShellDataContext, type ShellData } from '../src/shell/shellData.ts';
import { AccountSwitcher } from '../src/accounts/AccountSwitcher.tsx';
import { AreaRail } from '../src/areas/AreaRail.tsx';
import { SettingsPage } from '../src/areas/settings/SettingsPage.tsx';
import { settingsNavStore } from '../src/areas/settings/store.ts';
import { areaStore, showArea } from '../src/areas/store.ts';
import { windowTitle } from '../src/shell/marks.ts';
import { uiStore } from '../src/state/ui.ts';
import { patch, read } from '../src/app/store.ts';

const money = (amount: number) => ({ amount, currency: 'USD' as const });

const account = (dayPnl = 842): AccountSummary => ({
  accountId: 'paper-main',
  balance: money(124_820),
  netLiq: money(124_820),
  dayPnl: money(dayPnl),
  realizedToday: money(0),
  feesToday: money(0),
  unrealizedToday: money(dayPnl),
  openPnl: money(0),
  buyingPower: money(0),
  asOf: 0,
});

describe('the shell’s rules', () => {
  it('puts the market in the window title, then the drafts, and no environment word', () => {
    const t = { symbol: 'NQ Z6', last: '20,641.25', pct: '−0.21%', drafts: 1 };
    expect(windowTitle(t)).toBe('NQ Z6 20,641.25 −0.21% · 1 draft');
    expect(windowTitle({ ...t, drafts: 0 })).toBe('NQ Z6 20,641.25 −0.21%');
    expect(windowTitle({ symbol: null, last: null, pct: null, drafts: 2 })).toBe('Tessera · 2 drafts');
  });
});

describe('the environment has one source, and the band names none', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = {};
    patch(uiStore, { settingsSection: 'connections' });
    patch(areaStore, { area: 'desk', previous: null });
    patch(settingsNavStore, { query: '', target: null });
  });
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-env');
  });

  function EnvRoot({ data, children }: { data: ShellData; children: ReactNode }) {
    useDocumentEnv(data.env);
    return <>{children}</>;
  }
  const mount = (data: Partial<ShellData>, children: ReactNode = <AreaRail />) => {
    const value = { ...EMPTY_SHELL_DATA, ...data };
    return render(
      <TestRuntime client={client} bridge={{ kind: 'browser' }}>
        <TooltipProvider>
          <ShellDataContext.Provider value={value}>
            <EnvRoot data={value}>{children}</EnvRoot>
          </ShellDataContext.Provider>
        </TooltipProvider>
      </TestRuntime>,
    );
  };

  it('the band names no environment and no account: they live with the account (decision 0008 §3)', () => {
    const { container } = mount({ env: 'eval', accountId: 'paper-main' });
    expect(document.documentElement.getAttribute('data-env')).toBe('eval');
    expect(container.textContent).not.toMatch(/Paper|Eval|Live/);
    expect(container.querySelector('[data-env]')).toBeNull();
    expect(container.textContent).not.toContain('paper-main');
  });

  it('live and funded name their environment on the window, not on the band', () => {
    const { container } = mount({ env: 'funded', accountId: 'paper-main' });
    expect(document.documentElement.getAttribute('data-env')).toBe('live');
    expect(container.textContent).not.toMatch(/Live|Funded/);
  });

  it('the first run has no environment', () => {
    mount({});
    expect(document.documentElement.hasAttribute('data-env')).toBe(false);
  });

  const update = (environment: Environment, displayName: string): AccountUpdate => ({
    account: {
      id: displayName,
      displayName,
      environment,
      brokerId: 'tessera-paper',
      connectionId: 'paper',
      programId: null,
      ruleSetId: null,
      currency: 'USD',
      restrictions: { noCopyTrading: false, blockedInstruments: [], loosenNextSession: false },
      groupId: null,
      externalRefMasked: null,
    },
    summary: { ...account(), accountId: displayName },
    risk: null,
  });

  it('the account switcher names the account and its net liq, never its environment (spec §4.2)', () => {
    const switcher = (u: AccountUpdate) => {
      const { unmount } = mount({}, <AccountSwitcher updates={[u]} current={u} onPick={() => undefined} />);
      const b = screen.getByRole('button', { name: /^Account: / });
      const out = b.textContent;
      unmount();
      return out;
    };
    expect(switcher(update('paper', 'paper-main'))).toBe('paper-main$124,820.00');
    expect(switcher(update('eval', 'Apex 50K'))).toBe('Apex 50K$124,820.00');
    expect(switcher(update('live', 'Apex PA 1'))).not.toMatch(/Live|Paper|Eval/);
  });

  it('the switcher’s list names each account the same way, marks the current one and picks for this ticket', () => {
    const all = [update('paper', 'paper-main'), update('eval', 'Apex 50K'), update('live', 'Apex PA 1')];
    const picked: string[] = [];
    mount({}, <AccountSwitcher updates={all} current={all[0]!} onPick={(id) => picked.push(id)} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /^Account: paper-main/ }), { key: 'Enter' });
    const list = screen.getByRole('menu');
    const rows = [...list.querySelectorAll('.tk-acct-row')];
    expect(rows.map((r) => r.querySelector('.nm')?.textContent)).toEqual(['paper-main', 'Apex 50K', 'Apex PA 1']);
    expect(rows.map((r) => r.classList.contains('is-on'))).toEqual([true, false, false]);
    expect(list.querySelector('.ck, .t-icon[data-name="approve"]')).toBeNull();
    expect(list.textContent).not.toMatch(/Paper|Eval|Live|Funded/);
    fireEvent.click(rows[1]!);
    expect(picked).toEqual(['Apex 50K']);
  });

  it('the band has no gear: Feedback and Settings are the rail’s, at its foot; the logo is the app menu, nothing toggles a panel', () => {
    const { container } = mount({ drafts: 1 });
    expect(container.querySelector('.ar-rail-head .app-menu-btn i[data-size]')?.getAttribute('data-state')).toBe(
      'rest',
    );
    expect(container.querySelector('.ar-rail-head')?.textContent).toBe('');
    expect(container.querySelector('.ar-rail-foot')?.textContent).toBe('FeedbackSettings');
    expect(screen.queryByRole('button', { name: 'Trade' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Panels' })).toBeNull();
  });

  it('the rail names each area under its icon, Markets after the desk, the Trade copier after Journal, Feedback and Settings at its foot; the Analyst, Indicators, Journal and Trade copier panels drag onto the desk', () => {
    const { container } = mount({}, <AreaRail />);
    const items = [...container.querySelectorAll<HTMLButtonElement>('.t-rail-item')];
    expect(items.map((b) => b.textContent)).toEqual([
      'Desk',
      'Markets',
      'Analyst',
      'Indicators',
      'Research',
      'Journal',
      'Trade copier',
      'Feedback',
      'Settings',
    ]);
    expect(container.querySelector('.ar-rail-foot')?.textContent).toBe('FeedbackSettings');
    expect(items[0]!.getAttribute('aria-current')).toBe('page');
    fireEvent.click(items[8]!);
    expect(read(areaStore)).toMatchObject({ area: 'settings', previous: 'desk' });
    expect(items[8]!.getAttribute('aria-current')).toBe('page');
    const draggable = items.filter((b) => b.getAttribute('draggable') === 'true').map((b) => b.textContent);
    expect(draggable).toEqual(['Analyst', 'Indicators', 'Journal', 'Trade copier']);
    fireEvent.click(items[2]!);
    expect(read(areaStore)).toMatchObject({ area: 'agents', previous: 'settings' });
    expect(items[2]!.getAttribute('aria-current')).toBe('page');
  });

  it('Settings: its categories; the search finds a row by its words and goes to it; Esc goes back', () => {
    act(() => showArea('journal'));
    act(() => showArea('settings'));
    mount({}, <SettingsPage />);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const cats = [...nav.querySelectorAll('.t-set-nav-item')].map((b) => b.textContent);
    expect(cats).toEqual([
      'Connections',
      'Trading and risk',
      'Chart',
      'Levels',
      'Alerts and sounds',
      'Analyst',
      'Data',
      'Appearance',
      'App',
    ]);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Connections' }).textContent).toContain('Your connections');
    const search = screen.getByRole('combobox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'spacing' } });
    const found = screen.getByRole('listbox', { name: 'Settings found' });
    expect(found.querySelector('.st-result .t')?.textContent).toBe('Row density');
    fireEvent.change(search, { target: { value: 'commission' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(read(uiStore).settingsSection).toBe('trading');
    expect(read(settingsNavStore)).toMatchObject({ query: '', target: { id: 'trading.commission' } });
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(read(areaStore).area).toBe('journal');
  });
});
