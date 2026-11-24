import type { Card, CardAction, CardBody } from '@tessera/protocol';
import { Button } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { useTopicEffect } from '../../app/useTopic.ts';
import { DataCoverageCard } from './DataCoverageCard.tsx';
import { TradingSessionCard } from './TradingSessionCard.tsx';
import { runCardAction } from './actions.ts';

function Body({ body, actions }: { body: CardBody; actions: ReactNode }) {
  switch (body.kind) {
    case 'data_coverage':
      return <DataCoverageCard body={body} actions={actions} />;
    case 'trading_session':
      return <TradingSessionCard body={body} actions={actions} />;
  }
}

function Actions({ actions }: { actions: readonly CardAction[] }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!actions.length) return null;
  const press = (a: CardAction) => {
    setBusy(true);
    setFailed(null);
    void runCardAction(a).then((why) => {
      setBusy(false);
      setFailed(why);
    });
  };
  return (
    <>
      {actions.map((a) => (
        <Button
          key={a.label}
          size="s"
          variant={a.primary ? 'primary' : 'quiet'}
          disabled={busy}
          onClick={() => press(a)}
        >
          {a.label}
        </Button>
      ))}
      {failed ? (
        <span className="cc-failed" role="alert">
          {failed}
        </span>
      ) : null}
    </>
  );
}

export function LiveCard({ card }: { card: Card }) {
  const [now, setNow] = useState(card);
  useTopicEffect('cards', { cardId: card.id }, (next) => setNow(next));
  return <Body body={now.body} actions={<Actions actions={now.actions} />} />;
}
