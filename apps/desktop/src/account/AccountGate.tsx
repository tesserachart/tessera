import { Button, Choice, Tooltip, type SegmentedOption } from '@tessera/ui';
import { LEGAL_PAGES } from '@tessera/ui/legal';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { patch } from '../app/store.ts';
import { setConsent, usageAsked, useSharing } from '../app/telemetry.ts';
import { failureText } from '../app/tools.ts';
import { arrivalStore } from '../shell/arrival.ts';
import { SplashFrame } from '../shell/Splash.tsx';
import { checkAgain, gateWords, signIn, signOut, useAccount, type AccountGate as Gate } from './account.ts';
import {
  acceptTerms,
  CRASH_NOTE,
  openLegal,
  termsWords,
  USAGE_QUESTION,
  USAGE_UNANSWERED,
  useTermsAccepted,
  useTermsDue,
} from './terms.ts';

function useOverDesk() {
  useEffect(() => {
    const root = document.getElementById('root');
    if (root) root.inert = true;
    patch(arrivalStore, { onboarding: true });
    return () => {
      if (root) root.inert = false;
      patch(arrivalStore, { onboarding: false });
    };
  }, []);
}

const YES_NO: readonly SegmentedOption<'yes' | 'no'>[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

export function TermsGate() {
  const { accepted } = useTermsAccepted();
  const [firstRun] = useState(() => accepted === null);
  const termsDue = useTermsDue();
  const sharing = useSharing();
  const asksUsage = usageAsked(sharing);
  const [usage, setUsage] = useState<boolean | null>(null);
  const waiting = asksUsage && usage === null;
  const [error, setError] = useState<string | null>(null);
  const say = termsWords(firstRun, termsDue);
  const form = useRef<HTMLDivElement>(null);
  useOverDesk();
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  const accept = () => {
    setError(null);
    if (waiting) return;
    if (sharing.kind === 'known' && asksUsage) void setConsent(sharing.consent, { usage }).then(setError);
    if (termsDue) acceptTerms();
  };
  return createPortal(
    <SplashFrame className="t-sh-onboard t-sh-account" role="dialog" label={say.say}>
      <div className="say">{say.say}</div>
      <div className="ob-form ac-gate" ref={form}>
        <p className="ac-line">{say.line}</p>
        <div className="ac-links">
          {LEGAL_PAGES.map((p) => (
            <Button key={p.path} size="s" variant="quiet" onClick={() => void openLegal(p.path).catch(() => undefined)}>
              {p.title}
            </Button>
          ))}
        </div>
        {asksUsage ? (
          <div className="ac-ask">
            <b>{USAGE_QUESTION.title}</b>
            <p className="ac-note">{USAGE_QUESTION.line}</p>
            <Choice<'yes' | 'no'>
              label={USAGE_QUESTION.title}
              value={usage === null ? null : usage ? 'yes' : 'no'}
              options={YES_NO}
              onChange={(v) => setUsage(v === 'yes')}
            />
          </div>
        ) : null}
        {asksUsage && sharing.kind === 'known' && sharing.consent.crashes ? (
          <p className="ac-note">{CRASH_NOTE}</p>
        ) : null}
        {termsDue ? (
          <p className="ac-note">
            By choosing Accept you agree to the terms of service and the risk disclaimer, and confirm you have read the
            privacy policy.
          </p>
        ) : null}
        {error ? (
          <p className="ac-note" role="alert">
            {error}
          </p>
        ) : null}
        <div className="ac-acts">
          {waiting ? (
            <Tooltip content={USAGE_UNANSWERED} side="top">
              <span tabIndex={0}>
                <Button variant="primary" disabled>
                  {termsDue ? 'Accept' : 'Continue'}
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button variant="primary" onClick={accept}>
              {termsDue ? 'Accept' : 'Continue'}
            </Button>
          )}
        </div>
      </div>
    </SplashFrame>,
    document.body,
  );
}

export function AccountGate({ gate }: { gate: Exclude<Gate, 'wait' | 'open'> }) {
  const state = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acts = useRef<HTMLDivElement>(null);
  useOverDesk();
  useEffect(() => {
    acts.current?.querySelector<HTMLElement>('button')?.focus();
  }, [gate]);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void action()
      .catch((e: unknown) => setError(failureText(e)))
      .finally(() => setBusy(false));
  };
  const { say, line, note: said } = gateWords(gate, state);
  const note = error ?? said;
  return createPortal(
    <SplashFrame className="t-sh-onboard t-sh-account" role="dialog" label={say}>
      <div className="say">{say}</div>
      <div className="ob-form ac-gate">
        <p className="ac-line">{line}</p>
        {note ? (
          <p className="ac-note" role="status">
            {note}
          </p>
        ) : null}
        <div className="ac-acts" ref={acts}>
          {gate === 'sign-in' ? (
            <Button variant="primary" disabled={busy} onClick={() => run(signIn)}>
              {state?.signingIn ? 'Open the browser again' : 'Sign in'}
            </Button>
          ) : gate === 'unreadable' ? (
            <Button variant="primary" disabled={busy} onClick={() => run(checkAgain)}>
              Try again
            </Button>
          ) : (
            <>
              {gate === 'waitlist' ? (
                <Button variant="primary" disabled={busy || state?.checking === true} onClick={() => run(checkAgain)}>
                  {state?.checking ? 'Checking…' : 'Check again'}
                </Button>
              ) : null}
              <Button variant="quiet" disabled={busy} onClick={() => run(signOut)}>
                Sign out
              </Button>
            </>
          )}
        </div>
      </div>
    </SplashFrame>,
    document.body,
  );
}
