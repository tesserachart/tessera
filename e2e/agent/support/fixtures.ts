import { test as base } from '@e2e-dev/web';
import { readRuntimeInfo, RuntimeRpc } from './runtime.ts';

const TRADE_CHARTS = [
  { tileId: 'chart-1', instrument: 'NQ', tf: '5m' },
  { tileId: 'chart-2', instrument: 'ES', tf: '1m' },
] as const;

async function resetTradeCharts(rpc: RuntimeRpc): Promise<void> {
  const layoutId = rpc.hello.defaultLayoutId;
  for (const { tileId, instrument, tf } of TRADE_CHARTS) {
    await rpc.tool('chart.set_symbol', { layoutId, tileId, instrument });
    await rpc.tool('chart.set_timeframe', { layoutId, tileId, tf });
  }
  await rpc.tool('workspace.save', { layoutId });
}

export const test = base.extend<{ runtime: RuntimeRpc }>({
  runtime: async ({ app }, use) => {
    const rpc = await RuntimeRpc.open(await readRuntimeInfo(app.baseUrl));
    try {
      await resetTradeCharts(rpc);
      await use(rpc);
      await resetTradeCharts(rpc);
    } finally {
      rpc.close();
    }
  },
});

export { expect } from 'e2e';
