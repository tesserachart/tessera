#!/usr/bin/env node
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

const [port, side = 'buy', points = '-150'] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || (side !== 'buy' && side !== 'sell') || !Number.isFinite(Number(points))) {
  console.error('usage: mcp-draft.ts <port> [buy|sell] [points from the last price]');
  process.exit(2);
}

const origin = `http://127.0.0.1:${port}`;
const rpc = await RuntimeRpc.open(await readRuntimeInfo(origin));
try {
  const { dataSource } = await rpc.tool<{ dataSource: string }>('connections.list', {});
  const { accounts } = await rpc.tool<{ accounts: { account: { id: string; environment: string } }[] }>(
    'portfolio.get_accounts',
    {},
  );
  const paper = accounts.find((a) => a.account.environment === 'paper')?.account.id;
  if (dataSource !== 'mock' || !paper || accounts.some((a) => a.account.environment !== 'paper')) {
    console.error('refused: not the sim runtime');
    process.exit(1);
  }
  const quote = await rpc.tool<{ last: number | null; bid: number | null }>('market.get_quote', { instrument: 'NQ' });
  const last = quote.last ?? quote.bid;
  if (last === null) {
    console.error('refused: NQ has no price yet');
    process.exit(1);
  }
  const { client, token } = await rpc.tool<{ client: { id: string; name: string }; token: string }>(
    'mcp.add_client',
    { kind: 'other' },
  );
  const limitPrice = Math.round((last + Number(points)) * 4) / 4;
  const res = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'orders_submit',
        arguments: { accountId: paper, instrument: 'NQ', side, qty: 1, orderType: 'limit', limitPrice },
      },
    }),
  });
  const answer = (await res.json()) as { result?: { content?: { text?: string }[] } };
  console.info(JSON.stringify({ client, account: paper, limitPrice, reply: answer.result?.content?.[0]?.text }, null, 2));
} finally {
  rpc.close();
}
