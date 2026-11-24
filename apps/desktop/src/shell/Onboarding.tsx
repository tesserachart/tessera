import type { ConnectionInfo } from '@tessera/protocol';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoginForm } from '../accounts/ConnectionSetup.tsx';
import { systemOf } from '../accounts/connections.ts';
import { chartFirstContract } from '../accounts/onboarding.ts';
import { OFFER_HEADING } from '../areas/settings/history.ts';
import { patch } from '../app/store.ts';
import { useHasTool } from '../app/tools.ts';
import { arrivalStore } from './arrival.ts';
import { HistoryOffer } from './HistoryOffer.tsx';
import { SplashFrame } from './Splash.tsx';

const LOGIN_HEADING = 'Connect your Rithmic login';

export function Onboarding({ onDone }: { onDone: (said: string | null) => void }) {
  const [connected, setConnected] = useState<ConnectionInfo | null>(null);
  const offers = useHasTool('market.estimate_pull');
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.getElementById('root');
    if (root) root.inert = true;
    patch(arrivalStore, { onboarding: true });
    form.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => {
      if (root) root.inert = false;
      patch(arrivalStore, { onboarding: false });
    };
  }, []);
  const login = (c: ConnectionInfo) => {
    const charted = chartFirstContract(c.id);
    if (offers) setConnected(c);
    else void charted.finally(() => onDone(`${systemOf(c.displayName)} connected`));
  };
  const heading = connected ? OFFER_HEADING : LOGIN_HEADING;
  return createPortal(
    <SplashFrame className="t-sh-onboard" role="dialog" label={heading}>
      <h1 className="say">{heading}</h1>
      {connected ? (
        <div className="ob-form" key="offer">
          <HistoryOffer connection={connected.displayName} onDone={onDone} />
        </div>
      ) : (
        <div className="ob-form" ref={form} key="login">
          <LoginForm mode="first" onDone={login} onCancel={() => onDone(null)} />
        </div>
      )}
    </SplashFrame>,
    document.body,
  );
}
