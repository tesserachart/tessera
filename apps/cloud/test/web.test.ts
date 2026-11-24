import { firstOpenText, MAC_FIRST_OPEN, WINDOWS_FIRST_OPEN } from '@tessera/ui/first-open';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { database, FakeIdentity, FakeMailer, NOW, reset, SITE, testApp, UPDATES } from './support.ts';

const ORIGIN = 'https://cloud.test';
const ADA = { subject: 'idp_ada', email: 'ada@example.com', emailVerified: true, name: 'Ada Lovelace' };
const ROOT = { subject: 'idp_root', email: 'root@example.com', emailVerified: true, name: 'Root' };
const GRACE = { subject: 'idp_grace', email: 'grace@example.com', emailVerified: true, name: 'Grace Hopper' };
const NONAME = { subject: 'idp_noname', email: 'quiet@example.com', emailVerified: true, name: null };

let db: D1Database;
let dispose: () => Promise<void>;
let identity: FakeIdentity;
let mailer: FakeMailer;
let clock: { at: Date };
let app: ReturnType<typeof testApp>;

beforeAll(async () => {
  ({ db, dispose } = await database());
});

afterAll(() => dispose());

beforeEach(async () => {
  await reset(db);
  identity = new FakeIdentity({
    'code-ada': ADA,
    'code-root': ROOT,
    'code-noname': NONAME,
    'code-grace': GRACE,
    'code-grace-unverified': { ...GRACE, emailVerified: false },
    'code-grace-shouting': { ...GRACE, email: 'Grace@Example.com' },
    'code-eve': { subject: 'idp_eve', email: 'eve@example.com', emailVerified: true, name: 'Eve' },
  });
  mailer = new FakeMailer();
  clock = { at: NOW };
  app = testApp(db, identity, { mailer, clock });
});

class Browser {
  readonly cookies = new Map<string, string>();
  readonly attributes = new Map<string, string>();

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    const response = await app.request(`${ORIGIN}${path}`, { ...init, headers });
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      this.attributes.set(name, attributes.join('; '));
      if (attributes.some((a) => a.toLowerCase() === 'max-age=0')) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  get(path: string) {
    return this.request(path);
  }

  post(path: string, form: Record<string, string>, origin = ORIGIN) {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: new URLSearchParams(form).toString(),
    });
  }

  async signIn(code: string, path = '/apply') {
    const start = await this.get(path);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const back = await this.get(`/auth/callback?code=${code}&state=${state}`);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(path);
  }

  async csrf(path = '/apply'): Promise<string> {
    const html = await (await this.get(path)).text();
    const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(token).toBeDefined();
    return token!;
  }
}

const ANSWERS = { propFirm: 'Apex', platform: 'mac', trading: 'NQ off the footprint, a few trades a day' };

async function apply(browser: Browser, answers: Record<string, string> = ANSWERS) {
  const response = await browser.post('/apply', { csrf: await browser.csrf(), ...answers });
  expect(response.status).toBe(303);
}

async function admin(): Promise<Browser> {
  const browser = new Browser();
  await browser.signIn('code-root');
  await db.prepare("UPDATE users SET role = 'admin' WHERE email = ?1").bind(ROOT.email).run();
  return browser;
}

async function userId(email: string): Promise<string> {
  const row = await db.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first<{ id: string }>();
  return row!.id;
}

