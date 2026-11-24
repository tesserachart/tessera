import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isShareId, shareId } from '../src/shares.ts';
import { store } from '../src/store.ts';
import DESKTOP from './desktop-sign-in.json';
import { database, FakeIdentity, MemoryImages, NOW, reset, testApp } from './support.ts';

const ADA = { subject: 'idp_ada', email: 'ada@example.com', emailVerified: true, name: 'Ada Lovelace' };
const BEA = { subject: 'idp_bea', email: 'bea@example.com', emailVerified: true, name: 'Bea' };

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PNG_BASE64 = btoa(String.fromCharCode(...PNG));

let db: D1Database;
let dispose: () => Promise<void>;
let images: MemoryImages;
let app: ReturnType<typeof testApp>;

beforeAll(async () => {
  ({ db, dispose } = await database());
});

afterAll(() => dispose());

beforeEach(async () => {
  await reset(db);
  images = new MemoryImages();
  app = testApp(db, new FakeIdentity({ 'code-ada': ADA, 'code-bea': BEA }), { shares: images });
});

function call(path: string, method: string, token?: string, body?: unknown) {
  return app.request(`https://account.test${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function signIn(code: string, approved = true): Promise<{ token: string; entitlements: string[] }> {
  const response = await call('/v1/auth/token', 'POST', undefined, { code, code_verifier: DESKTOP.code_verifier });
  const session = await response.json<{ access_token: string; account: { user: { id: string } } }>();
  if (approved) await store(db).approve(session.account.user.id, session.account.user.id, NOW);
  const me = await call('/v1/me', 'GET', session.access_token);
  const account = await me.json<{ entitlements: string[] }>();
  return { token: session.access_token, entitlements: account.entitlements };
}

const chart = {
  kind: 'chart',
  title: 'NQZ6 · 5m',
  image: { type: 'image/png', data: PNG_BASE64 },
  width: 1600,
  height: 900,
};

interface Shared {
  id: string;
  url: string;
  kind: string;
  title: string;
  created_at: string;
}

async function share(token: string, body: unknown = chart): Promise<Shared> {
  const response = await call('/v1/shares', 'POST', token, body);
  expect(response.status).toBe(201);
  return response.json();
}

describe('sharing a chart', () => {
  it('gives a short link whose page shows the chart signed out, with the Tessera mark and no account', async () => {
    const { token } = await signIn('code-ada');
    const shared = await share(token);
    expect(shared.url).toBe(`https://account.test/s/${shared.id}`);
    expect(isShareId(shared.id)).toBe(true);
    expect(shared).toMatchObject({ kind: 'chart', title: 'NQZ6 · 5m', created_at: NOW.toISOString() });

    const page = await app.request(shared.url);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('/assets/wordmark.svg');
    expect(text).toContain(`${shared.url}/image`);
    expect(text).toMatch(/<\/header><main class="shared"><h1>NQZ6 · 5m<\/h1>/);
    for (const secret of ['ada@example.com', 'Ada Lovelace', 'idp_ada', 'Sign out']) expect(text).not.toContain(secret);

    const image = await app.request(`${shared.url}/image`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
  });

  it('keeps the page and the image out of search and caches', async () => {
    const { token } = await signIn('code-ada');
    const shared = await share(token);
    for (const path of [shared.url, `${shared.url}/image`]) {
      const response = await app.request(path);
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect(await (await app.request(shared.url)).text()).toContain('content="noindex, nofollow, noarchive"');
  });

  it('lists only the owner’s own links, newest first', async () => {
    const ada = await signIn('code-ada');
    const bea = await signIn('code-bea');
    const first = await share(ada.token);
    const theirs = await share(bea.token);
    const second = await share(ada.token, { ...chart, title: 'ESZ6 · 1m' });
    const listed = await (await call('/v1/shares', 'GET', ada.token)).json<{ shares: Shared[] }>();
    const ids = listed.shares.map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(ids).not.toContain(theirs.id);
  });

  it('kills the link and the image when the owner deletes it, and only the owner can', async () => {
    const ada = await signIn('code-ada');
    const bea = await signIn('code-bea');
    const shared = await share(ada.token);

    expect((await call(`/v1/shares/${shared.id}`, 'DELETE', bea.token)).status).toBe(404);
    expect((await app.request(shared.url)).status).toBe(200);

    expect((await call(`/v1/shares/${shared.id}`, 'DELETE', ada.token)).status).toBe(204);
    const page = await app.request(shared.url);
    expect(page.status).toBe(404);
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect((await app.request(`${shared.url}/image`)).status).toBe(404);
    expect(images.kept.size).toBe(0);
    expect((await call(`/v1/shares/${shared.id}`, 'DELETE', ada.token)).status).toBe(404);
  });

  it('has no listing anywhere: unknown and malformed links are not found', async () => {
    const { token } = await signIn('code-ada');
    await share(token);
    for (const path of ['/s', '/s/', `/s/${shareId()}`, '/s/..%2Fadmin', '/s/short']) {
      expect((await app.request(`https://account.test${path}`)).status, path).toBe(404);
    }
    expect((await call('/v1/shares', 'GET')).status).toBe(401);
  });

  it('takes a share only signed in, with access, and a real picture', async () => {
    expect((await call('/v1/shares', 'POST', undefined, chart)).status).toBe(401);
    const pending = await signIn('code-bea', false);
    expect((await call('/v1/shares', 'POST', pending.token, chart)).status).toBe(403);
    const { token } = await signIn('code-ada');
    const notPng = { ...chart, image: { type: 'image/png', data: btoa('<svg onload=alert(1)>') } };
    expect((await call('/v1/shares', 'POST', token, notPng)).status).toBe(400);
    expect((await call('/v1/shares', 'POST', token, { ...chart, kind: 'conversation' })).status).toBe(400);
    expect((await call('/v1/shares', 'POST', token, { ...chart, title: '' })).status).toBe(400);
    expect(images.kept.size).toBe(0);
  });

  it('offers sharing only to an approved account on a Cloud with somewhere to keep the pictures', async () => {
    expect((await signIn('code-ada')).entitlements).toContain('share');
    expect((await signIn('code-bea', false)).entitlements).not.toContain('share');

    app = testApp(db, new FakeIdentity({ 'code-ada': ADA }), { shares: null });
    const off = await signIn('code-ada');
    expect(off.entitlements).not.toContain('share');
    expect((await call('/v1/shares', 'POST', off.token, chart)).status).toBe(503);
    expect(await (await call('/v1/shares', 'GET', off.token)).json()).toEqual({ shares: [] });
  });

  it('makes ids that are short, unguessable and url-safe', () => {
    const ids = new Set(Array.from({ length: 2000 }, shareId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(isShareId(id)).toBe(true);
  });
});
