import { PlatformProvider } from '@tessera/ui';
import { screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { patch } from '../src/app/store.ts';
import { Analytics } from '../src/areas/journal/sections/Analytics.tsx';
import { Dashboard } from '../src/areas/journal/sections/Dashboard.tsx';
import { Trades } from '../src/areas/journal/sections/Trades.tsx';
import { MarketDetail } from '../src/areas/markets/MarketDetail.tsx';
import { MarketsPage } from '../src/areas/markets/MarketsPage.tsx';
import { DEFAULT_PLACE, marketsUiStore } from '../src/areas/markets/store.ts';
import { SymbolPopover } from '../src/markets/SymbolPopover.tsx';
import { closeSymbolSearch, openSymbolSearch } from '../src/state/ui.ts';
import { DeskEmpty } from '../src/workspace/dock/DeskEmpty.tsx';
import { LayoutKnownContext } from '../src/workspace/dock/layoutKnown.ts';
import { AccountsTile } from '../src/workspace/tiles/AccountsTile.tsx';
import { AnalystWithSessions } from '../src/workspace/tiles/AnalystTile.tsx';
import { PositionsTile } from '../src/workspace/tiles/PositionsTile.tsx';
import { TradeTile } from '../src/workspace/tiles/TradeTile.tsx';
import { heldReads, mountSurface, SIM, unmountSurface, visibleText } from './support/loading.tsx';

afterEach(() => {
  unmountSurface();
  closeSymbolSearch();
  patch(marketsUiStore, DEFAULT_PLACE);
});

const tileProps = {
  api: { id: 'tile', getParameters: () => ({}), updateParameters: () => undefined },
} as unknown as IDockviewPanelProps;

function skeleton(surface: ReactNode, label: string): Element {
  const held = heldReads(SIM);
  mountSurface(held.client, <PlatformProvider value="other">{surface}</PlatformProvider>, {
    tools: Object.keys(SIM.tools),
  });
  const status = screen.getByRole('status', { name: label });
  expect(visibleText(status)).toBe('');
  return status;
}

const count = (root: Element, selector: string) => root.querySelectorAll(selector).length;

describe('a first-ever loading skeleton is measured from the real UI drawn with sample data', () => {
  it('Positions: open, working and fills rows in the real columns', () => {
    const s = skeleton(<PositionsTile {...tileProps} />, 'Loading positions');
    expect(count(s, '.pz-table tr.pz-cols')).toBe(3);
    expect(count(s, '.pz-table tbody tr:not(.pz-cols) td.sym-cell')).toBeGreaterThanOrEqual(5);
    expect(count(s, '.pz-table td.col-account')).toBeGreaterThanOrEqual(5);
    expect(count(s, '.pz-table td.p')).toBeGreaterThan(0);
  });

  it('Accounts: the account table with its heading and rows', () => {
    const s = skeleton(<AccountsTile {...tileProps} />, 'Loading accounts');
    expect(count(s, '.ac-tbl thead th.c-bal')).toBe(1);
    expect(count(s, '.ac-tbl tr.ac-row td.c-bal')).toBe(3);
    expect(count(s, '.ac-tbl tr.ac-row td.c-conn')).toBe(3);
  });

  it('Trade: the order ticket with its read-out, size and order buttons', () => {
    const s = skeleton(
      <LayoutKnownContext.Provider value={false}>
        <TradeTile {...tileProps} />
      </LayoutKnownContext.Provider>,
      'Loading the ticket',
    );
    expect(count(s, '.tk-head .tk-acct')).toBe(1);
    expect(count(s, '.tk-readout')).toBe(1);
    expect(count(s, '.tk-size .tk-amount')).toBe(1);
    expect(count(s, '.tk-grid .tk-order')).toBe(10);
    expect(count(s, '.tk-grid .tk-exit')).toBe(4);
  });

  it('the empty desk: its heading and both actions', () => {
    const s = skeleton(
      <LayoutKnownContext.Provider value={true}>
        <DeskEmpty />
      </LayoutKnownContext.Provider>,
      'Loading the desk',
    );
    expect(count(s, 'section h2')).toBe(1);
    expect(count(s, 'section button')).toBe(2);
  });

  it('the desk Analyst: sessions, starters and the composer', () => {
    const s = skeleton(<AnalystWithSessions />, 'Loading the desk analyst');
    expect(count(s, '.an-sessions .ag-srow')).toBeGreaterThan(0);
    expect(count(s, '.an-starters li')).toBeGreaterThan(0);
    expect(count(s, '.ag-compose textarea')).toBe(1);
  });

  it('Markets: the list nav, sortable headings and market rows', () => {
    const s = skeleton(<MarketsPage />, 'Loading markets');
    expect(count(s, '.mk-nav .mk-nav-row')).toBeGreaterThanOrEqual(4);
    expect(count(s, '.mk-head button[role="columnheader"]')).toBe(5);
    expect(count(s, '.mk-row .c-sym .nm')).toBe(14);
    expect(count(s, '.mk-row .c-last')).toBe(14);
  });

  it('a market’s detail: price, actions and contract facts', () => {
    const s = skeleton(
      <MarketDetail
        subject={{ id: 'NQZ6.CME', row: null }}
        connectionOf={() => null}
        nowMs={0}
        onOpen={() => undefined}
      />,
      'Loading market',
    );
    expect(count(s, '.mk-detail .mk-d-price')).toBe(1);
    expect(count(s, '.mk-d-actions button')).toBe(4);
    expect(count(s, '.mk-d-kv dt')).toBeGreaterThan(5);
  });

  it('the symbol popover: hit rows and the brief', () => {
    patch(marketsUiStore, DEFAULT_PLACE);
    openSymbolSearch('nq');
    const s = skeleton(<SymbolPopover />, 'Loading symbols');
    expect(count(s, '.sym-hits .sym-hit')).toBeGreaterThanOrEqual(5);
    expect(count(s, '.sym-foot .brief')).toBe(1);
  });

  it('Journal dashboard: the page with every widget drawn from its sample', () => {
    const s = skeleton(<Dashboard />, 'Loading the dashboard');
    expect(count(s, '.jd-page')).toBe(1);
    expect(count(s, '.jd-today')).toBe(1);
    expect(count(s, '.jd-fig')).toBeGreaterThanOrEqual(3);
  });

  it('Journal analytics: the query bar, report tabs and the overview’s metric cards', () => {
    const s = skeleton(<Analytics />, 'Loading the analytics');
    expect(count(s, '.ja-page .ja-tabs')).toBe(1);
    expect(count(s, '.jk-metric')).toBeGreaterThanOrEqual(4);
  });

  it('Journal trades: the trade table with sample rows', () => {
    const s = skeleton(<Trades />, 'Loading the trades');
    expect(count(s, 'tbody tr')).toBeGreaterThanOrEqual(5);
  });
});
