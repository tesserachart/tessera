import type { ToolDescriptor } from '@tessera/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient, TOOL_LIST } from '../src/app/queries.ts';
import { toolListQuery } from '../src/app/tools.ts';
import { fakeRuntime, type FakeRuntime } from './support/fakeRuntime.ts';

function descriptor(name: string, title = name): ToolDescriptor {
  return {
    name,
    mcpName: name,
    title,
    description: '',
    risk: 'read',
    category: 'market',
    inputSchema: {},
    outputSchema: {},
    uiHints: { icon: null, resultView: null, activityLabel: null, hidden: false },
    idempotent: true,
    userOnly: false,
  };
}

async function listed(rt: FakeRuntime, answer: ToolDescriptor[]) {
  const read = queryClient.query({ ...toolListQuery, staleTime: 0 });
  const call = await vi.waitFor(() => {
    const c = rt.calls.find((c) => c.method === 'tools.list' && !c.settled);
    if (!c) throw new Error('not listed yet');
    return c;
  });
  call.answer(answer);
  await read;
  return queryClient.getQueryData(toolListQuery.queryKey)!;
}

afterEach(() => {
  queryClient.removeQueries({ queryKey: [TOOL_LIST] });
});

describe('the tool list', () => {
  it('stays the same list when a reconnect lists the same tools, so nothing that follows it loads again', async () => {
    const rt = fakeRuntime();
    const first = await listed(rt, [descriptor('market.get_candles'), descriptor('layout.get')]);
    const again = await listed(rt, [descriptor('layout.get'), descriptor('market.get_candles')]);
    expect(again).toBe(first);
    const changed = await listed(rt, [descriptor('layout.get'), descriptor('market.get_candles', 'Candles')]);
    expect(changed).not.toBe(first);
    expect(changed.get('market.get_candles')?.title).toBe('Candles');
    const grown = await listed(rt, [
      descriptor('layout.get'),
      descriptor('market.get_candles', 'Candles'),
      descriptor('x'),
    ]);
    expect(grown).not.toBe(changed);
  });
});
