import { QueryObserver } from '@tanstack/react-query';
import type { ProviderHealth } from '@tessera/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthStore, onMarketServed } from '../src/app/health.ts';
import { retrying } from '../src/app/lifetime.ts';
import { queryClient, TOOL_READS } from '../src/app/queries.ts';
import { HANG_GUARD_MS } from '../../../vitest.hang-guards.ts';
import { cleanupsAfterEach } from './support/cleanups.ts';
import { providerHealth } from './support/providers.ts';
import { runtimeLink, type RuntimeLink } from './support/runtimeLink.ts';

let link: RuntimeLink | null = null;
afterEach(() => {
  link?.client.close();
  link = null;
});
const stops = cleanupsAfterEach();

function apex(status: ProviderHealth['status']): ProviderHealth {
  return providerHealth({ providerId: 'rithmic-apex', displayName: 'Apex', status });
}

const health = (providers: ProviderHealth[], pricesDown: string[]) =>
  link!.publish('health', { providers, pricesDown });

async function until(done: () => boolean, what: string): Promise<void> {
  await vi.waitFor(() => {
    if (!done()) throw new Error(`still waiting until ${what}`);
  });
}

describe('a market connection that starts serving', () => {
  it('asks again for what was refused while no connection served it, and only then', async () => {
    link = runtimeLink({});
    await link.open();
    let served = false;
    let asked = 0;
    const queryKey = [TOOL_READS, 'market.get_contract_spec', 'MGCZ6.COMEX'];
    const untouched = () => expect(queryClient.getQueryState(queryKey)?.fetchStatus).toBe('idle');
    const healthTaken = async (publish: () => Promise<void>) => {
      const before = healthStore.getState();
      await publish();
      await vi.waitFor(() => expect(healthStore.getState()).not.toBe(before));
    };
    const spec = new QueryObserver(queryClient, {
      queryKey,
      queryFn: () => {
        asked += 1;
        if (!served) return Promise.reject(new Error('unavailable: no market-data connection is configured'));
        return Promise.resolve({ instrument: 'MGCZ6.COMEX' });
      },
    });
    stops.push(spec.subscribe(() => undefined));
    await until(() => spec.getCurrentResult().status === 'error', 'the read is refused');

    await healthTaken(() => health([apex('unknown')], ['rithmic-apex']));
    untouched();
    expect(asked).toBe(1);

    served = true;
    await health([apex('ok')], []);
    await until(() => spec.getCurrentResult().status === 'success', 'the read is asked again');
    expect(asked).toBe(2);
    expect(spec.getCurrentResult().data).toEqual({ instrument: 'MGCZ6.COMEX' });

    await healthTaken(() => health([apex('ok')], []));
    untouched();
    expect(asked).toBe(2);
  });

  it('wakes a market read waiting out its backoff', async () => {
    link = runtimeLink({});
    await link.open();
    let served = false;
    const longerThanTheTest = 2 * HANG_GUARD_MS;
    const read = retrying(
      () => (served ? Promise.resolve('bars') : Promise.reject(new Error('unavailable: connecting to Rithmic'))),
      {
        again: () => true,
        backoff: { initialDelayMs: longerThanTheTest, maxDelayMs: longerThanTheTest, factor: 1, jitter: 0 },
        wake: onMarketServed,
      },
    );
    await health([apex('unknown')], ['rithmic-apex']);
    served = true;
    await health([apex('ok')], []);
    await expect(read).resolves.toBe('bars');
  });
});
