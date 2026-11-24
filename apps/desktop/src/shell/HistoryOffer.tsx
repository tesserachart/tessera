import { Button } from '@tessera/ui';
import { useEffect, useRef } from 'react';
import { HistoryMarkets } from '../areas/settings/HistoryMarkets.tsx';
import { OFFER_LABEL, OFFER_LATER, OFFER_STARTED, offerLede } from '../areas/settings/history.ts';

export function HistoryOffer({ connection, onDone }: { connection: string; onDone: (said: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, []);
  return (
    <div className="ob-offer" ref={box}>
      <p className="ob-lede">{offerLede(connection)}</p>
      <p className="ob-label">{OFFER_LABEL}</p>
      <HistoryMarkets
        secondary={
          <Button size="s" variant="quiet" onClick={() => onDone(OFFER_LATER)}>
            Not now
          </Button>
        }
        onStarted={() => onDone(OFFER_STARTED)}
      />
    </div>
  );
}
