import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { Download } from '@tessera/ui/downloads';
import { sendApproval } from './approval.ts';
import {
  decodedBytes,
  FeedbackRequest,
  filedReport,
  type IssueTracker,
  IssueTrackerFailed,
  MAX_FEEDBACK_BYTES,
  MAX_SCREENSHOT_BYTES,
  parseJson,
} from './feedback.ts';
import { type Identity, IdentityRejected, type Tokens } from './identity.ts';
import type { Mailer } from './mail.ts';
import type { Session, Sessions } from './session.ts';
import { sharePages } from './sharePages.tsx';
import {
  decoded,
  isImageOf,
  isShareId,
  MAX_SHARE_BYTES,
  MAX_SHARE_IMAGE_BYTES,
  type Share,
  SHARE_ENTITLEMENT,
  shareId,
  type ShareImages,
  ShareRequest,
  shareUrl,
} from './shares.ts';
import type { Store, User } from './store.ts';
import { web } from './web.tsx';

export interface Asset {
  body: ArrayBuffer | string;
  type: string;
}

export interface Services {
  identity: Identity;
  store: Store;
  sessions: Sessions;
  mailer: Mailer;
  issues: IssueTracker | null;
  shares: ShareImages | null;
  site: { url: string; downloads: readonly Download[] };
  assets?: Readonly<Record<string, Asset>>;
  now: () => Date;
}

export type Variables = {
  services: Services;
  user: User;
  sessionId: string;
  session: Session;
  form: Record<string, string>;
};

type AppEnv<Bindings> = { Bindings: Bindings; Variables: Variables };

const API = /^\/(v1|auth\/desktop)(\/|$)/;

/** Any port: RFC 8252 §7.3 requires accepting any loopback port for native apps. */
const LOOPBACK_CALLBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/auth\/callback$/;

const DesktopStart = z.object({
  redirect_uri: z.string().regex(LOOPBACK_CALLBACK),
  state: z.string().regex(/^[\w-]{16,128}$/),
  code_challenge: z.string().regex(/^[\w-]{43}$/),
});

const TokenRequest = z.object({
  code: z.string().min(1).max(512),
  code_verifier: z.string().regex(/^[\w.~-]{43,128}$/),
});
const RefreshRequest = z.object({ refresh_token: z.string().min(1).max(4096) });

const CheckinRequest = z.object({
  app_version: z.string().min(1).max(64),
  platform: z.enum(['mac', 'windows', 'linux']),
  arch: z.string().min(1).max(16),
  channel: z.enum(['release', 'dev', 'beta']).transform((c) => (c === 'beta' ? 'release' : c)),
});

