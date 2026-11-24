import type { IWatermarkPanelProps } from 'dockview-react';
import { Button, Icon, Loaded, STRONG_TEXT, cx, useLoadPending } from '@tessera/ui';
import { useContext, type ReactNode } from 'react';
import { connectionItem } from '../../accounts/connections.ts';
import { addConnection } from '../../accounts/navigate.ts';
import { useListedConnections } from '../../accounts/useConnections.ts';
import { healthStore } from '../../app/health.ts';
import { useAccountList } from '../../app/portfolio.ts';
import { useStore } from '../../app/store.ts';
import { useShellData } from '../../shell/shellData.ts';
import { openPalette } from '../../state/ui.ts';
import { ADD_TO_DESK, DeskHeader } from './header/PanelHeader.tsx';
import { LayoutKnownContext } from './layoutKnown.ts';
import { LibraryMenu } from './PanelsLibrary.tsx';

const ADD_PANEL = (
  <Button size="s" variant="quiet">
    Add panel
    <Icon name="chevron-down" />
  </Button>
);

function DeskEmptyView({ market, onFirst, addPanel }: { market: boolean; onFirst: () => void; addPanel: ReactNode }) {
  return (
    <section
      className="flex flex-1 flex-col items-center justify-center gap-1 px-pad text-center"
      aria-label={market ? 'No chart open' : 'No market data'}
    >
      <h2 className={cx(STRONG_TEXT, 'm-0')}>{market ? 'No chart open' : 'No market data'}</h2>
      <p className="m-0 max-w-[360px] text-body text-t2">
        {market ? 'Pick a market to chart it, or add any panel.' : 'Tessera is not connected to a market.'}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button size="s" variant={market ? 'secondary' : 'primary'} onClick={onFirst}>
          {market ? 'Open a chart' : 'Connect Rithmic'}
        </Button>
        {addPanel}
      </div>
    </section>
  );
}

const stayEmpty = () => undefined;

const DESK_EMPTY_SAMPLE = <DeskEmptyView market onFirst={stayEmpty} addPanel={ADD_PANEL} />;

function DeskEmptyCopy() {
  const listed = useListedConnections();
  const { accounts } = useShellData();
  useLoadPending(useAccountList() === null);
  useLoadPending(useStore(healthStore) === null);
  const market = listed.some((l) => l.kind === 'login' && connectionItem(l, accounts).shownInChrome);
  return (
    <DeskEmptyView
      market={market}
      onFirst={() => (market ? openPalette('') : addConnection())}
      addPanel={<LibraryMenu into="centre" label={ADD_TO_DESK} align="center" trigger={ADD_PANEL} />}
    />
  );
}

export function DeskEmpty({ group }: Partial<IWatermarkPanelProps>) {
  const layoutKnown = useContext(LayoutKnownContext);
  if (!layoutKnown || (group && group.api.location.type !== 'grid')) return null;
  return (
    <div className="tile">
      {group ? null : <DeskHeader />}
      <Loaded label="Loading the desk" sample={DESK_EMPTY_SAMPLE}>
        <DeskEmptyCopy />
      </Loaded>
    </div>
  );
}
