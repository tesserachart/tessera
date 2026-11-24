#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { downloads } from '../../../../packages/ui/src/downloads.ts';
import { createApp } from '../../../../apps/cloud/src/app.ts';
import { sessions } from '../../../../apps/cloud/src/session.ts';
import { store } from '../../../../apps/cloud/src/store.ts';
import type { AuthorizeRequest } from '../../../../apps/cloud/src/identity.ts';
import { database, FakeIdentity, FakeMailer, MemoryImages } from '../../../../apps/cloud/test/support.ts';

const [portArg = '0'] = process.argv.slice(2);

const TESTER = { subject: 'idp_tester', email: 'tester@example.test', emailVerified: true, name: 'Paper Tester' };

class SignsInAtOnce extends FakeIdentity {
  override authorizeUrl({ redirectUri, state }: AuthorizeRequest) {
    const url = new URL(redirectUri);
    url.searchParams.set('code', 'tester');
    url.searchParams.set('state', state);
    return url.toString();
  }
}

const ui = (path: string) => resolve(import.meta.dirname, '../../../../packages/ui', path);
const font = (path: string) => new Uint8Array(readFileSync(ui(path))).buffer;
const ASSETS = {
  'instrument-sans.woff2': { body: font('fonts/InstrumentSans-VF.woff2'), type: 'font/woff2' },
  'instrument-serif.woff2': { body: font('fonts/InstrumentSerif-Regular.woff2'), type: 'font/woff2' },
  'wordmark.svg': { body: readFileSync(ui('brand/wordmark-text.svg'), 'utf8'), type: 'image/svg+xml' },
};

const { db } = await database();
const images = new MemoryImages();

const app = createApp(() => ({
  identity: new SignsInAtOnce({ tester: TESTER }),
  store: store(db),
  sessions: sessions('stand-in-session-secret-0123456789abcdef'),
  mailer: new FakeMailer(),
  issues: null,
  shares: images,
  site: { url: 'https://site.test', downloads: downloads('', []) },
  assets: ASSETS,
  now: () => new Date(),
}));

const grantEveryone = () =>
  db
    .prepare(
      "INSERT OR IGNORE INTO entitlements (user_id, key, source, granted_at) SELECT id, 'early_access', 'approval', ?1 FROM users",
    )
    .bind(new Date().toISOString())
    .run();

const cloud = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(portArg),
  async fetch(request) {
    await grantEveryone();
    const response = await app.fetch(request);
    await grantEveryone();
    return response;
  },
});

console.info(JSON.stringify({ cloud: `http://127.0.0.1:${String(cloud.port)}`, tester: TESTER.email }));
