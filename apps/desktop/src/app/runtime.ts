import type { Bridge } from '@tessera/bridge';
import { createRuntimeClient, EndpointUnavailable, PROTOCOL_VERSION, type RpcEndpoint } from '@tessera/protocol';
import type { AppServices } from './services.ts';

export const APP_VERSION: string = import.meta.env.TESSERA_VERSION ?? '0.1.0';

export const APP_COMMIT: string | null = import.meta.env.TESSERA_COMMIT ?? null;

async function endpointOf(host: Bridge): Promise<RpcEndpoint> {
  try {
    const c = await host.runtimeConnection();
    return { url: c.wsUrl, credential: c.credential, session: c.session };
  } catch (error) {
    if (error instanceof Error && 'problem' in error && typeof error.problem === 'string') {
      throw new EndpointUnavailable({ message: error.message, code: error.problem });
    }
    throw new EndpointUnavailable({
      message: error instanceof Error ? error.message : String(error),
      code: null,
    });
  }
}

export function appServices(host: Bridge): AppServices {
  const client = createRuntimeClient({
    endpoint: () => endpointOf(host),
    hello: {
      client: { name: 'tessera-desktop', version: APP_VERSION, platform: host.kind },
      protocolVersion: PROTOCOL_VERSION,
    },
    gapDetection: 'per-subscription',
    requestTimeoutMs: 20_000,
    backoff: { initialDelayMs: 300, maxDelayMs: 8_000, factor: 2, jitter: 0.5 },
  });
  return { host, client };
}
