import type {
  AccountState,
  ConnectionState,
  HelloResult,
  ProviderHealth,
  TelemetryStatusOutput,
} from '@tessera/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_VERSION } from '@tessera/ui/legal';
import { accountGate, gateWords, privacyWords } from '../src/account/account.ts';
import { termsDue, termsStore } from '../src/account/terms.ts';
import { read, write } from '../src/app/store.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { Arrival } from '../src/shell/Arrival.tsx';
import { arrivalStore } from '../src/shell/arrival.ts';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import { actPause } from './support/pause.ts';
import { providerHealth } from './support/providers.ts';
import { seedTools, setTestServices, TestRuntime, type FakeClient } from './support/runtime.tsx';

const state = (over: Partial<AccountState> = {}): AccountState => ({
  phase: 'signed_in',
  user: { email: 'trader@example.test', name: null },
  access: 'full',
  entitlements: ['early_access'],
  verifiedAt: 1_800_000_000_000_000_000,
  checking: false,
  offline: false,
  signingIn: false,
  problem: null,
  ...over,
});

describe('the gate at arrival', () => {
  it('lets a build without accounts through, and waits while the account is not known', () => {
    expect(accountGate(false, null)).toBe('open');
    expect(accountGate(false, state({ phase: 'signed_out' }))).toBe('open');
    expect(accountGate(true, state({ phase: 'off', user: null, access: null }))).toBe('open');
    expect(accountGate(true, null)).toBe('wait');
    expect(accountGate(true, state({ phase: 'loading', user: null, access: null }))).toBe('wait');
  });

  it('says a kept sign-in the keychain did not give is still there, and never asks for it as if it were gone', () => {
    const unreadable = state({
      phase: 'unreadable',
      user: null,
      access: null,
      problem: 'The saved sign-in cannot be read: the OS keyring is not available.',
    });
    expect(accountGate(true, unreadable)).toBe('unreadable');
    const words = gateWords('unreadable', unreadable);
    expect(words.say).toBe('Your sign-in is saved');
    expect(words.line).toMatch(/try again/);
    expect(words.note).toBe(unreadable.problem);
  });

  it('asks to sign in when no one is', () => {
    expect(accountGate(true, state({ phase: 'signed_out', user: null, access: null }))).toBe('sign-in');
    expect(accountGate(true, state({ phase: 'signed_out', user: null, access: null, signingIn: true }))).toBe(
      'sign-in',
    );
  });

  it('opens on full access at once, even while Cloud is asked again or out of reach', () => {
    expect(accountGate(true, state())).toBe('open');
    expect(accountGate(true, state({ checking: true }))).toBe('open');
    expect(accountGate(true, state({ offline: true }))).toBe('open');
  });

  it('says where any other access stands, once Cloud has answered at start', () => {
    expect(accountGate(true, state({ access: 'pending', checking: true }))).toBe('wait');
    expect(accountGate(true, state({ access: 'pending' }))).toBe('waitlist');
    expect(accountGate(true, state({ access: 'none' }))).toBe('waitlist');
    expect(accountGate(true, state({ access: 'declined' }))).toBe('declined');
    expect(accountGate(true, state({ access: 'pending', offline: true }))).toBe('waitlist');
  });

  it('says each screen plainly', () => {
    expect(gateWords('sign-in', state({ phase: 'signed_out', user: null, access: null })).say).toBe(
      'Sign in to Tessera',
    );
    expect(gateWords('sign-in', state({ phase: 'signed_out', signingIn: true })).say).toBe('Finish in your browser');
    const pending = gateWords('waitlist', state({ access: 'pending' }));
    expect(pending.say).toBe('You’re on the list');
    expect(pending.line).toContain('trader@example.test');
    expect(pending.note).toBeNull();
    expect(gateWords('waitlist', state({ access: 'none' })).say).toBe('Not in the alpha yet');
    expect(gateWords('declined', state({ access: 'declined' })).say).toBe('Not in the alpha');
    expect(gateWords('waitlist', state({ access: 'pending', offline: true })).note).toMatch(/can’t be reached/);
    expect(
      gateWords('sign-in', state({ phase: 'signed_out', problem: 'The sign-in was refused. Try again.' })).note,
    ).toBe('The sign-in was refused. Try again.');
  });

  it('says what leaves the machine, with and without accounts', () => {
    expect(privacyWords('off')).toMatch(/^This build has no account\./);
    const on = privacyWords('signed_in');
    expect(on).toMatch(/email and name/);
    expect(on).toMatch(/version, platform and channel/);
    expect(on).not.toMatch(/no account/);
    expect(`${privacyWords('off')} ${on}`).not.toMatch(/analytics/i);
  });
});

