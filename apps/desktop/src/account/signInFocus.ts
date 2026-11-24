import type { AccountState } from '@tessera/protocol';
import { useEffect } from 'react';
import { runControl, useWindowControls } from '../app/host.ts';
import { useServer } from '../app/runtimeContext.ts';
import type { Readable } from '../app/store.ts';
import { accountStore } from './account.ts';

export function signInFinished(from: AccountState, now: AccountState): boolean {
  if (now.signingIn || now.phase !== 'signed_in' || now.problem !== null) return false;
  return from.phase !== 'signed_in' || now.verifiedAt !== from.verifiedAt;
}

export function watchSignIn(account: Readable<AccountState | null>, comeForward: () => void): () => void {
  let from: AccountState | null = null;
  const see = () => {
    const now = account.getState();
    if (now === null) return;
    if (now.signingIn) {
      from ??= now;
      return;
    }
    if (from !== null && signInFinished(from, now)) comeForward();
    from = null;
  };
  const stop = account.subscribe(see);
  see();
  return stop;
}

export function useSignInFocus(): void {
  const controls = useWindowControls();
  const offered = useServer()?.capabilities.topics.includes('account') ?? false;
  useEffect(() => {
    if (!controls || !offered) return undefined;
    return watchSignIn(accountStore, () => runControl(controls.focus));
  }, [controls, offered]);
}
