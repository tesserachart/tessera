import { useTopicEffect } from '../app/useTopic.ts';
import { useTradeSounds } from '../sound/useTradeSounds.ts';
import { AlertFormHost } from './AlertFormHost.tsx';
import { deliverFire } from './deliver.ts';
import { applyAlertsEvent, resetAlerts } from './store.ts';

export function AlertsData({ deliver = false }: { deliver?: boolean }) {
  useTopicEffect(
    'alerts',
    {},
    (ev) => {
      applyAlertsEvent(ev, Date.now());
      if (deliver && ev.type === 'fired') deliverFire(ev.fire);
    },
    { onResubscribed: () => resetAlerts() },
  );
  return (
    <>
      {deliver ? <TradeSounds /> : null}
      <AlertFormHost />
    </>
  );
}

function TradeSounds() {
  useTradeSounds();
  return null;
}
