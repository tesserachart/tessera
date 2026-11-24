import { PRICE_TEXT, cx } from '@tessera/ui';
import type { IDockviewPanelHeaderProps, IDockviewPanelProps } from 'dockview-react';
import { useEffect, useMemo, useState } from 'react';
import { deleteAlert, pauseAlert } from '../../alerts/actions.ts';
import { AlertsList, type AlertActions } from '../../alerts/AlertsList.tsx';
import { editAlert } from '../../alerts/formStore.ts';
import { useAlerts } from '../../alerts/store.ts';
import { openSettings } from '../../areas/settings/store.ts';
import { registerTile } from './registry.ts';

function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function AlertsTile(_props: IDockviewPanelProps) {
  const alerts = useAlerts((s) => s.alerts);
  const fires = useAlerts((s) => s.recent);
  const nowMs = useNowMs();
  const act = useMemo<AlertActions>(
    () => ({
      edit: (a, opts, at) => editAlert(a, opts, at),
      pause: (a, paused) => pauseAlert(a.id, paused),
      remove: (a) => deleteAlert(a.id),
    }),
    [],
  );
  return (
    <div className="tile positions-tile alerts-tile" data-focus-zone="table" data-view="alerts">
      <AlertsList alerts={alerts} fires={fires} act={act} nowMs={nowMs} />
    </div>
  );
}

export function AlertsTab(_props: IDockviewPanelHeaderProps) {
  const n = useAlerts((s) => [...(s.alerts?.values() ?? [])].filter((a) => a.status === 'active').length);
  return (
    <span className="dock-tab-title">
      Alerts
      {n > 0 ? <span className={cx('pz-count', PRICE_TEXT)}> {String(n)}</span> : null}
    </span>
  );
}

registerTile({
  kind: 'alerts',
  private: true,
  title: 'Alerts',
  component: AlertsTile,
  home: 'bottom',
  singleton: true,
  icon: 'alert',
  order: 2,
  tab: AlertsTab,
  menu: () => [{ type: 'item', id: 'alert-settings', label: 'Alerts & sounds…', run: () => openSettings('alerts') }],
});
