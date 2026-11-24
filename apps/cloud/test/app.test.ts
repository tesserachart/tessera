import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { accessOf } from '../src/store.ts';
import DESKTOP from './desktop-sign-in.json';
import { store } from '../src/store.ts';
import { database, FakeIdentity, FakeMailer, NOW, reset, testApp } from './support.ts';

const ROOT = { subject: 'idp_root', email: 'root@example.com', emailVerified: true, name: 'Root' };
const ADA = { subject: 'idp_ada', email: 'ada@example.com', emailVerified: true, name: 'Ada' };

let db: D1Database;
let dispose: () => Promise<void>;
let identity: FakeIdentity;
let mailer: FakeMailer;
let app: ReturnType<typeof testApp>;

beforeAll(async () => {
  ({ db, dispose } = await database());
});

afterAll(() => dispose());

beforeEach(async () => {
  await reset(db);
  identity = new FakeIdentity({ 'code-ada': ADA, 'code-root': ROOT });
  mailer = new FakeMailer();
  app = testApp(db, identity, { mailer });
});

function post(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

async function signIn(): Promise<{ access_token: string; refresh_token: string; account: { user: { id: string } } }> {
  const response = await post('/v1/auth/token', { code: 'code-ada', code_verifier: DESKTOP.code_verifier });
  expect(response.status).toBe(200);
  return response.json();
}

describe('desktop sign-in', () => {
  it('sends the browser to the provider with the loopback redirect and the PKCE challenge', async () => {
    const query = new URLSearchParams({
      redirect_uri: 'http://127.0.0.1:52817/auth/callback',
      state: DESKTOP.state,
      code_challenge: DESKTOP.code_challenge,
    });
    const response = await app.request(`/auth/desktop/start?${query.toString()}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://idp.test');
    expect(location.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:52817/auth/callback');
    expect(location.searchParams.get('code_challenge')).toBe(DESKTOP.code_challenge);
  });

  it.each([
    'https://evil.example/auth/callback',
    'http://localhost:52817/auth/callback',
    'http://127.0.0.1:52817/elsewhere',
  ])('refuses a redirect off the loopback callback: %s', async (redirect) => {
    const query = new URLSearchParams({
      redirect_uri: redirect,
      state: DESKTOP.state,
      code_challenge: DESKTOP.code_challenge,
    });
    const response = await app.request(`/auth/desktop/start?${query.toString()}`);
    expect(response.status).toBe(400);
  });

  it('creates the user on the first exchange and returns the session with the account', async () => {
    const session = await signIn();
    expect(session.access_token).toBe('access:idp_ada:session_1');
    expect(session.refresh_token).toBe('refresh:code-ada');
    expect(session.account).toEqual({
      user: { id: expect.stringMatching(/^usr_[0-9a-f]{32}$/) as unknown, email: 'ada@example.com', name: 'Ada' },
      access: 'none',
      entitlements: [],
    });
    const again = await signIn();
    expect(again.account.user.id).toBe(session.account.user.id);
  });

  it('answers 401 when the provider rejects the code', async () => {
    const response = await post('/v1/auth/token', { code: 'used', code_verifier: DESKTOP.code_verifier });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'rejected' });
  });

  it('refreshes with a replacement refresh token', async () => {
    const session = await signIn();
    const response = await post('/v1/auth/refresh', { refresh_token: session.refresh_token });
    expect(response.status).toBe(200);
    const renewed = await response.json<{ access_token: string }>();
    expect(renewed.access_token).toBe('access:idp_ada:session_2');
  });

  it('signs out the provider session named by the token', async () => {
    const session = await signIn();
    const response = await post('/v1/auth/sign-out', {}, session.access_token);
    expect(response.status).toBe(204);
    expect(identity.signedOut).toEqual(['session_1']);
  });
});

describe('/v1', () => {
  it('needs a valid bearer token of a known user', async () => {
    expect((await app.request('/v1/me')).status).toBe(401);
    expect((await app.request('/v1/me', { headers: { authorization: 'Bearer junk' } })).status).toBe(401);
    const stranger = await app.request('/v1/me', { headers: { authorization: 'Bearer access:idp_nobody:s' } });
    expect(stranger.status).toBe(401);
  });

  it('reports access from the entitlements and the application', async () => {
    const { access_token: token, account } = await signIn();
    const me = async () => {
      const response = await app.request('/v1/me', { headers: { authorization: `Bearer ${token}` } });
      return (await response.json<{ access: string }>()).access;
    };

    await db
      .prepare("INSERT INTO applications (user_id, status, created_at) VALUES (?1, 'pending', ?2)")
      .bind(account.user.id, NOW.toISOString())
      .run();
    expect(await me()).toBe('pending');

    await db
      .prepare(
        "INSERT INTO entitlements (user_id, key, source, granted_at) VALUES (?1, 'early_access', 'approval', ?2)",
      )
      .bind(account.user.id, NOW.toISOString())
      .run();
    expect(await me()).toBe('full');
  });

  it('records a check-in per launch', async () => {
    const { access_token: token, account } = await signIn();
    const checkin = { app_version: '0.2.0-alpha.1', platform: 'mac', arch: 'aarch64', channel: 'release' };
    expect((await post('/v1/checkins', checkin, token)).status).toBe(204);
    expect((await post('/v1/checkins', { ...checkin, platform: 'amiga' }, token)).status).toBe(400);
    expect(
      (await post('/v1/checkins', { ...checkin, app_version: '0.1.0-beta.7', channel: 'beta' }, token)).status,
    ).toBe(204);
    const rows = await db.prepare('SELECT user_id, at, app_version, platform, channel FROM checkins ORDER BY id').all();
    expect(rows.results).toEqual([
      {
        user_id: account.user.id,
        at: NOW.toISOString(),
        app_version: '0.2.0-alpha.1',
        platform: 'mac',
        channel: 'release',
      },
      {
        user_id: account.user.id,
        at: NOW.toISOString(),
        app_version: '0.1.0-beta.7',
        platform: 'mac',
        channel: 'release',
      },
    ]);
  });
});

describe('invites', () => {
  async function invited(email: string) {
    const root = await post('/v1/auth/token', { code: 'code-root', code_verifier: DESKTOP.code_verifier });
    const { account } = await root.json<{ account: { user: { id: string } } }>();
    const result = await store(db).invite(email, account.user.id, NOW);
    expect(result.kind).toBe('invite');
  }

  it('gives full access on the first sign-in in the app and sends the approval email', async () => {
    await invited('ada@example.com');
    const session = await signIn();
    expect(session.account).toMatchObject({ access: 'full', entitlements: ['early_access'] });
    expect(mailer.sent.map((email) => email.to)).toEqual(['ada@example.com']);
    await signIn();
    expect(mailer.sent).toHaveLength(1);
  });

  it('gives nothing when the provider has not verified the address', async () => {
    await invited('ada@example.com');
    identity = new FakeIdentity({ 'code-ada': { ...ADA, emailVerified: false }, 'code-root': ROOT });
    app = testApp(db, identity, { mailer });
    const session = await signIn();
    expect(session.account).toMatchObject({ access: 'none', entitlements: [] });
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('accessOf', () => {
  it('lets the early access entitlement win over any application state', () => {
    expect(accessOf(['early_access'], 'declined')).toBe('full');
    expect(accessOf([], 'pending')).toBe('pending');
    expect(accessOf([], 'declined')).toBe('declined');
    expect(accessOf([], 'approved')).toBe('none');
    expect(accessOf([], undefined)).toBe('none');
  });
});
