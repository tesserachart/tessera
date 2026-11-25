import type { Order } from '@tessera/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupBrackets } from '../src/chart/brackets.ts';
import { placeAfterEntry, type PlaceBase, type PlaceStep } from '../src/chart/placement.ts';
import { runPlaceStep } from '../src/chart/placementRun.ts';
import { endPlacement, placementStore, startPlacement } from '../src/state/placement.ts';
import { read } from '../src/app/store.ts';
import type * as TradeActions from '../src/shell/tradeActions.ts';
import type { ActionResult } from '../src/shell/tradeActions.ts';

const attach = vi.hoisted(() => ({ settle: null as ((r: ActionResult) => void) | null }));

vi.mock('../src/shell/tradeActions.ts', async (original) => ({
  ...(await original<typeof TradeActions>()),
  attachLeg: () =>
    new Promise<ActionResult>((resolve) => {
      attach.settle = resolve;
    }),
}));

const NQ = 'NQZ6.CME';

const base: PlaceBase = {
  accountId: 'paper-main',
  environment: 'paper',
  instrument: NQ,
  symbol: 'NQ Z6',
  side: 'buy',
  qty: 1,
  kind: 'limit',
  tick: 0.25,
  decimals: 2,
  mode: 'qty',
  risk: 250,
  tickValue: 5,
  stopTicks: null,
  targetTicks: null,
};

const entry: Order = {
  id: 'e5',
  brokerOrderId: null,
  draftId: null,
  request: {
    accountId: 'paper-main',
    instrument: NQ,
    side: 'buy',
    qty: 1,
    orderType: 'limit',
    limitPrice: 20600,
    stopPrice: null,
    tif: 'day',
    bracket: null,
    clientOrderId: null,
    reduceOnly: false,
  },
  role: 'entry',
  parentId: null,
  status: 'working',
  filledQty: 0,
  avgFillPrice: null,
  queueAhead: null,
  triggeredAt: null,
  environment: 'paper',
  reason: null,
  createdAt: 1_759_430_000_000,
  updatedAt: 1_759_430_000_000,
};

afterEach(() => {
  endPlacement();
  attach.settle = null;
});

describe('a placement ended while its leg is on the way', () => {
  it('stays ended when the leg lands after Esc', async () => {
    const placing = placeAfterEntry(base, 'e5', 20600);
    startPlacement(placing);
    const step: PlaceStep = {
      kind: 'attach',
      next: { ...placing, stage: 'target' },
      role: 'stop',
      price: 20590,
      what: 'Stop',
    };
    const brackets = groupBrackets([entry], [], [], new Set([NQ, 'NQ']));
    const run = runPlaceStep(placing, step, brackets, () => undefined);
    expect(read(placementStore).placing).toMatchObject({ stage: 'target' });

    endPlacement();
    attach.settle!({ tone: 'ok', text: 'Stop placed', what: 'Stop' });
    await run;

    expect(read(placementStore).placing).toBeNull();
  });
});