export function createApp<Bindings extends object>(services: (env: Bindings) => Services) {
  const app = new Hono<AppEnv<Bindings>>();

  app.use(async (c, next) => {
    c.set('services', services(c.env));
    await next();
  });

  app.onError((error, c) => {
    const api = API.test(c.req.path);
    if (api && error instanceof IdentityRejected) return c.json({ error: 'rejected' }, 401);
    console.error(error);
    if (api) return c.json({ error: 'internal' }, 500);
    return c.text('Something went wrong. Try again in a moment.', 500);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.get('/healthz', (c) => c.text('ok'));

  app.get('/assets/:name', (c) => {
    const asset = c.var.services.assets?.[c.req.param('name')];
    if (asset === undefined) return c.json({ error: 'not_found' }, 404);
    return c.body(asset.body, 200, {
      'content-type': asset.type,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
  });

  app.route('/', sharePages());
  app.route('/', web());

  app.get('/auth/desktop/start', (c) => {
    const query = DesktopStart.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'bad_request' }, 400);
    const url = c.var.services.identity.authorizeUrl({
      redirectUri: query.data.redirect_uri,
      state: query.data.state,
      codeChallenge: query.data.code_challenge,
    });
    return c.redirect(url, 302);
  });

  app.post('/v1/auth/token', async (c) => {
    const body = TokenRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const tokens = await c.var.services.identity.exchange(body.data.code, body.data.code_verifier);
    return c.json(await session(c, tokens));
  });

  app.post('/v1/auth/refresh', async (c) => {
    const body = RefreshRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const tokens = await c.var.services.identity.refresh(body.data.refresh_token);
    return c.json(await session(c, tokens));
  });

  app.use('/v1/*', async (c, next) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (token === undefined) return c.json({ error: 'unauthorized' }, 401);
    const { identity, store } = c.var.services;
    const claims = await identity.verify(token).catch((error: unknown) => {
      if (error instanceof IdentityRejected) return null;
      throw error;
    });
    if (claims === null) return c.json({ error: 'unauthorized' }, 401);
    const user = await store.userBySubject(claims.subject);
    if (user === null) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    c.set('sessionId', claims.sessionId);
    return next();
  });

  app.get('/v1/me', async (c) => c.json(await account(c.var.services, c.var.user)));

  app.post('/v1/auth/sign-out', async (c) => {
    await c.var.services.identity.signOut(c.var.sessionId);
    return c.body(null, 204);
  });

  app.post('/v1/checkins', async (c) => {
    const body = CheckinRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const { app_version: appVersion, platform, arch, channel } = body.data;
    await c.var.services.store.checkin(c.var.user.id, { appVersion, platform, arch, channel }, c.var.services.now());
    return c.body(null, 204);
  });

  app.post('/v1/feedback', async (c) => {
    if (Number(c.req.header('content-length') ?? 0) > MAX_FEEDBACK_BYTES) return c.json({ error: 'too_large' }, 413);
    const { store, issues } = c.var.services;
    const standing = await store.standing(c.var.user.id);
    if (standing.access !== 'full') return c.json({ error: 'no_access' }, 403);
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_FEEDBACK_BYTES) return c.json({ error: 'too_large' }, 413);
    const body = FeedbackRequest.safeParse(parseJson(raw));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const { screenshot } = body.data;
    if (screenshot !== null && decodedBytes(screenshot.data) > MAX_SCREENSHOT_BYTES) {
      return c.json({ error: 'too_large' }, 413);
    }
    if (issues === null) return c.json({ error: 'feedback_off' }, 503);
    try {
      const issue = await issues.file(filedReport(body.data, c.var.user.id));
      return c.json({ id: body.data.id, issue: { number: issue.number, url: issue.url } });
    } catch (error) {
      if (!(error instanceof IssueTrackerFailed)) throw error;
      console.error('feedback: github failed', error.step, error.status);
      return c.json({ error: 'github' }, 502);
    }
  });

  app.post('/v1/shares', async (c) => {
    if (Number(c.req.header('content-length') ?? 0) > MAX_SHARE_BYTES) return c.json({ error: 'too_large' }, 413);
    const { store, shares, now } = c.var.services;
    if (shares === null) return c.json({ error: 'sharing_off' }, 503);
    const standing = await store.standing(c.var.user.id);
    if (standing.access !== 'full') return c.json({ error: 'no_access' }, 403);
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_SHARE_BYTES) return c.json({ error: 'too_large' }, 413);
    const body = ShareRequest.safeParse(parseJson(raw));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const { kind, title, image, width, height } = body.data;
    if (decodedBytes(image.data) > MAX_SHARE_IMAGE_BYTES) return c.json({ error: 'too_large' }, 413);
    const bytes = decoded(image.data);
    if (!isImageOf(bytes, image.type)) return c.json({ error: 'bad_request' }, 400);
    const share: Share = {
      id: shareId(),
      userId: c.var.user.id,
      kind,
      title,
      imageType: image.type,
      width,
      height,
      createdAt: now().toISOString(),
    };
    await shares.put(share.id, bytes, image.type);
    try {
      await store.addShare(share);
    } catch (error) {
      await shares.delete(share.id);
      throw error;
    }
    return c.json(sharedOf(c, share), 201);
  });

  app.get('/v1/shares', async (c) => {
    const { store, shares } = c.var.services;
    if (shares === null) return c.json({ shares: [] });
    const own = await store.sharesOf(c.var.user.id);
    return c.json({ shares: own.map((share) => sharedOf(c, share)) });
  });

  app.delete('/v1/shares/:id', async (c) => {
    const { store, shares } = c.var.services;
    const id = c.req.param('id');
    if (!isShareId(id)) return c.json({ error: 'not_found' }, 404);
    if (!(await store.removeShare(c.var.user.id, id))) return c.json({ error: 'not_found' }, 404);
    await shares?.delete(id);
    return c.body(null, 204);
  });

  return app;
}

function sharedOf<Bindings extends object>(c: Context<AppEnv<Bindings>>, share: Share) {
  return {
    id: share.id,
    url: shareUrl(new URL(c.req.url).origin, share.id),
    kind: share.kind,
    title: share.title,
    created_at: share.createdAt,
  };
}

async function session<Bindings extends object>(c: Context<AppEnv<Bindings>>, tokens: Tokens) {
  const { store, now } = c.var.services;
  const { user, invited } = await store.signIn(tokens.profile, now());
  if (invited) await sendApproval(c.var.services, user, false);
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    account: await account(c.var.services, user),
  };
}

async function account({ store, shares }: Services, user: User) {
  const standing = await store.standing(user.id);
  const canShare = shares !== null && standing.access === 'full';
  return {
    user: { id: user.id, email: user.email, name: user.name },
    access: standing.access,
    entitlements: canShare ? [...standing.entitlements, SHARE_ENTITLEMENT] : standing.entitlements,
  };
}
