import { type Context, Hono } from 'hono';
import { html } from 'hono/html';

import type { Variables } from './app.ts';
import { Layout, Notice, SharedChart } from './pages.tsx';
import { isShareId, shareUrl } from './shares.ts';

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

export function sharePages() {
  const app = new Hono<ShareEnv>();

  app.get('/s/:id', async (c) => {
    const share = await liveShare(c);
    if (share === null) return gone(c);
    const pageUrl = shareUrl(new URL(c.req.url).origin, share.id);
    return c.html(
      html`<!doctype html>${(
          <SharedChart
            share={share}
            pageUrl={pageUrl}
            imageUrl={`${pageUrl}/image`}
            siteUrl={c.var.services.site.url}
          />
        )}`,
      200,
      UNLISTED_HEADERS,
    );
  });

  app.get('/s/:id/image', async (c) => {
    const share = await liveShare(c);
    const image = share === null ? null : await c.var.services.shares?.get(share.id);
    if (image === null || image === undefined) return c.body(null, 404, UNLISTED_HEADERS);
    return c.body(image.body, 200, { ...UNLISTED_HEADERS, 'content-type': image.type });
  });

  return app;
}
