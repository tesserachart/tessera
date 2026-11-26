import type { AccountUpdate, CopyGroup, CopySyncUpdate } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyStore } from '../src/accounts/copy.ts';
import { patch, read, write } from '../src/app/store.ts';
import { CopyPanel } from '../src/areas/copy/CopyPanel.tsx';
import { copyUiStore, openCopyGroup } from '../src/areas/copy/store.ts';
import { AreaRail } from '../src/areas/AreaRail.tsx';
import { AreaView } from '../src/areas/AreaView.tsx';
import { areaStore } from '../src/areas/store.ts';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import { CommandRegistry } from '../src/commands/registry.ts';
import { tileDefinition } from '../src/workspace/tiles/index.ts';
import type * as Tools from '../src/app/tools.ts';
import type * as OrderEntry from '../src/shell/orderEntry.ts';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import { TestRuntime } from './support/runtime.tsx';

const calls = vi.hoisted(() => [] as { name: string; input: unknown; options: unknown }[]);
const runtimeSays = vi.hoisted(() => ({ said: [] as string[] }));

vi.mock('../src/app/tools.ts', async (original) => ({
  ...(await original<typeof Tools>()),
  attempt: (name: string, input: unknown, options?: Tools.AttemptOptions) => {
    const { unanswered: _, ...sent } = options ?? {};
    calls.push({ name, input, options: options === undefined ? undefined : sent });
    const report = { groupId: 'cg1', groupName: 'Evals', leaderId: 'lead', results: [] };
    return Promise.resolve({ ok: true, out: { report, group: { id: 'cg1' }, said: runtimeSays.said } });
  },
}));

vi.mock('../src/shell/orderEntry.ts', async (original) => ({
  ...(await original<typeof OrderEntry>()),
  useConnectionList: () => [],
}));

function update(id: string, environment: 'paper' | 'eval'): AccountUpdate {
  return {
    account: {
      id,
      displayName: id === 'lead' ? 'Lead' : `Eval ${id.slice(1)}`,
      connectionId: 'tessera-paper',
      environment,
    },
  } as unknown as AccountUpdate;
}

