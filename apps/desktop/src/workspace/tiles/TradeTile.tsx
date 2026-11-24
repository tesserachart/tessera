import { Loaded } from '@tessera/ui';
import type { IDockviewPanelProps } from 'dockview-react';
import { useContext } from 'react';
import { ErrorBoundary } from '../../app/ErrorBoundary.tsx';
import { Ticket } from '../../chart/ticket/Ticket.tsx';
import { TRADE_KEY } from '../../shell/keys.ts';
import { LayoutKnownContext } from '../dock/layoutKnown.ts';
import { registerTile } from './registry.ts';
import { TicketSample } from './TicketSample.tsx';
import { useTradeChart } from './trade.ts';

export function TradeTile(_props: IDockviewPanelProps) {
  const chart = useTradeChart();
  const layoutKnown = useContext(LayoutKnownContext);
  return (
    <div className="tile trade-tile" data-focus-zone="ticket">
      <Loaded label="Loading the ticket" pending={!layoutKnown} sample={<TicketSample />}>
        {chart ? (
          <ErrorBoundary key={`${chart.layoutId}:${chart.tileId}`} name="Ticket">
            <Ticket chart={chart} />
          </ErrorBoundary>
        ) : (
          <p className="trade-none">Open a chart to trade from here.</p>
        )}
      </Loaded>
    </div>
  );
}

registerTile({
  kind: 'trade',
  title: 'Trade',
  component: TradeTile,
  home: 'right',
  singleton: true,
  icon: 'ticket',
  shortcut: TRADE_KEY,
  order: 0,
  room: 248,
});
