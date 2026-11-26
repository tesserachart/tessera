import { Button, Loaded, ShownContext } from '@tessera/ui';
import type { IDockviewPanelProps } from 'dockview-react';
import { AnalystBody } from '../../analyst/AnalystPanel.tsx';
import { AnalystBadge, AnalystTab } from '../../analyst/AnalystTab.tsx';
import { accountStore } from '../../account/account.ts';
import { analystStore, newConversation, selectCurrent, setSheet } from '../../analyst/analystStore.ts';
import { read } from '../../app/store.ts';
import { canShare } from '../../share/model.ts';
import { shareConversation } from '../../share/store.ts';
import { SessionMenu } from '../../analyst/SessionMenu.tsx';
import { SessionList } from '../../areas/agents/SessionList.tsx';
import { focusComposer } from '../../shell/composer.ts';
import { ANALYST_KEY, NEW_SESSION_KEY } from '../../shell/keys.ts';
import { revealTile, useTileVisible } from '../dock/open.ts';
import { AnalystSample } from './AnalystSample.tsx';
import { registerTile } from './registry.ts';

function AnalystTile(_props: IDockviewPanelProps) {
  const shown = useTileVisible('analyst');
  return (
    <div className="tile analyst-tile">
      <ShownContext.Provider value={shown}>
        <AnalystWithSessions />
      </ShownContext.Provider>
    </div>
  );
}

function SessionColumn() {
  return (
    <aside className="ag-side an-sessions" aria-label="Sessions">
      <div className="ag-side-head">
        <Button
          variant="quiet"
          className="ag-new"
          shortcut={NEW_SESSION_KEY}
          onClick={() => {
            newConversation();
            focusComposer();
          }}
        >
          New session
        </Button>
      </div>
      <SessionList />
    </aside>
  );
}

const BAR = (
  <div className="an-bar" role="toolbar" aria-label="Session">
    <SessionMenu />
  </div>
);

export function AnalystWithSessions() {
  return (
    <Loaded label="Loading the desk analyst" sample={<AnalystSample />}>
      <div className="an-wide">
        <SessionColumn />
        <AnalystBody head={BAR} />
      </div>
    </Loaded>
  );
}

registerTile({
  kind: 'analyst',
  private: true,
  title: 'Analyst',
  component: AnalystTile,
  home: 'right',
  singleton: true,
  icon: 'analyst',
  shortcut: ANALYST_KEY,
  order: 1,
  tab: AnalystTab,
  badge: AnalystBadge,
  room: 320,
  menu: () => {
    const session = selectCurrent(read(analystStore));
    return [
      {
        type: 'item',
        id: 'analyst-settings',
        label: 'Model & permissions…',
        run: () => {
          revealTile('analyst', { via: 'pointer' });
          setSheet(true);
        },
      },
      ...(session && canShare(read(accountStore))
        ? [
            {
              type: 'item' as const,
              id: 'analyst-share',
              label: 'Share conversation…',
              run: () => void shareConversation(session.id),
            },
          ]
        : []),
    ];
  },
});
