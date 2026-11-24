import type { AccountState, ConnectionState, HelloResult } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { LEGAL_UPDATED, LEGAL_VERSION } from '@tessera/ui/legal';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsOn } from '../src/account/account.ts';
import { termsStore } from '../src/account/terms.ts';
import { read, write } from '../src/app/store.ts';
import { AreaRail } from '../src/areas/AreaRail.tsx';
import { useNoProfileWithoutAccounts, useProfileCommand } from '../src/areas/profile/hooks.ts';
import { accessHelp, entryLook, initialOf, profileView, whoOf } from '../src/areas/profile/model.ts';
import { ProfilePage } from '../src/areas/profile/ProfilePage.tsx';
import { areaStore } from '../src/areas/store.ts';
import { commands } from '../src/commands/registry.ts';
import { actPause } from './support/pause.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';

const NOW = 1_800_000_000_000;

const state = (over: Partial<AccountState> = {}): AccountState => ({
  phase: 'signed_in',
  user: { email: 'trader@example.test', name: 'Robin Vale' },
  access: 'full',
  entitlements: ['early_access'],
  verifiedAt: NOW * 1_000_000,
  checking: false,
  offline: false,
  signingIn: false,
  problem: null,
  ...over,
});
const OUT = state({ phase: 'signed_out', user: null, access: null, entitlements: [], verifiedAt: null });

describe('the Profile’s model', () => {
  it('has accounts only with the runtime’s topic and a Cloud address, and says so only once both are known', () => {
    expect(accountsOn(null, null)).toBeNull();
    expect(accountsOn(false, null)).toBe(false);
    expect(accountsOn(false, state())).toBe(false);
    expect(accountsOn(true, null)).toBeNull();
    expect(accountsOn(true, state({ phase: 'off', user: null, access: null }))).toBe(false);
    expect(accountsOn(true, state({ phase: 'loading', user: null, access: null }))).toBe(true);
    expect(accountsOn(true, OUT)).toBe(true);
    expect(accountsOn(true, state())).toBe(true);
  });

  it('names the person by their name, else their email, and draws their initial', () => {
    expect(whoOf({ email: 'trader@example.test', name: 'Robin Vale' })).toEqual({
      name: 'Robin Vale',
      email: 'trader@example.test',
    });
    expect(whoOf({ email: 'trader@example.test', name: '  ' })).toEqual({ name: 'trader@example.test', email: null });
    expect(initialOf({ email: 'trader@example.test', name: 'robin vale' })).toBe('R');
    expect(initialOf({ email: 'émile@example.test', name: null })).toBe('É');
    expect(initialOf(null)).toBeNull();
  });

  it('gives the rail’s entry their tile and says who in its tooltip', () => {
    expect(entryLook(state())).toEqual({ initial: 'R', words: 'Profile · Robin Vale' });
    expect(entryLook(state({ user: { email: 'trader@example.test', name: null } }))).toEqual({
      initial: 'T',
      words: 'Profile · trader@example.test',
    });
    expect(entryLook(OUT)).toEqual({ initial: null, words: 'Profile · Not signed in' });
    expect(entryLook(null)).toEqual({ initial: null, words: 'Profile' });
  });

  it('shows nothing until the account is known, then who they are or the sign-in', () => {
    expect(profileView(null, NOW)).toEqual({ kind: 'wait' });
    expect(profileView(state({ phase: 'loading', user: null, access: null }), NOW)).toEqual({ kind: 'wait' });
    expect(profileView(OUT, NOW)).toMatchObject({ kind: 'signed-out', say: 'Sign in to Tessera', action: 'Sign in' });
    expect(profileView({ ...OUT, signingIn: true, problem: 'The sign-in was refused. Try again.' }, NOW)).toEqual({
      kind: 'signed-out',
      say: 'Finish in your browser',
      line: 'Sign in there, then come back here.',
      action: 'Open the browser again',
      note: 'The sign-in was refused. Try again.',
    });
    expect(profileView(state(), NOW)).toEqual({
      kind: 'signed-in',
      initial: 'R',
      name: 'Robin Vale',
      email: 'trader@example.test',
      access: { word: 'Alpha', help: undefined, checkAgain: false, checking: false },
    });
  });

  it('says their access in a word, and offers Check again only while the alpha is not open to them or Cloud is out of reach', () => {
    const access = (over: Partial<AccountState>) => {
      const v = profileView(state(over), NOW + 2 * 3_600_000);
      return v.kind === 'signed-in' ? v.access : null;
    };
    expect(access({ access: 'pending' })).toMatchObject({ word: 'On the list', checkAgain: true });
    expect(access({ access: 'none' })).toMatchObject({ word: 'Not in the alpha', checkAgain: true });
    expect(access({ access: 'declined' })).toMatchObject({ word: 'Declined', checkAgain: false });
    expect(access({ offline: true })).toEqual({
      word: 'Alpha',
      help: 'Tessera Cloud can’t be reached. It said this 2h ago',
      checkAgain: true,
      checking: false,
    });
    expect(access({ access: 'pending', checking: true })).toMatchObject({
      help: 'Asking Tessera Cloud',
      checking: true,
    });
  });

  it('adds to the access row only that Cloud is asked or cannot be reached', () => {
    const now = NOW + 2 * 3_600_000;
    expect(accessHelp(state(), now)).toBeUndefined();
    expect(accessHelp(state({ offline: true, verifiedAt: null }), now)).toBe('Tessera Cloud can’t be reached');
    expect(accessHelp(state({ offline: true }), now)).toBe('Tessera Cloud can’t be reached. It said this 2h ago');
  });
});

