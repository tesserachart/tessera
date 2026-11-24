import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { RuntimeRpc } from './runtime.ts';

function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

describe('RuntimeRpc.open', () => {
  it('fails to connect without repeating the token', async () => {
    const token = 'sentinel-token-7c1f';
    const origin = `http://127.0.0.1:${String(await closedPort())}`;
    const error = await RuntimeRpc.open({ origin, token, ticket: null }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(origin);
    expect((error as Error).message).not.toContain(token);
  });
});
