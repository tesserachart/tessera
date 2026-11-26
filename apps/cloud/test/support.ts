import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Miniflare } from 'miniflare';

import { createApp } from '../src/app.ts';
import { downloads } from '@tessera/ui/downloads';
import {
  type AuthorizeRequest,
  type Claims,
  type Identity,
  IdentityRejected,
  type Profile,
  type Tokens,
} from '../src/identity.ts';
import { type FiledIssue, type FiledReport, type IssueTracker, IssueTrackerFailed } from '../src/feedback.ts';
import { type Email, MailFailed, type Mailer } from '../src/mail.ts';
import { sessions } from '../src/session.ts';
import type { BodyType, ShareBodies, StoredBody } from '../src/shares.ts';
import { store } from '../src/store.ts';

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

export async function database(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare({ modules: true, script: 'export default {}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(MIGRATIONS).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  return { db, dispose: () => mf.dispose() };
}

export async function reset(db: D1Database): Promise<void> {
  await db.batch(
    ['shares', 'invites', 'checkins', 'entitlements', 'applications', 'users'].map((table) =>
      db.prepare(`DELETE FROM ${table}`),
    ),
  );
}

export class FakeIdentity implements Identity {
  readonly signedOut: string[] = [];
  private sessions = 0;

  constructor(private readonly profiles: Record<string, Profile>) {}

  authorizeUrl({ redirectUri, state, codeChallenge, loginHint }: AuthorizeRequest) {
    const url = new URL('https://idp.test/authorize');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    if (codeChallenge !== undefined) url.searchParams.set('code_challenge', codeChallenge);
    if (loginHint !== undefined) url.searchParams.set('login_hint', loginHint);
    return url.toString();
  }

  exchange(code: string): Promise<Tokens> {
    return this.issue(code);
  }

  refresh(refreshToken: string): Promise<Tokens> {
    return this.issue(refreshToken.replace(/^refresh:/, ''));
  }

  verify(accessToken: string): Promise<Claims> {
    const match = /^access:([^:]+):([^:]+)$/.exec(accessToken);
    if (match === null) return Promise.reject(new IdentityRejected('bad token'));
    return Promise.resolve({ subject: match[1]!, sessionId: match[2]!, expiresAt: 0 });
  }

  signOut(sessionId: string): Promise<void> {
    this.signedOut.push(sessionId);
    return Promise.resolve();
  }

  private issue(key: string): Promise<Tokens> {
    const profile = this.profiles[key];
    if (profile === undefined) return Promise.reject(new IdentityRejected('invalid_grant'));
    this.sessions += 1;
    return Promise.resolve({
      accessToken: `access:${profile.subject}:session_${String(this.sessions)}`,
      refreshToken: `refresh:${key}`,
      profile,
    });
  }
}

export class FakeMailer implements Mailer {
  readonly sent: Email[] = [];
  failWith: string | null = null;

  send(email: Email): Promise<void> {
    if (this.failWith !== null) return Promise.reject(new MailFailed(this.failWith));
    this.sent.push(email);
    return Promise.resolve();
  }
}

export class FakeIssueTracker implements IssueTracker {
  readonly filed: FiledReport[] = [];
  private readonly issues = new Map<string, FiledIssue>();
  failWith: number | null = null;

  file(report: FiledReport): Promise<FiledIssue> {
    if (this.failWith !== null) return Promise.reject(new IssueTrackerFailed(this.failWith, 'create issue'));
    const known = this.issues.get(report.id);
    if (known !== undefined) return Promise.resolve(known);
    this.filed.push(report);
    const number = this.filed.length;
    const issue = { number, url: `https://github.com/owner/repo/issues/${String(number)}` };
    this.issues.set(report.id, issue);
    return Promise.resolve(issue);
  }
}

export const NOW = new Date('2026-10-17T12:00:00.000Z');
export const SITE = 'https://site.test';
export const UPDATES = 'https://updates.test';
export const SECRET = 'test-session-secret-0123456789abcdef';

export interface TestOptions {
  mailer?: Mailer;
  clock?: { at: Date };
  secret?: string;
  issues?: IssueTracker | null;
  shares?: ShareBodies | null;
}

export function testApp(db: D1Database, identity: Identity, options: TestOptions = {}) {
  const { mailer = new FakeMailer(), clock = { at: NOW }, secret = SECRET, issues = null, shares = null } = options;
  return createApp(() => ({
    identity,
    store: store(db),
    sessions: sessions(secret),
    mailer,
    issues,
    shares,
    site: { url: SITE, downloads: downloads(UPDATES, ['mac', 'windows']) },
    now: () => clock.at,
  }));
}

export class MemoryBodies implements ShareBodies {
  readonly kept = new Map<string, { bytes: Uint8Array; type: BodyType }>();

  put(id: string, bytes: Uint8Array, type: BodyType): Promise<void> {
    this.kept.set(id, { bytes, type });
    return Promise.resolve();
  }

  get(id: string): Promise<StoredBody | null> {
    const body = this.kept.get(id);
    if (body === undefined) return Promise.resolve(null);
    return Promise.resolve({ body: body.bytes.slice().buffer, type: body.type });
  }

  delete(id: string): Promise<void> {
    this.kept.delete(id);
    return Promise.resolve();
  }
}
