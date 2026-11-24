import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { html } from 'hono/html';
import type { Child } from 'hono/jsx';
import { z } from 'zod';

import type { Variables } from './app.ts';
import { sendApproval, STALE_SEND_MS } from './approval.ts';
import { IdentityRejected } from './identity.ts';
import {
  Admin,
  type ApplyErrors,
  ApplyForm,
  type ApplyValues,
  Approved,
  type Chrome,
  Declined,
  type Filter,
  filterOf,
  FILTERS,
  type InviteForm,
  Layout,
  Notice,
  Waiting,
} from './pages.tsx';
import {
  isInviteToken,
  LOGIN_TTL_SECONDS,
  randomToken,
  type ReturnPath,
  sameToken,
  type Session,
  SESSION_TTL_SECONDS,
} from './session.ts';
import type { User } from './store.ts';

const LOGIN_COOKIE = 'tessera_login';
const SESSION_COOKIE = 'tessera_session';

const Text = (max: number, problem: string) =>
  z
    .string()
    .trim()
    .min(1, problem)
    .max(max, `Keep it under ${String(max)} characters.`);

const ApplyFields = z.object({
  propFirm: Text(80, 'Tell us your prop firm.'),
  platform: z.enum(['mac', 'windows', 'linux'], { error: 'Pick where you will run Tessera.' }),
  trading: Text(200, 'One line on how you trade.'),
});
const NameField = z.object({ name: Text(80, 'Tell us your name.') });
const InviteEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));

type WebEnv = { Variables: Variables };
type C = Context<WebEnv>;

