#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { downloads } from '../../../../packages/ui/src/downloads.ts';
import { createApp } from '../../../../apps/cloud/src/app.ts';
import { githubTracker } from '../../../../apps/cloud/src/github.ts';
import { sessions } from '../../../../apps/cloud/src/session.ts';
import { store } from '../../../../apps/cloud/src/store.ts';
import type { AuthorizeRequest } from '../../../../apps/cloud/src/identity.ts';
import { database, FakeIdentity, FakeMailer } from '../../../../apps/cloud/test/support.ts';

const [out = '.e2e/artifacts/verify/feedback', portArg = '0'] = process.argv.slice(2);
const dir = resolve(out, 'github');
mkdirSync(dir, { recursive: true });

const TESTER = { subject: 'idp_tester', email: 'tester@example.test', emailVerified: true, name: 'Paper Tester' };
const REPO = 'tesserachart/tessera';

class SignsInAtOnce extends FakeIdentity {
  override authorizeUrl({ redirectUri, state }: AuthorizeRequest) {
    const url = new URL(redirectUri);
    url.searchParams.set('code', 'tester');
    url.searchParams.set('state', state);
    return url.toString();
  }
}

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

const refs = new Map<string, string>();
const files = new Map<string, string>();
const issues: Issue[] = [];
let serial = 0;
const sha = (kind: string) => `${kind}${String(++serial).padStart(6, '0')}`;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const github = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const body = method === 'GET' ? {} : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    const path = url.pathname;
    if (method === 'POST' && /^\/app\/installations\/[^/]+\/access_tokens$/.test(path)) {
      return json(201, { token: 'ghs_stand_in', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (request.headers.get('authorization') !== 'Bearer ghs_stand_in') return json(401, { message: 'Bad credentials' });
    const repo = `/repos/${REPO}`;
    if (!path.startsWith(repo)) return json(404, { message: 'Not Found' });
    const route = path.slice(repo.length);
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(route);
    if (method === 'GET' && ref) {
      const at = refs.get(ref[1]!);
      return at ? json(200, { object: { sha: at } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && route === '/git/trees') return json(201, { sha: sha('tree') });
    if (method === 'POST' && route === '/git/commits') return json(201, { sha: sha('commit') });
    if (method === 'POST' && route === '/git/refs') {
      refs.set(String(body.ref).replace(/^refs\/heads\//, ''), String(body.sha));
      return json(201, {});
    }
    const contents = /^\/contents\/(.+)$/.exec(route);
    if (contents) {
      const file = contents[1]!;
      const branch = method === 'GET' ? url.searchParams.get('ref')! : String(body.branch);
      if (!refs.has(branch)) return json(404, { message: 'No commit found for the ref' });
      const key = `${branch}:${file}`;
      if (method === 'GET') {
        const stored = files.get(key);
        return stored === undefined ? json(404, { message: 'Not Found' }) : json(200, { path: file, content: stored });
      }
      if (files.has(key)) return json(422, { message: '"sha" wasn\'t supplied.' });
      const content = String(body.content);
      files.set(key, content);
      const local = join(dir, file.replaceAll('/', '_'));
      writeFileSync(local, Buffer.from(content, 'base64'));
      return json(201, { content: { path: file }, commit: { sha: sha('commit') } });
    }
    if (method === 'POST' && route === '/issues') {
      const issue = { number: 500 + issues.length + 1, ...(body as Omit<Issue, 'number'>) };
      issues.push(issue);
      writeFileSync(join(dir, `issue-${String(issue.number)}.json`), JSON.stringify(issue, null, 2));
      writeFileSync(join(dir, `issue-${String(issue.number)}.md`), `# ${issue.title}\n\n${issue.body}\n`);
      return json(201, { number: issue.number, html_url: `https://github.com/${REPO}/issues/${String(issue.number)}` });
    }
    return json(404, { message: 'Not Found' });
  },
});

const { db } = await database();
const pair = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;

const app = createApp(() => ({
  identity: new SignsInAtOnce({ tester: TESTER }),
  store: store(db),
  sessions: sessions('stand-in-session-secret-0123456789abcdef'),
  mailer: new FakeMailer(),
  issues: githubTracker({
    appId: '1',
    privateKey: pem,
    installationId: '7',
    repo: REPO,
    branch: 'feedback-attachments',
    apiBase: `http://127.0.0.1:${String(github.port)}`,
  }),
  site: { url: 'https://site.test', downloads: downloads('', []) },
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

console.info(
  JSON.stringify({ cloud: `http://127.0.0.1:${String(cloud.port)}`, github: `http://127.0.0.1:${String(github.port)}` }),
);
