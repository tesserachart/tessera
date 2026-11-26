import type { Study } from '@tessera/protocol';
import { Button, useLoadPending } from '@tessera/ui';
import { useState } from 'react';
import { SESSION_RUNNER } from '../../analyst/tradingSessions.ts';
import { useNow } from '../../app/runtimeContext.ts';
import { useHasTool, useToolValue } from '../../app/tools.ts';
import { useRuntimeSettingsLoaded, useSetting } from '../../state/runtimeSettings.ts';
import { openSettings } from '../settings/store.ts';
import {
  openSetupTrades,
  setupOfStudy,
  studyTradeView,
  tradedBySessions,
  tradedWords,
  tradeInSessions,
} from './flow.ts';

export function StudyInTrade({ study }: { study: Study }) {
  useLoadPending(!useRuntimeSettingsLoaded());
  const setting = useSetting(SESSION_RUNNER);
  const sessions = useHasTool('agent.trading_session');
  const catalog = useToolValue('journal.get_catalog', {});
  const setup = setupOfStudy(catalog?.setups ?? [], study);
  const traded = setup ? tradedWords(setup) : null;
  const on = tradedBySessions(setting, study);
  const status = useToolValue('agent.trading_session', sessions ? {} : null, { refreshEvery: 15_000 });
  const now = useNow();
  const view = studyTradeView(setting, status, study, now);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const toggle = () => {
    setBusy(true);
    void tradeInSessions(setting, on ? '' : study.id)
      .then(setWhy)
      .finally(() => setBusy(false));
  };
  return (
    <>
      {sessions && view.action ? (
        <Button size="s" variant="quiet" disabled={busy} onClick={toggle}>
          {view.action}
        </Button>
      ) : null}
      {setup && traded ? (
        <Button size="s" variant="quiet" onClick={() => openSetupTrades(setup)}>
          {traded}
        </Button>
      ) : null}
      {view.standing ? (
        <Button size="s" variant="quiet" onClick={() => openSettings('analyst.sessions')}>
          {view.standing}
        </Button>
      ) : null}
      {why ? <p className="rs-error">{why}</p> : null}
    </>
  );
}