describe('the Profile in the window', () => {
  const connected = (topics: string[] | null): ConnectionState => ({
    status: 'open',
    attempt: 0,
    everConnected: true,
    server: topics ? ({ capabilities: { topics } } as unknown as HelloResult) : null,
    lastError: null,
    lastErrorCode: null,
    nextRetryAt: null,
    connectedAt: 1,
    endpoint: null,
  });

  function runtime(topics: string[] | null = ['account'], fail: Record<string, string> = {}) {
    let say: ((data: AccountState) => void) | null = null;
    const calls: { name: string; input: unknown }[] = [];
    const opened: string[] = [];
    const conn = connected(topics);
    const client: FakeClient = {
      state: { getSnapshot: () => conn, subscribe: () => () => undefined },
      subscribe: (topic, _params, handler) => {
        if (topic === 'account') say = (data) => handler(data, { topic, seq: 0, subscriptionId: 's' });
        return () => undefined;
      },
      request: (method, params: { name?: string; input?: unknown } | undefined) => {
        if (method !== 'tools.invoke' || !params?.name) return new Promise(() => undefined);
        calls.push({ name: params.name, input: params.input });
        const refusal = fail[params.name];
        if (refusal) return Promise.resolve({ ok: false, error: { message: refusal } });
        if (params.name === 'account.sign_in')
          return Promise.resolve({ ok: true, output: { url: 'https://account.example.test/auth/desktop/start?x' } });
        if (params.name === 'account.sign_out' || params.name === 'account.status')
          return Promise.resolve({ ok: true, output: params.name === 'account.status' ? state() : {} });
        return new Promise(() => undefined);
      },
    };
    const bridge = {
      openExternal: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    };
    const tell = (s: AccountState) =>
      act(async () => {
        if (!say) throw new Error('the account topic is not subscribed');
        say(s);
        await Promise.resolve();
      });
    return { client, bridge, calls, opened, tell };
  }

  function mount(r: ReturnType<typeof runtime>, children: ReactNode) {
    return render(
      <TestRuntime client={r.client} bridge={r.bridge}>
        <TooltipProvider>{children}</TooltipProvider>
      </TestRuntime>,
    );
  }

  beforeEach(() => {
    write(areaStore, { area: 'desk', previous: null });
  });
  afterEach(() => {
    cleanup();
  });

  it('puts the person’s tile under Feedback and Settings, with their initial, and opens the Profile from it', async () => {
    const r = runtime();
    const { container } = mount(r, <AreaRail />);
    await actPause();
    expect(container.querySelector('.ar-profile')).toBeNull();
    await r.tell(state());
    const foot = container.querySelector('.ar-rail-foot')!;
    expect(
      [...foot.children].map(
        (c) => c.getAttribute('data-area') ?? (c.hasAttribute('data-feedback-entry') ? 'feedback' : null),
      ),
    ).toEqual(['feedback', 'settings', 'profile']);
    const entry = within(foot as HTMLElement).getByRole('button', { name: 'Profile · Robin Vale' });
    expect(entry.querySelector('[data-size]')?.textContent).toBe('R');
    fireEvent.click(entry);
    expect(read(areaStore)).toMatchObject({ area: 'profile', previous: 'desk' });
    expect(entry.getAttribute('aria-current')).toBe('page');
    expect(entry.classList.contains('is-on')).toBe(true);
    await r.tell(OUT);
    const out = screen.getByRole('button', { name: 'Profile · Not signed in' });
    expect(out.querySelector('[data-size] > span')).toBeNull();
    expect(out.querySelector('[data-size] > svg')).not.toBeNull();
  });

  it('has no tile without accounts: a runtime without the topic, or with accounts off', async () => {
    const without = runtime([]);
    const a = mount(without, <AreaRail />);
    await actPause();
    expect(a.container.querySelector('.ar-profile')).toBeNull();
    expect(a.container.querySelector('.ar-rail-foot')?.textContent).toBe('FeedbackSettings');
    cleanup();
    const off = runtime();
    const b = mount(off, <AreaRail />);
    await actPause();
    await off.tell(state({ phase: 'off', user: null, access: null }));
    expect(b.container.querySelector('.ar-profile')).toBeNull();
    expect(b.container.querySelector('.ar-rail-foot')?.textContent).toBe('FeedbackSettings');
  });

  it('says who they are and their access, and signs out once confirmed', async () => {
    const r = runtime();
    mount(r, <ProfilePage />);
    await actPause();
    await r.tell(state());
    expect(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Robin Vale' })).toBeTruthy();
    expect(screen.getByText('trader@example.test')).toBeTruthy();
    const account = screen.getByRole('region', { name: 'Account' });
    const access = within(account).getByText('Alpha access').closest<HTMLElement>('.t-set-row')!;
    expect(access.querySelector('.pf-fact')?.textContent).toBe('Alpha');
    expect(within(access).queryByRole('button')).toBeNull();
    fireEvent.click(within(account).getByRole('button', { name: 'Sign out' }));
    const confirm = within(account).getByRole('group', { name: 'Confirm' });
    expect(confirm.textContent).toContain('Sign out of Tessera on this machine?');
    fireEvent.click(within(confirm).getByRole('button', { name: /^Sign out/ }));
    await vi.waitFor(() => expect(r.calls.map((c) => c.name)).toEqual(['account.sign_out']));
  });

  it('says which terms they accepted and when, and opens each page', async () => {
    write(termsStore, { accepted: LEGAL_VERSION, acceptedAt: Date.UTC(2026, 9, 26, 12) });
    const r = runtime();
    mount(r, <ProfilePage />);
    await actPause();
    await r.tell(state());
    const account = screen.getByRole('region', { name: 'Account' });
    const row = within(account).getByText('Terms').closest<HTMLElement>('.t-set-row')!;
    expect(row.textContent).toContain(`You accepted the terms of ${LEGAL_UPDATED} on 26 October 2026`);
    fireEvent.click(within(row).getByRole('button', { name: 'Privacy policy' }));
    await vi.waitFor(() => expect(r.opened).toEqual(['https://tesserachart.com/privacy']));
  });

  it('offers Check again while they are on the list, and none once declined', async () => {
    const r = runtime();
    mount(r, <ProfilePage />);
    await actPause();
    await r.tell(state({ access: 'pending', entitlements: [] }));
    const account = screen.getByRole('region', { name: 'Account' });
    expect(within(account).getByText('On the list')).toBeTruthy();
    fireEvent.click(within(account).getByRole('button', { name: 'Check again' }));
    await vi.waitFor(() => expect(r.calls).toEqual([{ name: 'account.status', input: { check: true } }]));
    await r.tell(state({ access: 'pending', entitlements: [], checking: true }));
    expect(within(account).getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true);
    await r.tell(state({ access: 'declined', entitlements: [] }));
    expect(within(account).getByText('Declined')).toBeTruthy();
    expect(within(account).queryByRole('button', { name: /Check/ })).toBeNull();
  });

  it('signed out, signs in through the browser', async () => {
    const r = runtime();
    mount(r, <ProfilePage />);
    await actPause();
    await r.tell(OUT);
    expect(screen.queryByRole('region', { name: 'Account' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Sign in to Tessera' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(r.opened).toEqual(['https://account.example.test/auth/desktop/start?x']));
    expect(r.calls.map((c) => c.name)).toEqual(['account.sign_in']);
    await r.tell({ ...OUT, signingIn: true });
    expect(screen.getByRole('heading', { level: 2, name: 'Finish in your browser' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the browser again' })).toBeTruthy();
  });

  it('says why an action failed on its own row', async () => {
    const r = runtime(['account'], { 'account.sign_out': 'Tessera Cloud can’t be reached' });
    mount(r, <ProfilePage />);
    await actPause();
    await r.tell(state());
    const account = screen.getByRole('region', { name: 'Account' });
    fireEvent.click(within(account).getByRole('button', { name: 'Sign out' }));
    fireEvent.click(
      within(within(account).getByRole('group', { name: 'Confirm' })).getByRole('button', { name: /^Sign out/ }),
    );
    const alert = await within(account).findByRole('alert');
    expect(alert.textContent).toContain('Tessera Cloud can’t be reached');
    expect(alert.closest('.t-set-row')?.textContent).toContain('Sign out');
  });

  it('shows nothing of a profile without accounts', async () => {
    const r = runtime();
    const { container } = mount(r, <ProfilePage />);
    await actPause();
    await r.tell(state({ phase: 'off', user: null, access: null }));
    expect(container.querySelector('.pf-col')?.childElementCount).toBe(0);
  });

  function Hooks() {
    useNoProfileWithoutAccounts();
    useProfileCommand();
    return null;
  }

  it('gives the Profile its key and ⌘K entry only while the build has accounts', async () => {
    const r = runtime();
    mount(r, <Hooks />);
    await actPause();
    expect(commands.get('area.profile')).toBeNull();
    await r.tell(state());
    expect(commands.get('area.profile')).toMatchObject({ title: 'Go to Profile', shortcut: 'alt+8' });
    act(() => {
      commands.run('area.profile');
    });
    expect(read(areaStore).area).toBe('profile');
    await r.tell(state({ phase: 'off', user: null, access: null }));
    expect(commands.get('area.profile')).toBeNull();
  });

  it('goes to the desk from a Profile a build without accounts was left on, once that is known', async () => {
    write(areaStore, { area: 'profile', previous: null });
    const early = runtime(null);
    mount(early, <Hooks />);
    await actPause();
    expect(read(areaStore).area).toBe('profile');
    cleanup();
    const without = runtime([]);
    mount(without, <Hooks />);
    await actPause();
    expect(read(areaStore).area).toBe('desk');
  });
});
