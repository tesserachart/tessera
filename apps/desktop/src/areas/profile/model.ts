import type { AccountAccess, AccountState, AccountUser } from '@tessera/protocol';
import { ago } from '../settings/agentClients.ts';

export function initialOf(user: AccountUser | null): string | null {
  if (!user) return null;
  const first = Array.from(whoOf(user).name.trim())[0];
  return first ? first.toLocaleUpperCase() : null;
}

export function whoOf(user: AccountUser): { name: string; email: string | null } {
  const name = user.name?.trim();
  return name ? { name, email: user.email } : { name: user.email, email: null };
}

export function entryLook(state: AccountState | null): { initial: string | null; words: string } {
  const user = state?.phase === 'signed_in' ? state.user : null;
  if (user) return { initial: initialOf(user), words: `Profile · ${whoOf(user).name}` };
  return { initial: null, words: state?.phase === 'signed_out' ? 'Profile · Not signed in' : 'Profile' };
}

const ACCESS_WORD: Record<AccountAccess, string> = {
  full: 'Alpha',
  pending: 'On the list',
  declined: 'Declined',
  none: 'Not in the alpha',
};

export function accessHelp(state: AccountState, nowMs: number): string | undefined {
  if (state.checking) return 'Asking Tessera Cloud';
  if (!state.offline) return undefined;
  return state.verifiedAt === null
    ? 'Tessera Cloud can’t be reached'
    : `Tessera Cloud can’t be reached. It said this ${ago(state.verifiedAt, nowMs)}`;
}

interface AccessView {
  word: string;
  help: string | undefined;
  checkAgain: boolean;
  checking: boolean;
}

export type ProfileView =
  | { kind: 'wait' }
  | { kind: 'signed-out'; say: string; line: string; action: string; note: string | null }
  | {
      kind: 'signed-in';
      initial: string | null;
      name: string;
      email: string | null;
      access: AccessView | null;
    };

export function profileView(state: AccountState | null, nowMs: number): ProfileView {
  if (state === null || state.phase === 'off' || state.phase === 'loading') return { kind: 'wait' };
  if (state.phase === 'signed_out')
    return state.signingIn
      ? {
          kind: 'signed-out',
          say: 'Finish in your browser',
          line: 'Sign in there, then come back here.',
          action: 'Open the browser again',
          note: state.problem,
        }
      : {
          kind: 'signed-out',
          say: 'Sign in to Tessera',
          line: 'Tessera opens your browser to sign in.',
          action: 'Sign in',
          note: state.problem,
        };
  if (!state.user) return { kind: 'wait' };
  const access: AccessView | null = state.access
    ? {
        word: ACCESS_WORD[state.access],
        help: accessHelp(state, nowMs) ?? state.problem ?? undefined,
        checkAgain: state.access === 'pending' || state.access === 'none' || state.offline,
        checking: state.checking,
      }
    : null;
  return { kind: 'signed-in', initial: initialOf(state.user), ...whoOf(state.user), access };
}