export function web() {
  const app = new Hono<WebEnv>();

  function page(c: C, status: 200 | 400 | 403 | 404, chrome: Chrome, body: Child) {
    const site = c.var.services.site.url;
    c.header(
      'content-security-policy',
      `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' ${site}; form-action 'self' ${site}; frame-ancestors 'none'; base-uri 'none'`,
    );
    c.header('cache-control', 'no-store');
    // Under `no-referrer` a browser posts forms with `Origin: null`.
    c.header('referrer-policy', 'same-origin');
    c.header('x-content-type-options', 'nosniff');
    return c.html(html`<!doctype html>${(<Layout {...chrome}>{body}</Layout>)}`, status);
  }

  function chrome(c: C, title: string, extra: Partial<Chrome> = {}): Chrome {
    return { title, siteUrl: c.var.services.site.url, ...extra };
  }

  function signedInChrome(c: C, title: string, extra: Partial<Chrome> = {}): Chrome {
    return chrome(c, title, { signedIn: { user: c.var.user, csrf: c.var.session.csrf }, ...extra });
  }

  async function current(c: C): Promise<{ user: User; session: Session } | null> {
    const token = getCookie(c, SESSION_COOKIE, 'host');
    if (token === undefined) return null;
    const { sessions, store, now } = c.var.services;
    const session = await sessions.open('session', token, now());
    if (session === null) return null;
    const user = await store.userById(session.userId);
    return user === null ? null : { user, session };
  }

  async function signIn(c: C, returnTo: ReturnPath, loginHint?: string) {
    const { identity, sessions, now } = c.var.services;
    const state = randomToken();
    setCookie(c, LOGIN_COOKIE, await sessions.seal('login', { state, returnTo }, now()), {
      prefix: 'host',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: LOGIN_TTL_SECONDS,
    });
    const redirectUri = `${new URL(c.req.url).origin}/auth/callback`;
    const hint = loginHint === undefined ? {} : { loginHint };
    return c.redirect(identity.authorizeUrl({ redirectUri, state, ...hint }), 302);
  }

  const signedIn = (returnTo: ReturnPath) =>
    createMiddleware<WebEnv>(async (c, next) => {
      const who = await current(c);
      if (who === null) return signIn(c, returnTo);
      c.set('user', who.user);
      c.set('session', who.session);
      return next();
    });

  const posted = createMiddleware<WebEnv>(async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== new URL(c.req.url).origin) return refused(c);
    const who = await current(c);
    if (who === null) return refused(c);
    const body = await c.req.parseBody().catch(() => null);
    const form: Record<string, string> = {};
    for (const [key, value] of Object.entries(body ?? {})) if (typeof value === 'string') form[key] = value;
    if (form.csrf === undefined || !sameToken(form.csrf, who.session.csrf)) return refused(c);
    c.set('user', who.user);
    c.set('session', who.session);
    c.set('form', form);
    return next();
  });

  const adminOnly = createMiddleware<WebEnv>(async (c, next) => {
    if (c.var.user.role !== 'admin') {
      return page(
        c,
        403,
        signedInChrome(c, 'Not available'),
        <Notice
          title="Not available."
          text="This page is for Tessera's team."
          action={{ href: '/apply', label: 'Your access' }}
        />,
      );
    }
    return next();
  });

  function refused(c: C) {
    return page(
      c,
      403,
      chrome(c, 'Sign in again'),
      <Notice
        title="Sign in again."
        text="That form came from a page that is no longer signed in. Nothing was changed."
        action={{ href: '/apply', label: 'Sign in' }}
      />,
    );
  }

  function signInFailed(c: C) {
    return page(
      c,
      400,
      chrome(c, 'Sign-in did not finish'),
      <Notice
        title="Sign-in didn't finish."
        text="The link may have expired, or it was opened in another browser. Try again."
        action={{ href: '/apply', label: 'Sign in again' }}
      />,
    );
  }

  app.get('/auth/callback', async (c) => {
    const { identity, sessions, store, now } = c.var.services;
    const sealed = getCookie(c, LOGIN_COOKIE, 'host');
    deleteCookie(c, LOGIN_COOKIE, { prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    const login = sealed === undefined ? null : await sessions.open('login', sealed, now());
    const { code, state } = c.req.query();
    if (login === null || state === undefined || !sameToken(state, login.state) || code === undefined) {
      return signInFailed(c);
    }
    const tokens = await identity.exchange(code).catch((error: unknown) => {
      if (error instanceof IdentityRejected) return null;
      throw error;
    });
    if (tokens === null) return signInFailed(c);
    const claims = await identity.verify(tokens.accessToken);
    const { user, invited } = await store.signIn(tokens.profile, now());
    if (invited) await sendApproval(c.var.services, user, false);
    const session = { userId: user.id, providerSession: claims.sessionId, csrf: randomToken() };
    setCookie(c, SESSION_COOKIE, await sessions.seal('session', session, now()), {
      prefix: 'host',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.redirect(login.returnTo, 303);
  });

  app.post('/auth/sign-out', posted, async (c) => {
    const { identity, site } = c.var.services;
    await identity.signOut(c.var.session.providerSession).catch((error: unknown) => {
      console.error('sign-out at the identity provider failed', error);
    });
    deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    return c.redirect(site.url, 303);
  });

  app.get('/', (c) => c.redirect('/apply', 302));

  app.get('/apply', signedIn('/apply'), async (c) => {
    const { store, site } = c.var.services;
    const user = c.var.user;
    const [standing, application] = await Promise.all([store.standing(user.id), store.application(user.id)]);
    const here = { here: 'apply' as const };
    if (standing.access === 'full') {
      return page(
        c,
        200,
        signedInChrome(c, 'Download', here),
        <Approved user={user} platform={application?.platform ?? null} downloads={site.downloads} siteUrl={site.url} />,
      );
    }
    if (standing.access === 'declined') return page(c, 200, signedInChrome(c, 'Your request', here), <Declined />);
    const editing = application?.status === 'pending' && c.req.query('edit') !== undefined;
    if (application !== null && !editing) {
      return page(c, 200, signedInChrome(c, 'On the list', here), <Waiting user={user} application={application} />);
    }
    const values: ApplyValues = {};
    if (application !== null) {
      if (application.propFirm !== null) values.propFirm = application.propFirm;
      if (application.platform !== null) values.platform = application.platform;
      if (application.trading !== null) values.trading = application.trading;
    }
    return applyForm(c, 200, values, {}, editing);
  });

  function applyForm(c: C, status: 200 | 400, values: ApplyValues, errors: ApplyErrors, editing: boolean) {
    const { site } = c.var.services;
    return page(
      c,
      status,
      signedInChrome(c, 'Request access', { here: 'apply' }),
      <ApplyForm
        user={c.var.user}
        csrf={c.var.session.csrf}
        values={values}
        errors={errors}
        askName={c.var.user.name === null}
        available={site.downloads.map((d) => d.platform)}
        siteUrl={site.url}
        editing={editing}
      />,
    );
  }

  app.post('/apply', posted, async (c) => {
    const { store, now } = c.var.services;
    const user = c.var.user;
    const form = c.var.form;
    const [standing, application] = await Promise.all([store.standing(user.id), store.application(user.id)]);
    if (standing.access === 'full' || (application !== null && application.status !== 'pending')) {
      return c.redirect('/apply', 303);
    }
    const askName = user.name === null;
    const answers = ApplyFields.safeParse(form);
    const name = askName ? NameField.safeParse(form) : null;
    if (!answers.success || name?.success === false) {
      const errors: ApplyErrors = {};
      for (const issue of [...(answers.error?.issues ?? []), ...(name?.error?.issues ?? [])]) {
        const field = issue.path[0] as keyof ApplyValues;
        errors[field] ??= issue.message;
      }
      const values: ApplyValues = {
        ...(askName && form.name !== undefined ? { name: form.name } : {}),
        ...(form.propFirm === undefined ? {} : { propFirm: form.propFirm }),
        ...(form.platform === undefined ? {} : { platform: form.platform }),
        ...(form.trading === undefined ? {} : { trading: form.trading }),
      };
      return applyForm(c, 400, values, errors, application !== null);
    }
    await store.apply(user.id, answers.data, name?.data.name ?? null, now());
    return c.redirect('/apply', 303);
  });

  const Status = z.enum(FILTERS).optional();

  function filterFrom(raw: string | undefined): Filter | null {
    const parsed = Status.safeParse(raw);
    return parsed.success ? (parsed.data ?? null) : null;
  }

  async function adminPage(c: C, status: 200 | 400, filter: Filter | null, invite: InviteForm) {
    const { store, now } = c.var.services;
    const [everyone, invites] = await Promise.all([store.applicants(), store.openInvites()]);
    const counts = { all: everyone.length, pending: 0, approved: 0, declined: 0 };
    for (const a of everyone) {
      const f = filterOf(a);
      if (f !== null) counts[f] += 1;
    }
    const shown = filter === null ? everyone : everyone.filter((a) => filterOf(a) === filter);
    return page(
      c,
      status,
      signedInChrome(c, 'Applicants', { here: 'admin', wide: true }),
      <Admin
        applicants={shown}
        counts={counts}
        filter={filter}
        csrf={c.var.session.csrf}
        staleBefore={new Date(now().getTime() - STALE_SEND_MS)}
        invites={invites}
        origin={new URL(c.req.url).origin}
        invite={invite}
      />,
    );
  }

  app.get('/admin', signedIn('/admin'), adminOnly, (c) =>
    adminPage(c, 200, filterFrom(c.req.query('status')), { value: '', problem: null }),
  );

  function back(c: C) {
    const filter = Status.safeParse(c.var.form.back);
    return c.redirect(filter.success && filter.data !== undefined ? `/admin?status=${filter.data}` : '/admin', 303);
  }

  async function target(c: C): Promise<User | null> {
    return c.var.services.store.userById(c.req.param('id') ?? '');
  }

  function unknownPerson(c: C) {
    return page(
      c,
      404,
      signedInChrome(c, 'Not found', { here: 'admin' }),
      <Notice
        title="No one by that id."
        text="They may have been removed."
        action={{ href: '/admin', label: 'Applicants' }}
      />,
    );
  }

  app.post('/admin/users/:id/approve', posted, adminOnly, async (c) => {
    const person = await target(c);
    if (person === null) return unknownPerson(c);
    const { store, now } = c.var.services;
    await store.approve(person.id, c.var.user.id, now());
    await sendApproval(c.var.services, person, false);
    return back(c);
  });

  app.post('/admin/users/:id/decline', posted, adminOnly, async (c) => {
    const person = await target(c);
    if (person === null) return unknownPerson(c);
    const { store, now } = c.var.services;
    if ((await store.standing(person.id)).access !== 'full') await store.decline(person.id, c.var.user.id, now());
    return back(c);
  });

  app.post('/admin/users/:id/resend', posted, adminOnly, async (c) => {
    const person = await target(c);
    if (person === null) return unknownPerson(c);
    await sendApproval(c.var.services, person, true);
    return back(c);
  });

  app.post('/admin/invites', posted, adminOnly, async (c) => {
    const { store, now } = c.var.services;
    const typed = c.var.form.email ?? '';
    const filter = filterFrom(c.var.form.back);
    const email = InviteEmail.safeParse(typed);
    if (!email.success) return adminPage(c, 400, filter, { value: typed, problem: 'Enter an email address.' });
    const result = await store.invite(email.data, c.var.user.id, now());
    if (result.kind === 'account') {
      const { access } = await store.standing(result.user.id);
      const problem =
        access === 'full'
          ? `${email.data} already has access.`
          : `${email.data} already has an account. Approve them in the list below.`;
      return adminPage(c, 400, filter, { value: typed, problem });
    }
    return back(c);
  });

  app.post('/admin/invites/:token/revoke', posted, adminOnly, async (c) => {
    const { store, now } = c.var.services;
    await store.revokeInvite(c.req.param('token'), now());
    return back(c);
  });

  function inviteNotice(c: C, title: string, text: string) {
    return page(
      c,
      404,
      chrome(c, 'Invite'),
      <Notice title={title} text={text} action={{ href: '/apply', label: 'Request access' }} />,
    );
  }

  app.get('/invite/:token', async (c) => {
    const token = c.req.param('token');
    const invite = isInviteToken(token) ? await c.var.services.store.inviteByToken(token) : null;
    if (invite === null) {
      return inviteNotice(c, "This invite doesn't work.", 'Check that you have the whole link, or ask for a new one.');
    }
    if (invite.state.kind === 'revoked') {
      return inviteNotice(c, 'This invite was withdrawn.', 'Ask whoever sent it for a new one.');
    }
    const who = await current(c);
    if (who === null) return signIn(c, `/invite/${token}`, invite.email);
    const { user } = who;
    const theirs = invite.state.kind === 'used' && invite.state.by === user.id;
    if (theirs || user.email.toLowerCase() === invite.email) return c.redirect('/apply', 303);
    c.set('user', user);
    c.set('session', who.session);
    return page(
      c,
      403,
      signedInChrome(c, 'Invite'),
      <Notice
        title={`This invite is for ${invite.email}.`}
        text={`You're signed in as ${user.email}. Sign out, then open the link again and sign in with ${invite.email}.`}
      />,
    );
  });

  return app;
}
