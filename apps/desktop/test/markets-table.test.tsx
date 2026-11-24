import type { Instrument } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketTable } from '../src/areas/markets/MarketTable.tsx';
import { rowsOf, sectionsOf } from '../src/areas/markets/model.ts';
import { TestRuntime } from './support/runtime.tsx';

const silent = { request: () => new Promise<never>(() => undefined) };

const future = (symbol: string, root: string, expiry: string, name: string, exchange: string): Instrument => ({
  id: `${symbol}.${exchange}`,
  symbol,
  name,
  assetClass: 'future',
  exchange,
  currency: 'USD',
  root,
  expiry,
  isFront: false,
  tradable: true,
});

function mount(instruments: Instrument[]) {
  const sections = sectionsOf(rowsOf([{ id: 'rithmic', name: 'Rithmic', feedsDesk: true, error: null, instruments }]));
  const nothing = () => undefined;
  render(
    <TestRuntime client={silent}>
      <TooltipProvider>
        <MarketTable
          sections={sections}
          showSource={false}
          selected={new Set()}
          cursor={null}
          charted={() => false}
          watchlist={null}
          sort={null}
          onSort={nothing}
          onClick={nothing}
          onOpen={nothing}
          targetsOf={(r) => [r]}
          onMenu={nothing}
          nowMs={0}
          notes={null}
          empty={null}
          domId={(r) => `market-${r.id}`}
          onKeyDown={nothing}
          label="All markets"
        />
      </TooltipProvider>
    </TestRuntime>,
  );
}

const dated = (symbol: string) => within(screen.getByRole('option', { name: symbol })).getByText(/\d{4}/).textContent;

afterEach(cleanup);

describe('the Markets table', () => {
  it('names a contract by its contract month: CL Z6 is December though it stops trading in November', () => {
    mount([
      future('CLZ6', 'CL', '2026-11-19', 'Crude Oil Dec 2026', 'NYMEX'),
      future('CLF7', 'CL', '2026-12-17', 'Crude Oil Jan 2027', 'NYMEX'),
    ]);
    expect(dated('CL Z6')).toBe('Dec 2026');
    expect(dated('CL F7')).toBe('Jan 2027');
  });

  it('gives a market that lists one contract one row saying what it is; a root listing several keeps its heading', () => {
    mount([
      future('CLZ6', 'CL', '2026-11-19', 'Crude Oil Dec 2026', 'NYMEX'),
      future('GCZ6', 'GC', '2026-12-29', 'Gold Dec 2026', 'COMEX'),
      future('NQZ6', 'NQ', '2026-12-18', 'E-mini Nasdaq-100 Dec 2026', 'CME'),
      future('NQH7', 'NQ', '2027-03-19', 'E-mini Nasdaq-100 Mar 2027', 'CME'),
    ]);
    const shown = [...screen.getByRole('listbox').querySelectorAll('[role="option"], [role="presentation"]')].map(
      (line) =>
        [...line.querySelectorAll('b, span')]
          .filter((part) => part.childElementCount === 0 && part.textContent)
          .map((part) => part.textContent)
          .join('  '),
    );
    expect(shown).toEqual([
      'NQ  E-mini Nasdaq-100 · CME',
      'NQ Z6  Dec 2026',
      'NQ H7  Mar 2027',
      'GC Z6  Gold Dec 2026 · COMEX',
      'CL Z6  Crude Oil Dec 2026 · NYMEX',
    ]);
  });
});
