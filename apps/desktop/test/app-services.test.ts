import { HostError, RuntimeUnavailable, type Bridge } from '@tessera/bridge';
import { describe, expect, it, vi } from 'vitest';
import { appServices } from '../src/app/runtime.ts';

function hostFailing(error: RuntimeUnavailable | HostError): Bridge {
  return { kind: 'browser', window: null, runtimeConnection: () => Promise.reject(error) } as unknown as Bridge;
}

async function firstFailure(host: Bridge) {
  const { client } = appServices(host);
  try {
    return await vi.waitFor(() => {
      const s = client.state.getSnapshot();
      if (s.lastError === null) throw new Error('no attempt yet');
      return { error: s.lastError, code: s.lastErrorCode };
    });
  } finally {
    client.close();
  }
}

describe('the app’s services', () => {
  it('tell the splash why the host has no runtime to connect to, by its code', async () => {
    const starting = await firstFailure(
      hostFailing(new RuntimeUnavailable({ problem: 'runtime_starting', message: 'building the runtime' })),
    );
    expect(starting).toMatchObject({ code: 'runtime_starting' });
    expect(starting.error).toContain('building the runtime');
    const host = await firstFailure(
      hostFailing(new HostError({ operation: 'runtime', reason: new Error('no sidecar') })),
    );
    expect(host.code).toBeNull();
    expect(host.error).toContain('no sidecar');
  });
});
