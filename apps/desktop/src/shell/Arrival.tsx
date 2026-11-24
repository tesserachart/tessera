import { useEffect, useState } from 'react';
import { useAccountGate } from '../account/account.ts';
import { AccountGate, TermsGate } from '../account/AccountGate.tsx';
import { useTermsDue } from '../account/terms.ts';
import { useNeedsOnboarding } from '../accounts/onboarding.ts';
import { patch, read } from '../app/store.ts';
import { usageAsked, useSharing } from '../app/telemetry.ts';
import { arrivalStore } from './arrival.ts';
import { Onboarding } from './Onboarding.tsx';
import { useShellData } from './shellData.ts';
import { SplashExit, SplashRest } from './Splash.tsx';

const DECIDE_MS = 4_000;

export function Arrival() {
  const [show] = useState(() => !read(arrivalStore).shown);
  useEffect(() => patch(arrivalStore, show ? { shown: true } : { shown: true, arrived: true }), [show]);
  const gate = useAccountGate();
  const terms = useTermsDue();
  const sharing = useSharing();
  const asks = usageAsked(sharing);
  const [through, setThrough] = useState(false);
  if (!through && gate === 'open' && !terms && sharing.kind !== 'unknown' && !asks) setThrough(true);
  if (!show) return null;
  if (!through) {
    if (terms || asks) return <TermsGate />;
    return gate === 'wait' || gate === 'open' ? <SplashRest /> : <AccountGate gate={gate} />;
  }
  return <Onward />;
}

function Onward() {
  const need = useNeedsOnboarding();
  const [step, setStep] = useState<'wait' | 'onboard' | 'exit'>('wait');
  const [said, setSaid] = useState<string | null>(null);
  const { accountId, providers } = useShellData();
  if (step === 'wait' && need !== null) setStep(need ? 'onboard' : 'exit');
  useEffect(() => {
    const t = setTimeout(() => setStep((s) => (s === 'wait' ? 'exit' : s)), DECIDE_MS);
    return () => clearTimeout(t);
  }, []);
  if (step === 'wait') return <SplashRest />;
  if (step === 'onboard')
    return (
      <Onboarding
        onDone={(line) => {
          setSaid(line);
          setStep('exit');
        }}
      />
    );
  const analyst = providers.find((p) => p.kind === 'agent' && p.status === 'ok')?.displayName ?? null;
  return <SplashExit you={accountId} analyst={analyst} say={said} />;
}