describe('the terms at arrival', () => {
  it('asks for the terms only where there are accounts, and again when they change', () => {
    expect(termsDue(null, null)).toBe(false);
    expect(termsDue(false, null)).toBe(false);
    expect(termsDue(true, null)).toBe(true);
    expect(termsDue(true, '2026-01-01')).toBe(true);
    expect(termsDue(true, LEGAL_VERSION)).toBe(false);
  });
});

describe('the window’s arrival with accounts', () => {
  const RUNTIME = providerHealth({ providerId: 'runtime', kind: 'runtime' });
  const APEX: ProviderHealth = { ...RUNTIME, providerId: 'rithmic-apex', kind: 'market_data' };

  const connected = (topics: string[]): ConnectionState => ({
    status: 'open',
    attempt: 0,
    everConnected: true,
    server: { capabilities: { topics } } as unknown as HelloResult,
    lastError: null,
    lastErrorCode: null,
    nextRetryAt: null,
    connectedAt: 1,
    endpoint: null,
  });

  function runtime(topics = ['account'], telemetry: TelemetryStatusOutput | null = null) {
    let say: ((data: AccountState) => void) | null = null;
    const calls: string[] = [];
    const sets: { key: string; value: unknown }[] = [];
    const conn = connected(topics);
    const client: FakeClient = {
      state: { getSnapshot: () => conn, subscribe: () => () => undefined },
      subscribe: (topic, _params, handler) => {
        if (topic === 'account') say = (data) => handler(data, { topic, seq: 0, subscriptionId: 's' });
        return () => undefined;
      },
      request: (method, params: { name?: string; input?: { key: string; value: unknown } } | undefined) => {
        if (method !== 'tools.invoke' || !params?.name) return new Promise(() => undefined);
        calls.push(params.name);
        if (params.name === 'telemetry.status' && telemetry) return Promise.resolve({ ok: true, output: telemetry });
        if (params.name === 'settings.set' && params.input) {
          sets.push(params.input);
          return Promise.resolve({ ok: true, output: { ...params.input, previous: null } });
        }
        if (params.name === 'account.sign_in')
          return Promise.resolve({ ok: true, output: { url: 'https://account.example.test/auth/desktop/start?x' } });
        if (params.name === 'connections.list')
          return Promise.resolve({ ok: true, output: { connections: [], dataSource: 'rithmic-apex' } });
        return new Promise(() => undefined);
      },
    };
    const opened: string[] = [];
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
    return { client, bridge, calls, sets, opened, tell, telemetry };
  }

  function arrive(r: ReturnType<typeof runtime>) {
    setTestServices(r.client, r.bridge);
    seedTools(['connections.list', ...(r.telemetry ? ['telemetry.status', 'settings.set'] : [])]);
    return render(
      <TestRuntime client={r.client} bridge={r.bridge}>
        <ShellDataContext.Provider value={{ ...EMPTY_SHELL_DATA, providers: [RUNTIME, APEX] }}>
          <Arrival />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
  }

  beforeEach(() => {
    write(arrivalStore, { shown: false, onboarding: false, arrived: false });
    write(termsStore, { accepted: LEGAL_VERSION, acceptedAt: 1 });
    putRuntimeSettings({}, true);
  });
  afterEach(() => {
    cleanup();
  });

  it('asks to sign in, opens the browser, and goes on once the alpha is open to them', async () => {
    const r = runtime();
    arrive(r);
    await actPause();
    expect(screen.queryByRole('dialog')).toBeNull();
    await r.tell(state({ phase: 'signed_out', user: null, access: null, entitlements: [] }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to Tessera' });
    expect(read(arrivalStore).onboarding).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(r.opened).toEqual(['https://account.example.test/auth/desktop/start?x']));
    expect(r.calls).toContain('account.sign_in');
    await r.tell(state({ phase: 'signed_out', user: null, access: null, signingIn: true }));
    expect(await screen.findByRole('dialog', { name: 'Finish in your browser' })).toBeTruthy();

    await r.tell(state({ access: 'pending', entitlements: [] }));
    const list = await screen.findByRole('dialog', { name: 'You’re on the list' });
    expect(within(list).getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(within(list).getByRole('button', { name: 'Sign out' })).toBeTruthy();

    await r.tell(state());
    await actPause();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(read(arrivalStore).onboarding).toBe(false);
    expect(document.querySelector('.t-sh-splash.is-exit')).not.toBeNull();

    await r.tell(state({ phase: 'signed_out', user: null, access: null }));
    await actPause();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says a declined application plainly, with only Sign out', async () => {
    const r = runtime();
    arrive(r);
    await actPause();
    await r.tell(state({ access: 'declined', entitlements: [] }));
    const dialog = await screen.findByRole('dialog', { name: 'Not in the alpha' });
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Sign out']);
  });

  it('asks for the terms first, links each page, and goes on to sign in once they are accepted', async () => {
    write(termsStore, { accepted: null, acceptedAt: null });
    const r = runtime();
    arrive(r);
    await actPause();
    await r.tell(state({ phase: 'signed_out', user: null, access: null, entitlements: [] }));
    const terms = await screen.findByRole('dialog', { name: 'Before you start' });
    expect(read(arrivalStore).onboarding).toBe(true);
    expect(within(terms).getByText(/not financial advice/)).toBeTruthy();
    fireEvent.click(within(terms).getByRole('button', { name: 'Terms of service' }));
    fireEvent.click(within(terms).getByRole('button', { name: 'Risk disclaimer' }));
    await vi.waitFor(() =>
      expect(r.opened).toEqual(['https://tesserachart.com/terms', 'https://tesserachart.com/risk']),
    );
    expect(read(termsStore).accepted).toBeNull();
    fireEvent.click(within(terms).getByRole('button', { name: 'Accept' }));
    expect(read(termsStore).accepted).toBe(LEGAL_VERSION);
    expect(await screen.findByRole('dialog', { name: 'Sign in to Tessera' })).toBeTruthy();
  });

  it('asks again when the terms changed, even with full access, and opens once they are accepted', async () => {
    write(termsStore, { accepted: '2026-01-01', acceptedAt: 1 });
    const r = runtime();
    arrive(r);
    await actPause();
    await r.tell(state());
    const terms = await screen.findByRole('dialog', { name: 'The terms have changed' });
    fireEvent.click(within(terms).getByRole('button', { name: 'Accept' }));
    await actPause();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(read(termsStore).accepted).toBe(LEGAL_VERSION);
    expect(document.querySelector('.t-sh-splash.is-exit')).not.toBeNull();
  });

  it('asks nothing of a runtime without accounts', async () => {
    write(termsStore, { accepted: null, acceptedAt: null });
    const r = runtime([]);
    arrive(r);
    await actPause();
    await actPause();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(r.calls).not.toContain('account.sign_in');
    expect(document.querySelector('.t-sh-splash.is-exit')).not.toBeNull();
  });

  const PROJECT: TelemetryStatusOutput = { available: true };

  const FRESH = { crashes: true, usage: null };

  it('asks to share usage analytics once, nothing chosen, and mentions crash reports, in a build with a project and no accounts', async () => {
    putRuntimeSettings({ 'telemetry.consent': FRESH }, true);
    const r = runtime([], PROJECT);
    arrive(r);
    const ask = await screen.findByRole('dialog', { name: 'One question before you go on' });
    expect(within(ask).getByRole('button', { name: 'Privacy policy' })).toBeTruthy();
    const question = within(ask).getByRole('radiogroup', { name: 'Share usage analytics' });
    expect(
      within(question)
        .getAllByRole('radio')
        .map((o) => [o.textContent, o.getAttribute('aria-checked')]),
    ).toEqual([
      ['Yes', 'false'],
      ['No', 'false'],
    ]);
    expect(within(ask).getByText(/Never credentials, account ids, prices, sizes, P&L or prompts/)).toBeTruthy();
    expect(
      within(ask).getByText('Tessera sends anonymous crash reports. Turn them off in Settings › App › Privacy.'),
    ).toBeTruthy();
    const waits = within(ask).getByRole<HTMLButtonElement>('button', { name: 'Continue' });
    expect(waits.disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Tab' });
    act(() => waits.parentElement!.focus());
    expect((await screen.findByRole('tooltip')).textContent).toBe('Choose Yes or No to share usage analytics first.');
    fireEvent.click(waits);
    await actPause();
    expect(r.sets).toEqual([]);
    fireEvent.click(within(question).getByRole('radio', { name: 'Yes' }));
    const go = within(ask).getByRole<HTMLButtonElement>('button', { name: 'Continue' });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await actPause();
    expect(r.sets).toEqual([{ key: 'telemetry.consent', value: { crashes: true, usage: true } }]);
    act(() => putRuntimeSettings({ 'telemetry.consent': { crashes: true, usage: true } }, false));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(read(termsStore).acceptedAt).toBe(1);
    expect(document.querySelector('.t-sh-splash.is-exit')).not.toBeNull();
  });

  it('No is an answer of its own and keeps crash reports as they are', async () => {
    putRuntimeSettings({ 'telemetry.consent': { crashes: false, usage: null } }, true);
    const r = runtime([], PROJECT);
    arrive(r);
    const ask = await screen.findByRole('dialog', { name: 'One question before you go on' });
    expect(within(ask).queryByText(/anonymous crash reports/)).toBeNull();
    fireEvent.click(within(ask).getByRole('radio', { name: 'No' }));
    fireEvent.click(within(ask).getByRole('button', { name: 'Continue' }));
    await actPause();
    expect(r.sets).toEqual([{ key: 'telemetry.consent', value: { crashes: false, usage: false } }]);
  });

  it('asks it with the terms on the first run, and Accept waits for the answer, then keeps both', async () => {
    write(termsStore, { accepted: null, acceptedAt: null });
    putRuntimeSettings({ 'telemetry.consent': FRESH }, true);
    const r = runtime(['account'], PROJECT);
    arrive(r);
    await actPause();
    await r.tell(state({ phase: 'signed_out', user: null, access: null, entitlements: [] }));
    const terms = await screen.findByRole('dialog', { name: 'Before you start' });
    const yes = within(terms).getByRole('radio', { name: 'Yes' });
    expect(yes.getAttribute('aria-checked')).toBe('false');
    const accept = within(terms).getByRole<HTMLButtonElement>('button', { name: 'Accept' });
    expect(accept.disabled).toBe(true);
    fireEvent.click(accept);
    expect(read(termsStore).accepted).toBeNull();
    fireEvent.click(yes);
    fireEvent.click(within(terms).getByRole('button', { name: 'Accept' }));
    expect(read(termsStore).accepted).toBe(LEGAL_VERSION);
    await vi.waitFor(() =>
      expect(r.sets).toEqual([{ key: 'telemetry.consent', value: { crashes: true, usage: true } }]),
    );
    act(() => putRuntimeSettings({ 'telemetry.consent': { crashes: true, usage: true } }, false));
    expect(await screen.findByRole('dialog', { name: 'Sign in to Tessera' })).toBeTruthy();
  });

  it('asks nothing once it is answered, or in a build without a project', async () => {
    const cases: [TelemetryStatusOutput, boolean | null][] = [
      [PROJECT, true],
      [PROJECT, false],
      [{ available: false }, null],
    ];
    for (const [status, usage] of cases) {
      write(arrivalStore, { shown: false, onboarding: false, arrived: false });
      putRuntimeSettings({ 'telemetry.consent': { crashes: true, usage } }, true);
      const r = runtime([], status);
      arrive(r);
      await actPause();
      await actPause();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.querySelector('.t-sh-splash.is-exit')).not.toBeNull();
      expect(r.sets).toEqual([]);
      cleanup();
    }
  });
});
