import type { Layout, PullEstimate, PullSummary } from '@tessera/protocol';
import { read } from '../../src/app/store.ts';
import { defaultChartState, layoutsStore } from '../../src/state/layouts.ts';
import { patch } from '../../src/app/store.ts';
import type { FakeClient } from './runtime.tsx';

const WEEK = { from: '2026-10-26', to: '2026-10-30', scope: 'session' } as const;

export function estimate(root: string, over: Partial<PullEstimate> = {}): PullEstimate {
  return {
    request: { instrument: root, ...WEEK },
    id: `${root}-${WEEK.from}-${WEEK.to}-session`,
    contract: `${root}Z6.CME`,
    days: 5,
    saved: 0,
    outOfReach: 0,
    size: { bytes: 410 * 1024 * 1024, prints: 1_000_000, measuredPrints: 500_000 },
    seconds: 240,
    ...over,
  };
}

export const UNMEASURED: Partial<PullEstimate> = { size: null, seconds: null };
export const ALL_SAVED: Partial<PullEstimate> = {
  saved: 5,
  size: { bytes: 0, prints: 0, measuredPrints: 500_000 },
  seconds: 0,
};

export function pull(root: string, done: number, over: Partial<PullSummary> = {}): PullSummary {
  return {
    id: `${root}-${WEEK.from}-${WEEK.to}-session`,
    request: { instrument: root, ...WEEK },
    state: 'running',
    progress: {
      days: 5,
      saved: done,
      alreadySaved: 0,
      noTrades: 0,
      outOfReach: 0,
      failed: 0,
      later: 0,
      waiting: 5 - done,
      prints: 0,
    },
    current: { date: '2026-10-28', piecesDone: 1, pieces: 4, waitingFor: null, waitingWhy: null },
    etaSeconds: null,
    auto: false,
    days: [{ date: WEEK.to, contract: `${root}Z6.CME`, source: 'rithmic', status: { kind: 'waiting' } }],
    ...over,
  };
}

export type Handlers = Record<string, (input: any) => unknown>;

export function refusingClient(handlers: Handlers) {
  const calls: { name: string; input: unknown }[] = [];
  const client: FakeClient = {
    request: (method: string, params: { name?: string; input?: unknown } | undefined) => {
      if (method !== 'tools.invoke' || !params?.name) return new Promise(() => undefined);
      calls.push({ name: params.name, input: params.input });
      const handler = handlers[params.name];
      if (!handler) return new Promise(() => undefined);
      try {
        return Promise.resolve({ ok: true, status: 'ok', output: handler(params.input) });
      } catch (e) {
        return Promise.resolve({ ok: false, error: { message: e instanceof Error ? e.message : String(e) } });
      }
    },
  };
  return { client, calls };
}

export function estimates(served: Record<string, PullEstimate>): Handlers {
  return {
    'market.estimate_pull': ({ instrument }: { instrument: string }) => {
      const found = served[instrument];
      if (!found) throw new Error(`${instrument} is not served by this connection`);
      return found;
    },
  };
}

const CHART_ID = (root: string) => `${root}Z6.CME-RITHMIC`;

export function specs(roots: readonly string[]): Handlers {
  return {
    'market.get_contract_spec': ({ instrument }: { instrument: string }) => {
      const root = roots.find((r) => CHART_ID(r) === instrument);
      if (!root) throw new Error('unknown contract');
      return {
        instrument: {
          id: instrument,
          symbol: `${root}Z6`,
          name: `${root} Dec 2026`,
          assetClass: 'future',
          exchange: 'CME',
          currency: 'USD',
          root,
          expiry: '2026-12-18',
          isFront: true,
          tradable: true,
        },
        spec: {
          instrument,
          assetClass: 'future',
          root,
          tickSize: 0.25,
          tickValue: { amount: 5, currency: 'USD' },
          multiplier: 20,
          currency: 'USD',
          priceDecimals: 2,
          qtyStep: 1,
          minQty: 1,
          sessions: 'cme_equity_index',
          tz: 'America/Chicago',
          expiry: '2026-12-18',
          lastTrade: null,
          rollDate: null,
          microOf: null,
        },
      };
    },
  };
}

export function deskOf(roots: readonly string[]): void {
  const charts = Object.fromEntries(
    roots.map((r, i) => [`chart-${String(i + 1)}`, defaultChartState(`chart-${String(i + 1)}`, r, CHART_ID(r), '5m')]),
  );
  const layout = {
    id: 'default',
    name: 'Default',
    revision: 1,
    updatedAt: 0,
    activeChartId: null,
    dock: {},
    charts,
    trade: {},
  } as unknown as Layout;
  patch(layoutsStore, { layouts: { ...read(layoutsStore).layouts, default: layout } });
}

export function emptyDesk(): void {
  patch(layoutsStore, { layouts: {} });
}