describe('sign-in', () => {
  it('sends a signed-out visitor to the provider, then back with a session cookie', async () => {
    const browser = new Browser();
    const start = await browser.get('/apply');
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location')!);
    expect(location.origin).toBe('https://idp.test');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
    expect(location.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
    expect(location.searchParams.has('code_challenge')).toBe(false);
    expect(browser.attributes.get('__Host-tessera_login')).toMatch(/HttpOnly; Secure; SameSite=Lax/);

    const back = await browser.get(`/auth/callback?code=code-ada&state=${location.searchParams.get('state')!}`);
    expect(back.status).toBe(303);
    expect(browser.cookies.has('__Host-tessera_login')).toBe(false);
    expect(browser.attributes.get('__Host-tessera_session')).toMatch(/Path=\/; HttpOnly; Secure; SameSite=Lax/);
    expect((await browser.get('/apply')).status).toBe(200);
  });

  it('refuses a callback whose state is not the one it sent, or that comes twice', async () => {
    const browser = new Browser();
    const start = await browser.get('/apply');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    expect((await browser.get(`/auth/callback?code=code-ada&state=${'x'.repeat(43)}`)).status).toBe(400);
    expect((await browser.get(`/auth/callback?code=code-ada&state=${state}`)).status).toBe(400);
    expect((await new Browser().get(`/auth/callback?code=code-ada&state=${state}`)).status).toBe(400);
    expect(browser.cookies.has('__Host-tessera_session')).toBe(false);
  });

  it('says sign-in did not finish when the provider rejects the code', async () => {
    const browser = new Browser();
    const start = await browser.get('/apply');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const back = await browser.get(`/auth/callback?code=used&state=${state}`);
    expect(back.status).toBe(400);
    expect(await back.text()).toContain('Sign-in didn&#39;t finish.');
  });

  it('treats a changed, foreign or expired session cookie as signed out', async () => {
    const browser = new Browser();
    await browser.signIn('code-ada');
    const sealed = browser.cookies.get('__Host-tessera_session')!;

    const flipped = sealed.slice(0, -5) + (sealed.at(-5) === 'A' ? 'B' : 'A') + sealed.slice(-4);
    browser.cookies.set('__Host-tessera_session', flipped);
    expect((await browser.get('/apply')).status).toBe(302);

    const other = new Browser();
    await other.get('/apply');
    browser.cookies.set('__Host-tessera_session', other.cookies.get('__Host-tessera_login')!);
    expect((await browser.get('/apply')).status).toBe(302);

    const elsewhere = new Browser();
    const foreign = testApp(db, identity, { secret: 'another-secret-another-secret-0000' });
    const start = await foreign.request(`${ORIGIN}/apply`);
    const login = /__Host-tessera_login=([^;]+)/.exec(start.headers.get('set-cookie')!)![1]!;
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const back = await foreign.request(`${ORIGIN}/auth/callback?code=code-ada&state=${state}`, {
      headers: { cookie: `__Host-tessera_login=${login}` },
    });
    elsewhere.cookies.set(
      '__Host-tessera_session',
      /__Host-tessera_session=([^;]+)/.exec(back.headers.get('set-cookie')!)![1]!,
    );
    expect((await elsewhere.get('/apply')).status).toBe(302);

    browser.cookies.set('__Host-tessera_session', sealed);
    expect((await browser.get('/apply')).status).toBe(200);
    clock.at = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect((await browser.get('/apply')).status).toBe(302);
  });

  it('signs out at the provider and drops the cookie', async () => {
    const browser = new Browser();
    await browser.signIn('code-ada');
    const response = await browser.post('/auth/sign-out', { csrf: await browser.csrf() });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(SITE);
    expect(identity.signedOut).toEqual(['session_1']);
    expect(browser.cookies.has('__Host-tessera_session')).toBe(false);
  });
});

describe('/apply', () => {
  it('files a pending application, shows it, and lets it change while it waits', async () => {
    const browser = new Browser();
    await browser.signIn('code-ada');
    const form = await (await browser.get('/apply')).text();
    expect(form).toContain('Request access');
    expect(form).not.toContain('name="name"');

    await apply(browser);
    const row = await db.prepare('SELECT prop_firm, platform, trading, status FROM applications').first();
    expect(row).toEqual({ prop_firm: 'Apex', platform: 'mac', trading: ANSWERS.trading, status: 'pending' });

    const waiting = await (await browser.get('/apply')).text();
    expect(waiting).toContain('You&#39;re on the list.');
    expect(waiting).toContain('ada@example.com');

    expect(await (await browser.get('/apply?edit')).text()).toContain('value="Apex"');
    await apply(browser, { ...ANSWERS, propFirm: 'Topstep', platform: 'linux' });
    const changed = await db.prepare('SELECT prop_firm, platform, status FROM applications').first();
    expect(changed).toEqual({ prop_firm: 'Topstep', platform: 'linux', status: 'pending' });
  });

  it('answers a form with gaps with the form and what is missing', async () => {
    const browser = new Browser();
    await browser.signIn('code-ada');
    const response = await browser.post('/apply', { csrf: await browser.csrf(), propFirm: ' ', trading: 'Scalps' });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Tell us your prop firm.');
    expect(html).toContain('Pick where you will run Tessera.');
    expect(html).toContain('value="Scalps"');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM applications').first('n')).toBe(0);
  });

  it('asks for a name only when the provider gave none, and keeps it', async () => {
    const browser = new Browser();
    await browser.signIn('code-noname');
    expect(await (await browser.get('/apply')).text()).toContain('name="name"');
    await apply(browser, { ...ANSWERS, name: 'Grace Hopper' });
    expect(await db.prepare('SELECT name FROM users WHERE email = ?1').bind(NONAME.email).first('name')).toBe(
      'Grace Hopper',
    );
    await new Browser().signIn('code-noname');
    expect(await db.prepare('SELECT name FROM users WHERE email = ?1').bind(NONAME.email).first('name')).toBe(
      'Grace Hopper',
    );
  });

  it('escapes what applicants write', async () => {
    const browser = new Browser();
    await browser.signIn('code-ada');
    await apply(browser, { ...ANSWERS, trading: '<script>alert(1)</script>' });
    const html = await (await browser.get('/apply')).text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('serves pages that run no scripts, are not cached and keep their forms’ Origin', async () => {
    const browser = new Browser();
    await browser.signIn('code-ada');
    const response = await browser.get('/apply');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
  });
});

describe('forms', () => {
  it('refuse a POST without the session form token, with a wrong one, or from another origin', async () => {
    const browser = new Browser();
    await browser.signIn('code-ada');
    const csrf = await browser.csrf();
    expect((await browser.post('/apply', ANSWERS)).status).toBe(403);
    expect(
      (await browser.post('/apply', { ...ANSWERS, csrf: csrf.replace(/^./, csrf.startsWith('a') ? 'b' : 'a') })).status,
    ).toBe(403);
    expect((await browser.post('/apply', { ...ANSWERS, csrf }, 'https://evil.example')).status).toBe(403);

    const other = new Browser();
    await other.signIn('code-root');
    expect((await browser.post('/apply', { ...ANSWERS, csrf: await other.csrf() })).status).toBe(403);
    expect((await new Browser().post('/apply', { ...ANSWERS, csrf })).status).toBe(403);

    expect(await db.prepare('SELECT COUNT(*) AS n FROM applications').first('n')).toBe(0);
    expect((await browser.post('/apply', { ...ANSWERS, csrf })).status).toBe(303);
  });
});

describe('/admin', () => {
  it('is for admins only', async () => {
    const stranger = new Browser();
    const start = await stranger.get('/admin');
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get('location')!).origin).toBe('https://idp.test');

    const member = new Browser();
    await member.signIn('code-ada', '/admin');
    expect((await member.get('/admin')).status).toBe(403);
    const id = await userId(ADA.email);
    expect((await member.post(`/admin/users/${id}/approve`, { csrf: await member.csrf() })).status).toBe(403);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM entitlements').first('n')).toBe(0);
  });

  it('lists applicants newest first with their app’s last check-in, filtered by status', async () => {
    const root = await admin();
    clock.at = new Date(NOW.getTime() + 60_000);
    const ada = new Browser();
    await ada.signIn('code-ada');
    await apply(ada);
    await db
      .prepare(
        `INSERT INTO checkins (user_id, at, app_version, platform, arch, channel)
         VALUES (?1, '2026-10-17T09:30:00.000Z', '0.2.0-alpha.1', 'mac', 'aarch64', 'release')`,
      )
      .bind(await userId(ADA.email))
      .run();

    const all = await (await root.get('/admin')).text();
    expect(all).toContain('Ada Lovelace');
    expect(all).toContain('ada@example.com');
    expect(all).toContain('Apex');
    expect(all).toContain('17 Oct, 09:30 UTC');
    expect(all).toContain('0.2.0-alpha.1 · mac · release');
    const rows = all.slice(all.indexOf('<tbody>'));
    expect(rows.indexOf('Ada Lovelace')).toBeLessThan(rows.indexOf('root@example.com'));

    expect(await (await root.get('/admin?status=pending')).text()).toContain('Ada Lovelace');
    expect(await (await root.get('/admin?status=approved')).text()).not.toContain('Ada Lovelace');
  });

  it('approves: grants early access, marks the application and emails the download once', async () => {
    const ada = new Browser();
    await ada.signIn('code-ada');
    await apply(ada);
    const root = await admin();
    const id = await userId(ADA.email);
    const csrf = await root.csrf('/admin');

    const response = await root.post(`/admin/users/${id}/approve`, { csrf, back: 'pending' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin?status=pending');

    expect(await db.prepare('SELECT key, source FROM entitlements WHERE user_id = ?1').bind(id).all()).toMatchObject({
      results: [{ key: 'early_access', source: 'approval' }],
    });
    const application = await db
      .prepare('SELECT status, decided_by, approval_email FROM applications WHERE user_id = ?1')
      .bind(id)
      .first();
    expect(application).toEqual({ status: 'approved', decided_by: await userId(ROOT.email), approval_email: 'sent' });

    expect(mailer.sent).toHaveLength(1);
    const email = mailer.sent[0]!;
    expect(email.to).toBe('ada@example.com');
    expect(email.text).toContain(`${UPDATES}/mac/Tessera-latest-mac-arm64.dmg`);
    expect(email.text).toContain(firstOpenText(MAC_FIRST_OPEN));
    expect(email.html).toContain('<li style="margin:0 0 6px">Open Tessera from Applications.');
    expect(email.text).toContain('sign in with ada@example.com');
    expect(email.html).toContain(`href="${UPDATES}/mac/Tessera-latest-mac-arm64.dmg"`);

    await root.post(`/admin/users/${id}/approve`, { csrf });
    expect(mailer.sent).toHaveLength(1);

    const page = await (await ada.get('/apply')).text();
    expect(page).toContain('You&#39;re in.');
    expect(page).toContain(`${UPDATES}/mac/Tessera-latest-mac-arm64.dmg`);
    expect(page).toContain(`<li>${MAC_FIRST_OPEN.steps[0]!}</li>`);
    expect(await (await root.get('/admin')).text()).toContain('Emailed 17 Oct 2026');
  });

  it('names the platform an approved applicant asked for when it has no build yet', async () => {
    const ada = new Browser();
    await ada.signIn('code-ada');
    await apply(ada, { ...ANSWERS, platform: 'linux' });
    const root = await admin();
    await root.post(`/admin/users/${await userId(ADA.email)}/approve`, { csrf: await root.csrf('/admin') });
    expect(mailer.sent[0]!.text).toContain('Tessera for Linux is not out yet.');
    expect(mailer.sent[0]!.text).toContain(firstOpenText(MAC_FIRST_OPEN));
    expect(await (await ada.get('/apply')).text()).toContain('Tessera for Linux is not out yet.');
  });

  it('puts the platform an approved applicant asked for first, with its first-run steps', async () => {
    const ada = new Browser();
    await ada.signIn('code-ada');
    await apply(ada, { ...ANSWERS, platform: 'windows' });
    const root = await admin();
    await root.post(`/admin/users/${await userId(ADA.email)}/approve`, { csrf: await root.csrf('/admin') });
    const windows = `${UPDATES}/windows/Tessera-latest-windows-x64-setup.exe`;
    const mac = `${UPDATES}/mac/Tessera-latest-mac-arm64.dmg`;
    const { text } = mailer.sent[0]!;
    expect(text.indexOf(windows)).toBeGreaterThan(0);
    expect(text.indexOf(windows)).toBeLessThan(text.indexOf(mac));
    expect(text).toContain(firstOpenText(WINDOWS_FIRST_OPEN));
    expect(text).toContain('More info, then Run anyway');
    expect(text).not.toContain(firstOpenText(MAC_FIRST_OPEN));
    const page = await (await ada.get('/apply')).text();
    expect(page.indexOf(windows)).toBeLessThan(page.indexOf(mac));
    expect(page).not.toContain(MAC_FIRST_OPEN.steps[0]!);
  });

  it('keeps an approval whose email failed, says so and resends it once', async () => {
    const ada = new Browser();
    await ada.signIn('code-ada');
    await apply(ada);
    const root = await admin();
    const id = await userId(ADA.email);
    const csrf = await root.csrf('/admin');

    mailer.failWith = 'E_DELIVERY_FAILED';
    expect((await root.post(`/admin/users/${id}/approve`, { csrf })).status).toBe(303);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM entitlements WHERE user_id = ?1').bind(id).first('n')).toBe(1);
    const failed = await (await root.get('/admin')).text();
    expect(failed).toContain('Email failed: E_DELIVERY_FAILED');
    expect(failed).toContain(`action="/admin/users/${id}/resend"`);

    mailer.failWith = null;
    expect((await root.post(`/admin/users/${id}/resend`, { csrf })).status).toBe(303);
    expect(mailer.sent).toHaveLength(1);
    await root.post(`/admin/users/${id}/resend`, { csrf });
    expect(mailer.sent).toHaveLength(1);
    const sent = await (await root.get('/admin')).text();
    expect(sent).toContain('Emailed 17 Oct 2026');
    expect(sent).not.toContain('/resend"');
  });

  it('declines without an email, and the applicant sees it', async () => {
    const ada = new Browser();
    await ada.signIn('code-ada');
    await apply(ada);
    const root = await admin();
    const id = await userId(ADA.email);
    expect((await root.post(`/admin/users/${id}/decline`, { csrf: await root.csrf('/admin') })).status).toBe(303);

    expect(await db.prepare('SELECT status FROM applications WHERE user_id = ?1').bind(id).first('status')).toBe(
      'declined',
    );
    expect(await db.prepare('SELECT COUNT(*) AS n FROM entitlements').first('n')).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    expect(await (await ada.get('/apply')).text()).toContain('Not this time.');
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await ada.get('/apply')).text())![1]!;
    expect((await ada.post('/apply', { ...ANSWERS, csrf })).status).toBe(303);
    expect(await db.prepare('SELECT status FROM applications WHERE user_id = ?1').bind(id).first('status')).toBe(
      'declined',
    );
  });

  it('does not decline someone who already has access', async () => {
    const ada = new Browser();
    await ada.signIn('code-ada');
    await apply(ada);
    const root = await admin();
    const id = await userId(ADA.email);
    const csrf = await root.csrf('/admin');
    await root.post(`/admin/users/${id}/approve`, { csrf });
    await root.post(`/admin/users/${id}/decline`, { csrf });
    expect(await db.prepare('SELECT status FROM applications WHERE user_id = ?1').bind(id).first('status')).toBe(
      'approved',
    );
  });
});

describe('invites', () => {
  const TOKEN = /^[\w-]{43}$/;

  async function invite(root: Browser, email: string, csrf?: string): Promise<Response> {
    return root.post('/admin/invites', { csrf: csrf ?? (await root.csrf('/admin')), email });
  }

  async function tokenOf(email: string): Promise<string> {
    const row = await db
      .prepare('SELECT id FROM invites WHERE email = ?1 AND used_at IS NULL AND revoked_at IS NULL')
      .bind(email)
      .first<{ id: string }>();
    return row!.id;
  }

  async function openLink(browser: Browser, token: string, code: string): Promise<string> {
    const start = await browser.get(`/invite/${token}`);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location')!);
    const back = await browser.get(`/auth/callback?code=${code}&state=${location.searchParams.get('state')!}`);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`/invite/${token}`);
    return location.searchParams.get('login_hint')!;
  }

  async function access(email: string) {
    const id = await userId(email);
    return {
      entitlements: (await db.prepare('SELECT key, source FROM entitlements WHERE user_id = ?1').bind(id).all())
        .results,
      application: await db
        .prepare('SELECT status, decided_by, approval_email FROM applications WHERE user_id = ?1')
        .bind(id)
        .first(),
    };
  }

  it('gives the invited person access at sign-in and lands them on the download', async () => {
    const root = await admin();
    const csrf = await root.csrf('/admin');
    const created = await invite(root, 'Grace@Example.com', csrf);
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/admin');
    const token = await tokenOf('grace@example.com');
    expect(token).toMatch(TOKEN);

    const listed = await (await root.get('/admin')).text();
    expect(listed).toContain('Waiting to sign in');
    expect(listed).toContain('grace@example.com');
    expect(listed).toContain(`value="${ORIGIN}/invite/${token}"`);
    expect(listed).toContain('Invited 17 Oct 2026');

    const grace = new Browser();
    expect(await openLink(grace, token, 'code-grace')).toBe('grace@example.com');
    const landing = await grace.get(`/invite/${token}`);
    expect(landing.status).toBe(303);
    expect(landing.headers.get('location')).toBe('/apply');
    const page = await (await grace.get('/apply')).text();
    expect(page).toContain('You&#39;re in.');
    expect(page).toContain(`${UPDATES}/mac/Tessera-latest-mac-arm64.dmg`);

    expect(await access(GRACE.email)).toEqual({
      entitlements: [{ key: 'early_access', source: 'invite' }],
      application: { status: 'approved', decided_by: await userId(ROOT.email), approval_email: 'sent' },
    });
    expect(mailer.sent.map((email) => email.to)).toEqual(['grace@example.com']);

    const after = await (await root.get('/admin')).text();
    expect(after).not.toContain('Waiting to sign in');
    expect(after).toContain('Invited 17 Oct 2026');
    expect(after).not.toContain('Approved 17 Oct 2026');

    await new Browser().signIn('code-grace');
    expect(mailer.sent).toHaveLength(1);
  });

  it('matches the invited address whatever case the provider reports it in', async () => {
    const root = await admin();
    await invite(root, 'grace@example.com');
    const grace = new Browser();
    await openLink(grace, await tokenOf('grace@example.com'), 'code-grace-shouting');
    expect((await access('Grace@Example.com')).entitlements).toHaveLength(1);
  });

  it('gives nothing to someone else who opens the link, and keeps the invite for its person', async () => {
    const root = await admin();
    await invite(root, 'grace@example.com');
    const token = await tokenOf('grace@example.com');

    const ada = new Browser();
    await ada.signIn('code-ada');
    const refused = await ada.get(`/invite/${token}`);
    expect(refused.status).toBe(403);
    const html = await refused.text();
    expect(html).toContain('This invite is for grace@example.com.');
    expect(html).toContain('You&#39;re signed in as ada@example.com.');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM entitlements').first('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM applications').first('n')).toBe(0);
    expect(await tokenOf('grace@example.com')).toBe(token);

    const grace = new Browser();
    await openLink(grace, token, 'code-grace');
    expect((await access(GRACE.email)).entitlements).toEqual([{ key: 'early_access', source: 'invite' }]);
    expect((await ada.get('/apply')).status).toBe(200);
    expect(await (await ada.get(`/invite/${token}`)).text()).toContain('This invite is for grace@example.com.');
    expect((await access(ADA.email)).entitlements).toEqual([]);
  });

  it('never claims on an email the provider has not verified', async () => {
    const root = await admin();
    await invite(root, 'grace@example.com');
    const token = await tokenOf('grace@example.com');

    const grace = new Browser();
    await openLink(grace, token, 'code-grace-unverified');
    expect((await grace.get(`/invite/${token}`)).status).toBe(303);
    expect(await access(GRACE.email)).toEqual({ entitlements: [], application: null });
    expect(await (await grace.get('/apply')).text()).toContain('Request access');
    expect(mailer.sent).toHaveLength(0);
    expect(await tokenOf('grace@example.com')).toBe(token);

    await new Browser().signIn('code-grace');
    expect((await access(GRACE.email)).entitlements).toEqual([{ key: 'early_access', source: 'invite' }]);
  });

  it('leaves a pending application pending even when its address has an open invite', async () => {
    const root = await admin();
    await invite(root, 'grace@example.com');
    const token = await tokenOf('grace@example.com');

    const grace = new Browser();
    await openLink(grace, token, 'code-grace-unverified');
    await apply(grace);
    await new Browser().signIn('code-grace');

    expect(await access(GRACE.email)).toEqual({
      entitlements: [],
      application: { status: 'pending', decided_by: null, approval_email: null },
    });
    expect(mailer.sent).toHaveLength(0);
    expect(await tokenOf('grace@example.com')).toBe(token);
  });

  it('refuses to invite someone who already has an account, and changes nothing for them', async () => {
    const ada = new Browser();
    await ada.signIn('code-ada');
    await apply(ada);
    const root = await admin();
    const csrf = await root.csrf('/admin');

    const refused = await invite(root, ' ADA@example.com ', csrf);
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain('ada@example.com already has an account. Approve them in the list below.');
    expect(html).toContain('value=" ADA@example.com "');
    expect(await access(ADA.email)).toEqual({
      entitlements: [],
      application: { status: 'pending', decided_by: null, approval_email: null },
    });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM invites').first('n')).toBe(0);
    expect(mailer.sent).toHaveLength(0);

    await invite(root, 'grace@example.com', csrf);
    await openLink(new Browser(), await tokenOf('grace@example.com'), 'code-grace');
    expect((await access(ADA.email)).application).toMatchObject({ status: 'pending' });
    expect((await access(ADA.email)).entitlements).toEqual([]);

    await root.post(`/admin/users/${await userId(ADA.email)}/approve`, { csrf });
    const again = await invite(root, 'ada@example.com', csrf);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('ada@example.com already has access.');
  });

  it('answers the same invite and link when the same address is invited twice', async () => {
    const root = await admin();
    const csrf = await root.csrf('/admin');
    expect((await invite(root, 'grace@example.com', csrf)).status).toBe(303);
    const token = await tokenOf('grace@example.com');
    expect((await invite(root, '  Grace@EXAMPLE.com', csrf)).status).toBe(303);
    expect((await invite(root, 'grace@example.com', csrf)).status).toBe(303);

    expect(await db.prepare('SELECT COUNT(*) AS n FROM invites').first('n')).toBe(1);
    expect(await tokenOf('grace@example.com')).toBe(token);
    const html = await (await root.get('/admin')).text();
    expect(html.split(`/invite/${token}`)).toHaveLength(2);
  });

  it('withdraws an invite that has not been used, and a used one stays used', async () => {
    const root = await admin();
    const csrf = await root.csrf('/admin');
    await invite(root, 'grace@example.com', csrf);
    await invite(root, 'eve@example.com', csrf);
    const withdrawn = await tokenOf('grace@example.com');
    const spent = await tokenOf('eve@example.com');
    await openLink(new Browser(), spent, 'code-eve');

    const revoke = await root.post(`/admin/invites/${withdrawn}/revoke`, { csrf, back: 'pending' });
    expect(revoke.status).toBe(303);
    expect(revoke.headers.get('location')).toBe('/admin?status=pending');
    await root.post(`/admin/invites/${spent}/revoke`, { csrf });

    const link = await new Browser().get(`/invite/${withdrawn}`);
    expect(link.status).toBe(404);
    expect(await link.text()).toContain('This invite was withdrawn.');
    expect(await (await root.get('/admin')).text()).not.toContain('Waiting to sign in');

    const grace = new Browser();
    await grace.signIn('code-grace');
    expect(await access(GRACE.email)).toEqual({ entitlements: [], application: null });
    expect(await (await grace.get('/apply')).text()).toContain('Request access');

    const eve = await db
      .prepare('SELECT used_by, revoked_at FROM invites WHERE id = ?1')
      .bind(spent)
      .first<{ used_by: string | null; revoked_at: string | null }>();
    expect(eve).toEqual({ used_by: await userId('eve@example.com'), revoked_at: null });
    expect((await access('eve@example.com')).entitlements).toEqual([{ key: 'early_access', source: 'invite' }]);
  });

  it('says a link that is wrong or unknown does not work', async () => {
    for (const path of ['/invite/short', `/invite/${'a'.repeat(43)}`, `/invite/${'a'.repeat(44)}`]) {
      const response = await new Browser().get(path);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain('This invite doesn&#39;t work.');
    }
  });

  it('is for admins only, and needs the form token', async () => {
    const root = await admin();
    await invite(root, 'grace@example.com');
    const token = await tokenOf('grace@example.com');

    const member = new Browser();
    await member.signIn('code-ada');
    const csrf = await member.csrf();
    expect((await member.post('/admin/invites', { csrf, email: 'eve@example.com' })).status).toBe(403);
    expect((await member.post(`/admin/invites/${token}/revoke`, { csrf })).status).toBe(403);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM invites').first('n')).toBe(1);
    expect(await tokenOf('grace@example.com')).toBe(token);

    expect((await root.post('/admin/invites', { email: 'eve@example.com' })).status).toBe(403);
    expect((await root.post(`/admin/invites/${token}/revoke`, {})).status).toBe(403);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM invites').first('n')).toBe(1);
    expect(await tokenOf('grace@example.com')).toBe(token);
  });

  it('asks for an email address when what was typed is not one', async () => {
    const root = await admin();
    const response = await invite(root, 'not an email');
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Enter an email address.');
    expect(html).toContain('value="not an email"');
    expect(html).toContain('aria-invalid="true"');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM invites').first('n')).toBe(0);
  });
});
