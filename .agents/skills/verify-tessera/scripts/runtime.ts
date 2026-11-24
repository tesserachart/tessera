#!/usr/bin/env node
import { readRuntimeInfo, RuntimeRpc } from '../../../../e2e/agent/support/runtime.ts';

interface Connections {
  dataSource: string;
  connections: { displayName: string }[];
}
interface Accounts {
  accounts: { account: { displayName: string; environment: string } }[];
}

const [port, tool, input] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !tool) {
  console.error("usage: runtime.ts <port> doctor | runtime.ts <port> <tool> ['<json input>']");
  process.exit(2);
}

const rpc = await RuntimeRpc.open(await readRuntimeInfo(`http://127.0.0.1:${port}`));
try {
  const { dataSource, connections } = await rpc.tool<Connections>('connections.list', {});
  const { accounts } = await rpc.tool<Accounts>('portfolio.get_accounts', {});
  const live = accounts.filter((a) => a.account.environment !== 'paper');
  if (dataSource !== 'mock' || live.length > 0) {
    console.error(
      `refused: not the sim runtime (data source ${dataSource}, accounts ${accounts.map((a) => `${a.account.displayName} (${a.account.environment})`).join(', ')})`,
    );
    process.exit(1);
  }
  if (tool === 'doctor') {
    const { activeId, layouts } = await rpc.tool<{ activeId: string; layouts: { id: string; name: string }[] }>(
      'layout.list',
      {},
    );
    console.info(
      [
        `ok: sim runtime on 127.0.0.1:${port}`,
        `data: ${connections.map((c) => c.displayName).join(', ')}`,
        `accounts: ${accounts.map((a) => `${a.account.displayName} (paper)`).join(', ')}`,
        `workspace: ${layouts.find((l) => l.id === activeId)?.name ?? activeId}`,
      ].join('\n'),
    );
  } else {
    console.info(JSON.stringify(await rpc.tool(tool, input ? JSON.parse(input) : {}), null, 2));
  }
} finally {
  rpc.close();
}
