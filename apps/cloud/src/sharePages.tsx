import { type Context, Hono } from 'hono';
import { html } from 'hono/html';
import type { z } from 'zod';

import type { Variables } from './app.ts';
import { Layout, Notice } from './pages.tsx';
import { SharedChart, SharedConversationPage, SharedSetupPage } from './sharedPages.tsx';
import {
  ConversationDocument,
  documentOf,
  isSetupKind,
  isShareId,
  type Share,
  SetupDocument,
  shareUrl,
} from './shares.ts';

type ShareEnv = { Variables: Variables };

const UNLISTED_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

async function liveShare(c: Context<ShareEnv>) {
  const { shares, store } = c.var.services;
  const id = c.req.param('id') ?? '';
  if (shares === null || !isShareId(id)) return null;
  return store.share(id);
}

async function storedDocument<T>(c: Context<ShareEnv>, share: Share, schema: z.ZodType<T>): Promise<T | null> {
  const stored = await c.var.services.shares?.get(share.id);
  return stored === null || stored === undefined ? null : documentOf(stored, schema);
}

function gone(c: Context<ShareEnv>) {
  const siteUrl = c.var.services.site.url;
  return c.html(
    html`<!doctype html>${(
        <Layout title="Link not found" siteUrl={siteUrl}>
          <Notice
            title="This link doesn’t work"
            text="It may have been deleted by the person who shared it."
            action={{ href: siteUrl, label: 'About Tessera' }}
          />
        </Layout>
      )}`,
    404,
    UNLISTED_HEADERS,
  );
}

async function pageOf(c: Context<ShareEnv>, share: Share) {
  const pageUrl = shareUrl(new URL(c.req.url).origin, share.id);
  const siteUrl = c.var.services.site.url;
  if (share.kind === 'chart') {
    return <SharedChart share={share} pageUrl={pageUrl} imageUrl={`${pageUrl}/image`} siteUrl={siteUrl} />;
  }
  if (share.kind === 'conversation') {
    const document = await storedDocument(c, share, ConversationDocument);
    if (document === null) return null;
    return (
      <SharedConversationPage share={share} conversation={document.conversation} pageUrl={pageUrl} siteUrl={siteUrl} />
    );
  }
  const document = await storedDocument(c, share, SetupDocument);
  if (document === null) return null;
  return <SharedSetupPage share={share} document={document} pageUrl={pageUrl} siteUrl={siteUrl} />;
}

export function sharePages() {
  const app = new Hono<ShareEnv>();

  app.get('/s/:id', async (c) => {
    const share = await liveShare(c);
    const page = share === null ? null : await pageOf(c, share);
    if (page === null) return gone(c);
    return c.html(html`<!doctype html>${page}`, 200, UNLISTED_HEADERS);
  });

  app.get('/s/:id/image', async (c) => {
    const share = await liveShare(c);
    const image = share?.kind === 'chart' ? await c.var.services.shares?.get(share.id) : null;
    if (image === null || image === undefined) return c.body(null, 404, UNLISTED_HEADERS);
    return c.body(image.body, 200, { ...UNLISTED_HEADERS, 'content-type': image.type });
  });

  app.get('/s/:id/setup', async (c) => {
    const share = await liveShare(c);
    if (share === null || !isSetupKind(share.kind)) return c.json({ error: 'not_found' }, 404, UNLISTED_HEADERS);
    const document = await storedDocument(c, share, SetupDocument);
    if (document === null) return c.json({ error: 'not_found' }, 404, UNLISTED_HEADERS);
    const { display, setup } = document;
    return c.json({ id: share.id, kind: share.kind, title: share.title, display, setup }, 200, UNLISTED_HEADERS);
  });

  return app;
}
