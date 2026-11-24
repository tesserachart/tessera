import { LEGAL_UPDATED, LEGAL_VERSION, SITE_URL } from '@tessera/ui/legal';
import { z } from 'zod';
import { openExternal } from '../app/host.ts';
import { makeStore, patch, useStore } from '../app/store.ts';
import { useAccountsOn } from './account.ts';
import { displayZone } from '../state/timeZone.ts';

interface TermsState {
  accepted: string | null;
  acceptedAt: number | null;
}

export const termsStore = makeStore<TermsState>(
  { accepted: null, acceptedAt: null },
  {
    persist: {
      key: 'tessera.terms',
      version: 1,
      fields: { accepted: z.string().nullable(), acceptedAt: z.number().nullable() },
    },
  },
);

export function termsDue(accountsOn: boolean | null, accepted: string | null): boolean {
  return accountsOn === true && accepted !== LEGAL_VERSION;
}

export function useTermsDue(): boolean {
  return termsDue(
    useAccountsOn(),
    useStore(termsStore, (s) => s.accepted),
  );
}

export function useTermsAccepted(): TermsState {
  return useStore(termsStore);
}

export function acceptTerms(at: number = Date.now()): void {
  patch(termsStore, { accepted: LEGAL_VERSION, acceptedAt: at });
}

export function termsWords(firstRun: boolean, termsDue: boolean): { say: string; line: string } {
  if (!termsDue)
    return {
      say: 'One question before you go on',
      line: 'Your answer applies at once. Change it any time in Settings › App › Privacy.',
    };
  if (firstRun)
    return {
      say: 'Before you start',
      line:
        'Tessera is software, not financial advice, and trading futures can lose you more than you deposit. ' +
        'The analyst drafts orders and you approve each one, unless you give a session Full access.',
    };
  return {
    say: 'The terms have changed',
    line: `Tessera’s terms were updated on ${LEGAL_UPDATED}. Read them, then accept them to go on.`,
  };
}

export const USAGE_QUESTION = {
  title: 'Share usage analytics',
  line:
    'Logs, which parts of Tessera you use, a screen recording with every number and private text hidden, and the ' +
    'analyst’s model, tokens and timing go to the Tessera team through PostHog. Never credentials, account ids, ' +
    'prices, sizes, P&L or prompts.',
};

export const USAGE_UNANSWERED = 'Choose Yes or No to share usage analytics first.';

export const CRASH_NOTE = 'Tessera sends anonymous crash reports. Turn them off in Settings › App › Privacy.';

export function acceptedWords({ accepted, acceptedAt }: TermsState): string {
  if (accepted !== LEGAL_VERSION || acceptedAt === null) return `The terms of ${LEGAL_UPDATED}`;
  const on = new Date(acceptedAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: displayZone(),
  });
  return `You accepted the terms of ${LEGAL_UPDATED} on ${on}`;
}

export function openLegal(path: string): Promise<void> {
  return openExternal(`${SITE_URL}${path}`);
}
