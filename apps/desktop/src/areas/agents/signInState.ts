import type { AgentSignInPage } from '@tessera/protocol';
import { useState } from 'react';
import { openExternal } from '../../app/host.ts';
import { sendSignInCode, startSignIn } from './providers.ts';

export function signInLine(s: SignInState): string | null {
  if (s.code) return 'Paste the code the page ended on.';
  return s.page ? 'Finish signing in in your browser; it connects here by itself.' : null;
}

export interface SignInState {
  id: string;
  name: string;
  page: AgentSignInPage | null;
  busy: boolean;
  code: boolean;
  start: () => void;
  reopen: () => void;
  send: (code: string) => void;
}

export function useSignIn(id: string, name: string, onError: (why: string | null) => void): SignInState {
  const [page, setPage] = useState<AgentSignInPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(false);
  const attempt = (work: () => Promise<void>) => {
    setBusy(true);
    onError(null);
    work()
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  return {
    id,
    name,
    page,
    busy,
    code,
    start: () =>
      attempt(async () => {
        setCode(false);
        setPage(await startSignIn(id));
      }),
    reopen: () => {
      if (!page) return;
      // the CLI's own fallback page ends on a code to paste back, for a browser that did not hand the sign-in back
      if (page.takesCode) setCode(true);
      void openExternal(page.url).catch(() => undefined);
    },
    send: (text) =>
      attempt(async () => {
        await sendSignInCode(id, text);
        setPage(null);
        setCode(false);
      }),
  };
}
