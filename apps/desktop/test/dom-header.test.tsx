import type { CompactLevel, ContractSpecOutput } from '@tessera/protocol';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClockContext, RuntimeClock } from '../src/app/clock.ts';
import { queryClient } from '../src/app/queries.ts';
import type { DomParams } from '../src/orderflow/dom/ladderModel.ts';
import { DomTile } from '../src/workspace/tiles/DomTile.tsx';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { seedTools } from './support/runtime.tsx';

const ES = 'ESZ6.CME';
const ROW_H = 20;
const ROWS = 11;
const WIDE = 400;
const NARROW = 250;
const source = { provider: 'rithmic-test' };

const CONTRACT: ContractSpecOutput = {
  instrument: {
    id: ES,
    symbol: 'ESZ6',
    name: 'E-mini S&P 500 Dec 2026',
    assetClass: 'future',
    exchange: 'CME',
    currency: 'USD',
    root: 'ES',
    expiry: null,
    isFront: true,
    tradable: true,
  },
  spec: {
    instrument: ES,
    assetClass: 'future',
    root: 'ES',
    tickSize: 0.25,
    tickValue: { amount: 12.5, currency: 'USD' },
    multiplier: 50,
    currency: 'USD',
    priceDecimals: 2,
    qtyStep: 1,
    minQty: 1,
    sessions: 'cme_equity_index',
    tz: 'America/Chicago',
    expiry: null,
    lastTrade: null,
    rollDate: null,
    microOf: null,
  },
};

const BIDS: CompactLevel[] = [
  [5812, 10, 3],
  [5811.75, 20, 4],
];
const ASKS: CompactLevel[] = [
  [5812.25, 8, 2],
  [5812.5, 12, 5],
];

const heightOf = (el: Element): number =>
  el.classList.contains('r') || el.classList.contains('t-ladder-head')
    ? ROW_H
    : el.classList.contains('t-ladder')
      ? ROWS * ROW_H
      : [...el.children].reduce((h, c) => h + heightOf(c), 0);

function topOf(el: Element): number {
  const parent = el.parentElement;
  if (!parent || el.classList.contains('dom-tile')) return 0;
  let top = topOf(parent);
  for (const sibling of parent.children) {
    if (sibling === el) break;
    top += heightOf(sibling);
  }
  return top;
}

let width = WIDE;
const real = {
  rect: HTMLElement.prototype.getBoundingClientRect,
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
};

beforeEach(() => {
  width = WIDE;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const top = topOf(this);
    const height = heightOf(this);
    return { left: 0, right: width, top, bottom: top + height, width, height, x: 0, y: top, toJSON: () => ({}) };
  };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('t-ladder') ? width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('t-ladder') ? ROWS * ROW_H : 0;
    },
  });
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = real.rect;
  for (const key of ['clientWidth', 'clientHeight'] as const) {
    const was = real[key];
    if (was) Object.defineProperty(HTMLElement.prototype, key, was);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});

function words(el: Element | null | undefined): string[] {
  if (!el) return [];
  const out: string[] = [];
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n.textContent?.trim();
    if (t) out.push(t);
  }
  return out;
}

async function ladder(params: Partial<DomParams> = {}): Promise<HTMLElement> {
  const rt = fakeRuntime({ answers: { 'market.get_contract_spec': () => CONTRACT } });
  seedTools(['market.get_contract_spec']);
  const api = {
    id: 'dom-1',
    setTitle: () => undefined,
    isVisible: true,
    onDidVisibilityChange: () => ({ dispose: () => undefined }),
  };
  const props = { params: { instrument: ES, ...params }, api } as unknown as IDockviewPanelProps<Partial<DomParams>>;
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <ClockContext.Provider value={new RuntimeClock()}>
        <DomTile {...props} />
      </ClockContext.Provider>
    </QueryClientProvider>,
  );
  const depth = await waitFor(() => rt.sub('market.depth'));
  const trades = await waitFor(() => rt.sub('market.trades'));
  depth.event({ instrument: ES, ts: 0, seq: 1, kind: 'snapshot', levels: 10, bids: BIDS, asks: ASKS, source }, 0);
  trades.event(
    { instrument: ES, seq: 1, trades: [[Date.now() * 1e6, 5812, 2, 1]], source, aggressorSource: 'exchange' },
    0,
  );
  const tile = container.querySelector<HTMLElement>('.dom-tile')!;
  await waitFor(() => expect(words(tile.querySelector('.r.is-bb .bid'))).toContain('10'));
  return tile;
}

const header = (tile: HTMLElement) => tile.querySelector('.t-ladder-head');
const headerCell = (tile: HTMLElement, word: string) =>
  [...(header(tile)?.children ?? [])].find((c) => words(c).includes(word));

describe('the DOM header', () => {
  it('names each number on both sides of the price', async () => {
    const tile = await ladder();
    await waitFor(() => expect(words(header(tile))).toEqual(['Orders', 'Bid', 'Price', 'Ask', 'Orders', 'Vol']));
  });

  it('puts Orders over the orders count at the outer edge, and Bid or Ask over the contracts beside the price', async () => {
    const tile = await ladder();
    await waitFor(() => expect(headerCell(tile, 'Bid')).toBeDefined());
    const bid = words(headerCell(tile, 'Bid'));
    const ask = words(headerCell(tile, 'Ask'));
    const bestBid = words(tile.querySelector('.r.is-bb .bid'));
    const bestAsk = words(tile.querySelector('.r.is-ba .ask'));
    expect(bid.map((label, i) => [label, bestBid[i]])).toEqual([
      ['Orders', '3'],
      ['Bid', '10'],
    ]);
    expect(ask.map((label, i) => [label, bestAsk[i]])).toEqual([
      ['Ask', '8'],
      ['Orders', '2'],
    ]);
  });

  it('says nothing of orders when the orders count is off', async () => {
    const tile = await ladder({ orders: false });
    await waitFor(() => expect(words(header(tile))).toEqual(['Bid', 'Price', 'Ask', 'Vol']));
  });

  it('drops the label of a column that drops for width', async () => {
    width = NARROW;
    const tile = await ladder();
    await waitFor(() => expect(words(header(tile))).toEqual(['Orders', 'Bid', 'Price', 'Ask', 'Orders']));
  });

  it('a right-click on the first row under the labels reaches that row', async () => {
    const tile = await ladder();
    const first = tile.querySelector('.t-ladder .r')!;
    const price = first.querySelector('.px')!.textContent;
    fireEvent.contextMenu(first.querySelector('.p')!, { clientX: 150, clientY: topOf(first) + ROW_H / 2 });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText(price)).toBeTruthy();
  });
});