const group: CopyGroup = {
  id: 'cg1',
  name: 'Evals',
  leaderId: 'lead',
  followers: [
    { accountId: 'e1', multiplier: 1 },
    { accountId: 'e2', multiplier: 1, micro: true },
  ],
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const sync: CopySyncUpdate = {
  checkedAt: 0,
  groups: [
    {
      groupId: 'cg1',
      leaderId: 'lead',
      leader: 'Lead',
      leaderHoldings: [{ instrument: 'NQZ6.CME', qty: 2 }],
      outOfSync: 1,
      recent: [],
      followers: [
        {
          accountId: 'e1',
          account: 'Eval 1',
          state: 'in_sync',
          why: null,
          since: null,
          holdings: [{ leaderInstrument: 'NQZ6.CME', instrument: 'NQZ6.CME', leaderQty: 2, targetQty: 2, qty: 2 }],
          last: null,
        },
        {
          accountId: 'e2',
          account: 'Eval 2',
          state: 'out_of_sync',
          why: 'holds Flat, should hold Long 2 MNQZ6',
          since: 0,
          holdings: [{ leaderInstrument: 'NQZ6.CME', instrument: 'MNQZ6.CME', leaderQty: 2, targetQty: 2, qty: 0 }],
          last: { what: 'Buy 2 NQZ6', outcome: 'skipped', text: 'Daily loss limit reached', at: 0 },
        },
      ],
    },
  ],
};

const ACCOUNTS = [update('lead', 'paper'), update('e1', 'eval'), update('e2', 'eval'), update('e3', 'eval')];

function panel(accountUpdates: AccountUpdate[]) {
  return (
    <ShellDataContext.Provider value={{ ...EMPTY_SHELL_DATA, accounts: accountUpdates.map((u) => u.account) }}>
      <CopyPanel />
    </ShellDataContext.Provider>
  );
}

function mount() {
  return render(panel(ACCOUNTS));
}

beforeEach(() => {
  calls.length = 0;
  runtimeSays.said = [];
  write(copyUiStore, { group: null, creating: false, said: null });
});

afterEach(() => {
  cleanup();
  patch(copyStore, { groups: null, sync: null });
});

describe('the Trade copier', () => {
  it('opens on the group an account’s word names, on the Trade copier page', () => {
    write(areaStore, { area: 'journal', previous: null });
    openCopyGroup('cg2');
    expect(read(areaStore).area).toBe('copy');
    expect(read(copyUiStore).group).toBe('cg2');
    write(areaStore, { area: 'desk', previous: null });
  });

  it('says what copying is in one line, with New group, when there are no groups', () => {
    patch(copyStore, { groups: [] });
    mount();
    expect(screen.getByText('Copy one account’s orders to your others: a leader and its followers.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    expect(screen.getByRole('region', { name: 'New group' })).toBeTruthy();
  });

  it('creates a group led by the first account that can lead, also when the accounts arrive after the form', async () => {
    patch(copyStore, { groups: [] });
    const view = render(panel([]));
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    const create = () =>
      within(screen.getByRole('region', { name: 'New group' })).getByRole('button', { name: 'Create' });
    expect((create() as HTMLButtonElement).disabled).toBe(true);
    view.rerender(panel(ACCOUNTS));
    expect((create() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(create());
      await Promise.resolve();
    });
    expect(calls.map((c) => [c.name, (c.input as { leaderId?: string }).leaderId])).toEqual([['copy.create', 'lead']]);
  });

  it('says what the runtime did when a follower is paused', async () => {
    runtimeSays.said = ['Cancelled Eval 1’s working copy of Buy 2 NQZ6 limit 20,600.00.'];
    patch(copyStore, { groups: [group], sync });
    mount();
    const detail = screen.getByRole('region', { name: 'Evals' });
    await act(async () => {
      fireEvent.click(within(detail).getByRole('switch', { name: 'Copy to Eval 1' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls.at(-1)?.name).toBe('copy.update');
    expect(within(detail).getByText('Cancelled Eval 1’s working copy of Buy 2 NQZ6 limit 20,600.00.')).toBeTruthy();
  });

  it('shows the group, its leader, each follower’s sync and a skipped copy, and the recent copies', () => {
    const recent = [
      { what: 'Buy 2 NQZ6', at: 0, copied: 1, of: 2, detail: 'Eval 2 skipped: Daily loss limit reached.' },
    ];
    patch(copyStore, { groups: [group], sync: { ...sync, groups: [{ ...sync.groups[0]!, recent }] } });
    mount();
    const list = screen.getByRole('navigation', { name: 'Copy groups' });
    expect(within(list).getByText(/Lead → 2 followers/)).toBeTruthy();
    expect(within(list).getByText(/1 out of sync/)).toBeTruthy();
    const detail = screen.getByRole('region', { name: 'Evals' });
    expect(within(detail).getByText('Long 2 NQ Z6', { selector: '.cp-leader .h' })).toBeTruthy();
    const table = within(detail).getByRole('table', { name: 'Evals followers' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('In sync')).toBeTruthy();
    expect(within(rows[1]!).getByText('holds Flat, should hold Long 2 MNQZ6')).toBeTruthy();
    expect(within(rows[1]!).getByText('Buy 2 NQZ6: Daily loss limit reached')).toBeTruthy();
    expect(rows[1]!.hasAttribute('data-wrong')).toBe(true);
    expect(rows[0]!.hasAttribute('data-wrong')).toBe(false);
    expect(
      within(detail).getByText('Buy 2 NQZ6: copied to 1 of 2 · Eval 2 skipped: Daily loss limit reached.'),
    ).toBeTruthy();
  });

  it('says plainly a group that is off copies nothing, starts it from there, and dims its followers’ switches', async () => {
    patch(copyStore, { groups: [{ ...group, enabled: false }], sync });
    mount();
    const list = screen.getByRole('navigation', { name: 'Copy groups' });
    expect(within(list).getByText(/· Off/)).toBeTruthy();
    const detail = screen.getByRole('region', { name: 'Evals' });
    expect(within(detail).getByRole('switch', { name: 'Copy Evals' }).getAttribute('aria-checked')).toBe('false');
    expect(within(detail).getByText('Copying off')).toBeTruthy();
    expect(within(detail).getByText('Off: trades on Lead are not copied.')).toBeTruthy();
    const rows = within(within(detail).getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.every((r) => r.querySelector('.c-copying')?.classList.contains('is-group-off'))).toBe(true);
    await act(async () => {
      fireEvent.click(within(detail).getByRole('button', { name: 'Start copying' }));
      await Promise.resolve();
    });
    expect(calls.map((c) => [c.name, c.input])).toEqual([['copy.enable', { groupId: 'cg1' }]]);
  });

  it('says a group that is on is copying, with no off line', () => {
    patch(copyStore, { groups: [group], sync });
    mount();
    const detail = screen.getByRole('region', { name: 'Evals' });
    expect(within(detail).getByText('Copying on')).toBeTruthy();
    expect(within(detail).queryByText(/are not copied/)).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Copy groups' })).queryByText(/· Off/)).toBeNull();
    const rows = within(within(detail).getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.some((r) => r.querySelector('.c-copying')?.classList.contains('is-group-off'))).toBe(false);
  });

  it('calls the runtime for each action: resync and flatten the group or one account, pause, micro', async () => {
    patch(copyStore, { groups: [group], sync });
    mount();
    const detail = screen.getByRole('region', { name: 'Evals' });
    await act(async () => {
      fireEvent.click(within(detail).getAllByRole('button', { name: 'Resync' })[0]!);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(detail).getByRole('button', { name: 'Flatten all' }));
      await Promise.resolve();
    });
    const rows = within(within(detail).getByRole('table')).getAllByRole('row').slice(1);
    await act(async () => {
      expect(within(rows[1]!).queryByRole('button', { name: 'Flatten' })).toBeNull();
      fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Flatten' }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(rows[0]!).getByRole('switch', { name: 'Copy to Eval 1' }));
      await Promise.resolve();
    });
    expect(calls.map((c) => [c.name, c.input, c.options])).toEqual([
      ['copy.resync', { groupId: 'cg1' }, { surface: { armed: true, holdConfirmed: true }, queue: false }],
      ['copy.flatten', { groupId: 'cg1' }, { surface: { armed: true, holdConfirmed: false }, queue: false }],
      [
        'copy.flatten',
        { groupId: 'cg1', accountId: 'e1' },
        { surface: { armed: true, holdConfirmed: false }, queue: false },
      ],
      [
        'copy.update',
        {
          groupId: 'cg1',
          followers: [
            { accountId: 'e1', multiplier: 1, paused: true },
            { accountId: 'e2', multiplier: 1, micro: true },
          ],
        },
        undefined,
      ],
    ]);
  });
});

describe('the Trade copier’s page', () => {
  const page = () => document.querySelector<HTMLElement>('.ar-layer[data-area="copy"]');
  const shown = () => page() !== null && !page()!.hidden;

  beforeEach(() => {
    write(areaStore, { area: 'desk', previous: null });
    patch(copyStore, { groups: [group], sync });
    render(
      <TestRuntime client={{}} bridge={{ kind: 'browser' }}>
        <TooltipProvider>
          <ShellDataContext.Provider value={{ ...EMPTY_SHELL_DATA, accounts: ACCOUNTS.map((u) => u.account) }}>
            <AreaRail />
            <AreaView desk={<div />} />
          </ShellDataContext.Provider>
        </TooltipProvider>
      </TestRuntime>,
    );
  });

  afterEach(() => write(areaStore, { area: 'desk', previous: null }));

  it('opens full page from the rail, with the group list and the selected group', async () => {
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Areas' })).getByRole('button', { name: 'Trade copier' }),
    );
    expect(read(areaStore).area).toBe('copy');
    expect(shown()).toBe(true);
    const section = await within(page()!).findByRole('region', { name: 'Trade copier' });
    expect(within(section).getByRole('heading', { level: 1, name: 'Trade copier' })).toBeTruthy();
    expect(within(section).getByRole('navigation', { name: 'Copy groups' })).toBeTruthy();
    expect(within(section).getByRole('region', { name: 'Evals' })).toBeTruthy();
  });

  it('opens full page from ⌥9 and from Go to Trade copier in ⌘K', () => {
    const r = new CommandRegistry();
    const off = registerBuiltinCommands(r, { focusComposer: () => {} });
    const alt9 = { key: '9', code: 'Digit9', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false };
    act(() => {
      expect(r.handleKey(alt9, 'chart', 'other', false)).toBe('area.copy');
    });
    expect(shown()).toBe(true);
    act(() => write(areaStore, { area: 'desk', previous: null }));
    expect(shown()).toBe(false);
    const go = r.get('area.copy')!;
    expect(go.title).toBe('Go to Trade copier');
    act(() => void go.run());
    expect(shown()).toBe(true);
    off();
  });

  it('is still a panel tile the desk can add', () => {
    expect(tileDefinition('copy')).toMatchObject({ title: 'Trade copier', singleton: true });
  });
});
