import type { WindowControls } from '@tessera/bridge';
import type { AccountState, ConnectionState, HelloResult } from '@tessera/protocol';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInFinished, useSignInFocus, watchSignIn } from '../src/account/signInFocus.ts';
import { makeStore, write, type Readable } from '../src/app/store.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';

const OLD = 1_800_000_000_000_000_000;
const NEW = OLD + 60_000_000_000;

const state = (over: Partial<AccountState> = {}): AccountState => ({
  phase: 'signed_in',
  user: { email: 'trader@example.test', name: null },
  access: 'full',
  entitlements: ['early_access'],
  verifiedAt: OLD,
  checking: false,
  offline: false,
  signingIn: false,
  problem: null,
  ...over,
});

const signedOut = (over: Partial<AccountState> = {}) =>
  state({ phase: 'signed_out', user: null, access: null, entitlements: [], verifiedAt: null, ...over });

function watched(first: AccountState | null = null) {
  const store = makeStore<{ s: AccountState | null }>({ s: first });
  const account: Readable<AccountState | null> = {
    getState: () => store.getState().s,
    subscribe: (listener) => store.subscribe((now, before) => listener(now.s, before.s)),
  };
  const forward = vi.fn();
  const stop = watchSignIn(account, forward);
  const say = (...states: AccountState[]) => {
    for (const s of states) write(store, { s });
  };
  return { say, forward, stop };
}

describe('the window comes forward once a sign-in finishes, and only then', () => {
  it.each<[string, AccountState | null, AccountState[], 0 | 1]>([
    [
      'the runtime says it step by step',
      signedOut(),
      [
        signedOut({ signingIn: true }),
        state({ access: 'pending', entitlements: [], verifiedAt: NEW, signingIn: true }),
        state({ access: 'pending', entitlements: [], verifiedAt: NEW }),
      ],
      1,
    ],
    [
      'later checks of a finished sign-in',
      state({ access: 'pending', entitlements: [], verifiedAt: NEW }),
      [state({ verifiedAt: NEW + 1 }), state({ verifiedAt: NEW + 2, checking: true })],
      0,
    ],
    ['the runtime’s word comes as one change', signedOut({ signingIn: true }), [state({ verifiedAt: NEW })], 1],
    ['signing in again over a session they had', state(), [state({ signingIn: true }), state({ verifiedAt: NEW })], 1],
    [
      'the sign-in is cancelled or fails',
      signedOut(),
      [
        signedOut({ signingIn: true }),
        signedOut({ problem: 'Sign-in was cancelled in the browser.' }),
        signedOut({ signingIn: true }),
        signedOut({ problem: 'Tessera Cloud didn’t accept the sign-in. Try again.' }),
      ],
      0,
    ],
    ['a sign-in over their session runs out its ten minutes', state(), [state({ signingIn: true }), state()], 0],
    [
      'the session is restored at start, with no sign-in',
      null,
      [state({ phase: 'loading', user: null, access: null }), state({ checking: true }), state({ verifiedAt: NEW })],
      0,
    ],
  ])('when %s', (_, first, said, times) => {
    const w = watched(first);
    w.say(...said);
    expect(w.forward).toHaveBeenCalledTimes(times);
  });

  it('stops watching when told', () => {
    const w = watched(signedOut({ signingIn: true }));
    w.stop();
    w.say(state({ verifiedAt: NEW }));
    expect(w.forward).not.toHaveBeenCalled();
  });

  it.each<[AccountState, AccountState, boolean]>([
    [signedOut({ signingIn: true }), state(), true],
    [signedOut({ signingIn: true }), state({ signingIn: true }), false],
    [signedOut({ signingIn: true }), signedOut(), false],
    [signedOut({ signingIn: true }), state({ problem: 'x' }), false],
    [state({ signingIn: true }), state(), false],
    [state({ signingIn: true }), state({ verifiedAt: NEW }), true],
  ])('as the rule reads, case %#', (before, now, finished) => {
    expect(signInFinished(before, now)).toBe(finished);
  });
});

describe('the window’s watch', () => {
  function mount(withWindow: boolean) {
    let say: ((data: AccountState) => void) | null = null;
    const topics: string[] = [];
    const conn: ConnectionState = {
      status: 'open',
      attempt: 0,
      everConnected: true,
      server: { capabilities: { topics: ['account'] } } as unknown as HelloResult,
      lastError: null,
      lastErrorCode: null,
      nextRetryAt: null,
      connectedAt: 1,
      endpoint: null,
    };
    const client: FakeClient = {
      state: { getSnapshot: () => conn, subscribe: () => () => undefined },
      subscribe: (topic, _params, handler) => {
        topics.push(topic);
        if (topic === 'account') say = (data) => handler(data, { topic, seq: 0, subscriptionId: 's' });
        return () => undefined;
      },
    };
    const focus = vi.fn(() => Promise.resolve());
    const controls: WindowControls = {
      trafficLights: false,
      minimize: () => Promise.resolve(),
      toggleMaximize: () => Promise.resolve(),
      toggleFullscreen: () => Promise.resolve(),
      close: () => Promise.resolve(),
      startDragging: () => Promise.resolve(),
      isMaximized: () => Promise.resolve(false),
      onResized: () => () => undefined,
      focus,
      setAppearance: () => Promise.resolve(),
    };
    const bridge = withWindow ? { kind: 'tauri' as const, window: controls } : { kind: 'browser' as const };
    function Probe() {
      useSignInFocus();
      return null;
    }
    render(
      <TestRuntime client={client} bridge={bridge}>
        <Probe />
      </TestRuntime>,
    );
    const tell = (s: AccountState) =>
      act(async () => {
        if (!say) throw new Error('the account topic is not subscribed');
        say(s);
        await Promise.resolve();
      });
    return { tell, focus, topics };
  }

  afterEach(() => {
    cleanup();
  });

  it('watches nothing in a browser tab, which cannot come forward', () => {
    const w = mount(false);
    expect(w.topics).not.toContain('account');
  });

  it('brings the desktop window forward when the browser’s sign-in finishes', async () => {
    const w = mount(true);
    await w.tell(signedOut());
    await w.tell(signedOut({ signingIn: true }));
    expect(w.focus).not.toHaveBeenCalled();
    await w.tell(state({ access: 'pending', entitlements: [], verifiedAt: NEW }));
    expect(w.focus).toHaveBeenCalledOnce();
  });
});
