import { base64url, errors as joseErrors } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdentityRejected } from '../src/identity.ts';
import { workos } from '../src/workos.ts';

const CONFIG = { clientId: 'client_123', apiKey: 'sk_test' };

function answering(status: number, body: unknown) {
  const requests: { url: string; body: unknown }[] = [];
  const fetcher = (input: string, init: { body: string }) => {
    requests.push({ url: input, body: JSON.parse(init.body) });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { requests, fetcher: fetcher as unknown as typeof fetch };
}

describe('workos', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the AuthKit authorize URL with PKCE', () => {
    const url = new URL(
      workos(CONFIG).authorizeUrl({
        redirectUri: 'http://127.0.0.1:5000/auth/callback',
        state: 'state',
        codeChallenge: 'challenge',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://api.workos.com/user_management/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client_123',
      provider: 'authkit',
      redirect_uri: 'http://127.0.0.1:5000/auth/callback',
      state: 'state',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    });
  });

  it('prefills the email field with a login hint', () => {
    const url = new URL(
      workos(CONFIG).authorizeUrl({
        redirectUri: 'https://account.example/auth/callback',
        state: 'state',
        loginHint: 'ada@example.com',
      }),
    );
    expect(url.searchParams.get('login_hint')).toBe('ada@example.com');
  });

  it('exchanges a code with the secret and the verifier', async () => {
    const { requests, fetcher } = answering(200, {
      user: { id: 'user_1', email: 'ada@example.com', email_verified: true, first_name: 'Ada', last_name: null },
      access_token: 'at',
      refresh_token: 'rt',
    });
    const tokens = await workos(CONFIG, fetcher).exchange('code', 'verifier');
    expect(requests[0]).toEqual({
      url: 'https://api.workos.com/user_management/authenticate',
      body: {
        client_id: 'client_123',
        client_secret: 'sk_test',
        grant_type: 'authorization_code',
        code: 'code',
        code_verifier: 'verifier',
      },
    });
    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      profile: { subject: 'user_1', email: 'ada@example.com', emailVerified: true, name: 'Ada' },
    });
  });

  it('reports an email the provider has not verified as unverified', async () => {
    const { fetcher } = answering(200, {
      user: { id: 'user_2', email: 'grace@example.com', email_verified: false },
      access_token: 'at',
      refresh_token: 'rt',
    });
    const tokens = await workos(CONFIG, fetcher).refresh('rt');
    expect(tokens.profile).toEqual({ subject: 'user_2', email: 'grace@example.com', emailVerified: false, name: null });
  });

  it('turns an invalid grant into a rejection and a server error into an outage', async () => {
    const rejected = workos(CONFIG, answering(400, { error: 'invalid_grant' }).fetcher).refresh('rt');
    await expect(rejected).rejects.toBeInstanceOf(IdentityRejected);
    const outage = workos(CONFIG, answering(503, {}).fetcher).refresh('rt');
    await expect(outage).rejects.not.toBeInstanceOf(IdentityRejected);
  });

  it('rejects a malformed access token but treats a key set that times out as an outage', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    const identity = workos({ ...CONFIG, clientId: 'client_jwks_timeout' });
    await expect(identity.verify('not-a-token')).rejects.toBeInstanceOf(IdentityRejected);
    const token = [{ alg: 'RS256', kid: 'key_1' }, { sub: 'user_1', sid: 'session_1', exp: 0 }, 'signature']
      .map((part) => base64url.encode(JSON.stringify(part)))
      .join('.');
    await expect(identity.verify(token)).rejects.toBeInstanceOf(joseErrors.JWKSTimeout);
  });
});
