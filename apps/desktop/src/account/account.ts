import type { AccountPhase, AccountState } from '@tessera/protocol';
import { useState } from 'react';
import { openExternal } from '../app/host.ts';
import { useServer } from '../app/runtimeContext.ts';
import { useStore, type Readable } from '../app/store.ts';
import { runTool } from '../app/tools.ts';
import { topicLatest } from '../app/topics.ts';

export const accountStore = topicLatest('account', {});

const NO_ACCOUNT: Readable<AccountState | null> = { getState: () => null, subscribe: () => () => undefined };

export function useAccount(offered = true): AccountState | null {
  return useStore(offered ? accountStore : NO_ACCOUNT);
}

export type AccountGate = 'wait' | 'open' | 'sign-in' | 'unreadable' | 'waitlist' | 'declined';

export function accountGate(offered: boolean, state: AccountState | null): AccountGate {
  if (!offered) return 'open';
  if (state === null) return 'wait';
  switch (state.phase) {
    case 'off':
      return 'open';
    case 'loading':
      return 'wait';
    case 'unreadable':
      return 'unreadable';
    case 'signed_out':
      return 'sign-in';
    case 'signed_in':
      break;
  }
  if (state.access === 'full') return 'open';
  if (state.checking) return 'wait';
  return state.access === 'declined' ? 'declined' : 'waitlist';
}

function useAccountTopic(): boolean | null {
  const server = useServer();
  const now = server ? server.capabilities.topics.includes('account') : null;
  const [seen, setSeen] = useState(now === true);
  if (now === true && !seen) setSeen(true);
  return seen || now;
}

export function useAccountGate(): AccountGate {
  const offered = useAccountTopic() === true;
  return accountGate(offered, useAccount(offered));
}

export function accountsOn(topic: boolean | null, state: AccountState | null): boolean | null {
  if (topic !== true) return topic;
  return state === null ? null : state.phase !== 'off';
}

export function useAccountsOn(): boolean | null {
  const topic = useAccountTopic();
  return accountsOn(topic, useAccount(topic === true));
}

export function gateWords(
  gate: Exclude<AccountGate, 'wait' | 'open'>,
  state: AccountState | null,
): { say: string; line: string; note: string | null } {
  const email = state?.user?.email ?? 'This account';
  const note =
    state?.problem ??
    (state?.offline && gate !== 'sign-in' ? 'Tessera Cloud can’t be reached. This is the last word it gave.' : null);
  if (gate === 'sign-in')
    return state?.signingIn
      ? { say: 'Finish in your browser', line: 'Sign in there, then come back. Tessera opens by itself.', note }
      : { say: 'Sign in to Tessera', line: 'Tessera opens your browser to sign in.', note };
  if (gate === 'unreadable')
    return {
      say: 'Your sign-in is saved',
      line: 'Tessera couldn’t read it from the OS keyring. Allow Tessera when the keyring asks, then try again.',
      note,
    };
  if (gate === 'declined') return { say: 'Not in the alpha', line: `${email} was not accepted into the alpha.`, note };
  return state?.access === 'none'
    ? { say: 'Not in the alpha yet', line: `${email} has no alpha access yet.`, note }
    : { say: 'You’re on the list', line: `Signed in as ${email}. Tessera opens once your access is ready.`, note };
}

export function privacyWords(phase: AccountPhase): string {
  const analyst = 'The analyst reads through the provider you connect, on your own subscription.';
  if (phase === 'off') return `This build has no account. ${analyst}`;
  return (
    'Your Tessera account holds your email and name from the sign-in and your alpha access; each ' +
    `launch tells it the app’s version, platform and channel. Nothing about your trading. ${analyst}`
  );
}

export async function signIn(): Promise<void> {
  const { url } = await runTool('account.sign_in', {});
  await openExternal(url);
}

export async function signOut(): Promise<void> {
  await runTool('account.sign_out', {});
}

export async function checkAgain(): Promise<void> {
  await runTool('account.status', { check: true });
}
