import { jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type FiledReport, IssueTrackerFailed } from '../src/feedback.ts';
import { feedbackIssue, MAX_BODY, TRIMMED } from '../src/feedbackIssue.ts';
import { githubTracker } from '../src/github.ts';
import DESKTOP from './desktop-sign-in.json';
import { database, FakeIdentity, FakeIssueTracker, NOW, reset, testApp } from './support.ts';

const ADA = { subject: 'idp_ada', email: 'ada@example.com', emailVerified: true, name: 'Ada Lovelace' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const REPORT = {
  id: 'fb-0123456789abcdef',
  kind: 'bug',
  title: 'The ladder freezes',
  text: 'It froze after I clicked buy.',
  steps: ['Open the ladder', 'Click buy'],
  expected: 'An order',
  actual: 'Nothing',
  written_up: true,
  context: [
    { key: 'app.version', label: 'Version', value: '0.3.0' },
    { key: 'log.runtime', label: 'Runtime log', value: '120 lines', detail: 'line one\nline two' },
  ],
  screenshot: { type: 'image/png', data: PNG },
  app_version: '0.3.0-alpha.2',
  created_at: '2026-10-17T11:59:00.123456789+00:00',
};

function report(overrides: Partial<FiledReport> = {}): FiledReport {
  return {
    id: 'fb-0123456789abcdef',
    kind: 'bug',
    title: 'The ladder freezes',
    text: 'It froze.',
    steps: [],
    expected: null,
    actual: null,
    writtenUp: false,
    context: [],
    screenshot: null,
    appVersion: '0.3.0',
    createdAt: '2026-10-17T11:59:00Z',
    reporter: 'usr_0123',
    ...overrides,
  };
}

describe('POST /v1/feedback', () => {
  let db: D1Database;
  let dispose: () => Promise<void>;
  let issues: FakeIssueTracker;
  let app: ReturnType<typeof testApp>;

  beforeAll(async () => {
    ({ db, dispose } = await database());
  });

  afterAll(() => dispose());

  beforeEach(async () => {
    await reset(db);
    issues = new FakeIssueTracker();
    app = testApp(db, new FakeIdentity({ 'code-ada': ADA }), { issues });
  });

  async function signIn(access: 'full' | 'pending'): Promise<{ token: string; userId: string }> {
    const response = await app.request('/v1/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'code-ada', code_verifier: DESKTOP.code_verifier }),
    });
    const session = await response.json<{ access_token: string; account: { user: { id: string } } }>();
    const userId = session.account.user.id;
    const statement =
      access === 'full'
        ? "INSERT INTO entitlements (user_id, key, source, granted_at) VALUES (?1, 'early_access', 'approval', ?2)"
        : "INSERT INTO applications (user_id, status, created_at) VALUES (?1, 'pending', ?2)";
    await db.prepare(statement).bind(userId, NOW.toISOString()).run();
    return { token: session.access_token, userId };
  }

  function send(token: string, body: unknown) {
    return app.request('/v1/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('files the report with the reporter id and answers the issue', async () => {
    const { token, userId } = await signIn('full');
    const response = await send(token, REPORT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: REPORT.id,
      issue: { number: 1, url: 'https://github.com/owner/repo/issues/1' },
    });
    expect(issues.filed).toHaveLength(1);
    const filed = issues.filed[0]!;
    expect(filed).toMatchObject({
      id: REPORT.id,
      reporter: userId,
      writtenUp: true,
      appVersion: '0.3.0-alpha.2',
      screenshot: { type: 'image/png', data: PNG },
    });
    expect(filed.context[0]!.detail).toBeNull();
    expect(JSON.stringify(filed)).not.toContain('ada@example.com');
    expect(JSON.stringify(feedbackIssue(filed, null))).not.toMatch(/ada@|Lovelace/);
  });

  it('answers the same issue when the same report comes again', async () => {
    const { token } = await signIn('full');
    const first = await (await send(token, REPORT)).json();
    const again = await send(token, REPORT);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(issues.filed).toHaveLength(1);
  });

  it('takes a report with only the required fields', async () => {
    const { token } = await signIn('full');
    const minimal = {
      id: 'fb-abcdefgh',
      kind: 'idea',
      title: 'Dark ladder',
      text: '',
      app_version: '0.3.0',
      created_at: '2026-10-17T11:59:00Z',
    };
    expect((await send(token, minimal)).status).toBe(200);
    expect(issues.filed[0]).toMatchObject({
      steps: [],
      context: [],
      screenshot: null,
      expected: null,
      writtenUp: false,
    });
  });

  it('refuses someone without full access', async () => {
    const { token } = await signIn('pending');
    const response = await send(token, REPORT);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no_access' });
    expect(issues.filed).toHaveLength(0);
  });

  it('needs a bearer token', async () => {
    const response = await app.request('/v1/feedback', { method: 'POST', body: JSON.stringify(REPORT) });
    expect(response.status).toBe(401);
  });

  it.each([
    ['not JSON', '{'],
    ['a bad id', { ...REPORT, id: 'report-1' }],
    ['an unknown kind', { ...REPORT, kind: 'rant' }],
    ['an empty title', { ...REPORT, title: '' }],
    ['too many steps', { ...REPORT, steps: Array.from({ length: 21 }, () => 'step') }],
    ['a bad context key', { ...REPORT, context: [{ key: 'Version', label: 'Version', value: '1' }] }],
    ['a gif', { ...REPORT, screenshot: { type: 'image/gif', data: PNG } }],
    ['a screenshot that is not base64', { ...REPORT, screenshot: { type: 'image/png', data: 'not base64!' } }],
    ['a bad time', { ...REPORT, created_at: 'yesterday' }],
  ])('answers 400 for %s', async (_name, body) => {
    const { token } = await signIn('full');
    const response = await send(token, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request' });
  });

  it('answers 413 for a screenshot over 8 MiB', async () => {
    const { token } = await signIn('full');
    const data = 'A'.repeat(((8 * 1024 * 1024 + 1) / 3) * 4);
    const response = await send(token, { ...REPORT, screenshot: { type: 'image/png', data } });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'too_large' });
  });

  it('answers 413 for a body over 12 MiB', async () => {
    const { token } = await signIn('full');
    const response = await send(token, { ...REPORT, padding: 'x'.repeat(12 * 1024 * 1024) });
    expect(response.status).toBe(413);
  });

  it('answers 503 when no GitHub App is configured', async () => {
    app = testApp(db, new FakeIdentity({ 'code-ada': ADA }), { issues: null });
    const { token } = await signIn('full');
    const response = await send(token, REPORT);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'feedback_off' });
  });

  it('answers 502 when GitHub refuses', async () => {
    const { token } = await signIn('full');
    issues.failWith = 403;
    const response = await send(token, REPORT);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'github' });
  });
});

interface StoredFile {
  content: string;
  commit: string;
}

class FakeGitHub {
  readonly refs = new Map<string, string>();
  readonly files = new Map<string, StoredFile>();
  readonly issues: { title: string; body: string; labels: string[] }[] = [];
  readonly commits: { tree: string; parents: string[] }[] = [];
  readonly trees: unknown[] = [];
  tokensIssued = 0;
  issuesAsked = 0;
  issueGate: Promise<void> | null = null;
  private serial = 0;

  constructor(
    private readonly publicKey: CryptoKey,
    private readonly appId: string,
  ) {}

  readonly fetch = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('user-agent')).toBe('tessera-cloud');
    const auth = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = url.pathname;

    if (method === 'POST' && path === '/app/installations/77/access_tokens') {
      const verified = await jwtVerify(auth, this.publicKey, { issuer: this.appId }).catch(() => null);
      if (verified === null) return answer(401, { message: 'A JSON web token could not be decoded' });
      expect(verified.payload.exp! - verified.payload.iat!).toBeLessThanOrEqual(600);
      this.tokensIssued += 1;
      return answer(201, { token: this.token(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (auth !== this.token()) return answer(401, { message: 'Bad credentials' });

    const repo = '/repos/owner/repo';
    if (!path.startsWith(repo)) return answer(404, { message: 'Not Found' });
    const route = path.slice(repo.length);

    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(route);
    if (method === 'GET' && ref !== null) {
      const sha = this.refs.get(ref[1]!);
      return sha === undefined ? answer(404, {}) : answer(200, { object: { sha } });
    }
    if (method === 'POST' && route === '/git/trees') {
      this.trees.push(body.tree);
      return answer(201, { sha: this.sha('tree') });
    }
    if (method === 'POST' && route === '/git/commits') {
      this.commits.push(body as { tree: string; parents: string[] });
      return answer(201, { sha: this.sha('commit') });
    }
    if (method === 'POST' && route === '/git/refs') {
      const name = (body.ref as string).replace(/^refs\/heads\//, '');
      if (this.refs.has(name)) return answer(422, { message: 'Reference already exists' });
      this.refs.set(name, body.sha as string);
      return answer(201, {});
    }
    const contents = /^\/contents\/(.+)$/.exec(route);
    if (contents !== null) {
      const file = contents[1]!;
      const branch = method === 'GET' ? url.searchParams.get('ref')! : (body.branch as string);
      if (!this.refs.has(branch)) return answer(404, { message: 'No commit found for the ref' });
      const key = `${branch}:${file}`;
      const stored = this.files.get(key);
      if (method === 'GET') {
        if (stored === undefined) return answer(404, { message: 'Not Found' });
        return answer(200, { path: file, content: stored.content.replace(/(.{60})/g, '$1\n') });
      }
      if (stored !== undefined) return answer(422, { message: '"sha" wasn\'t supplied.' });
      const commit = this.sha('commit');
      this.files.set(key, { content: body.content as string, commit });
      return answer(201, { content: { path: file }, commit: { sha: commit } });
    }
    if (method === 'POST' && route === '/issues') {
      this.issuesAsked += 1;
      if (this.issueGate !== null) await this.issueGate;
      this.issues.push(body as { title: string; body: string; labels: string[] });
      const number = 100 + this.issues.length;
      return answer(201, { number, html_url: `https://github.com/owner/repo/issues/${String(number)}` });
    }
    return answer(404, { message: 'Not Found' });
  }) as unknown as typeof fetch;

  private token() {
    return 'ghs_installation_token';
  }

  private sha(kind: string) {
    this.serial += 1;
    return `${kind}${String(this.serial).padStart(4, '0')}`;
  }
}

function answer(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

async function throwawayKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const pkcs8 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

describe('githubTracker', () => {
  let key: { pem: string; publicKey: CryptoKey };
  let installations = 0;

  beforeAll(async () => {
    key = await throwawayKey();
  });

  function tracker(github: FakeGitHub) {
    installations += 1;
    return githubTracker({
      appId: '12345',
      privateKey: key.pem,
      installationId: '77',
      repo: 'owner/repo',
      branch: 'feedback-attachments',
      apiBase: `https://github-${String(installations)}.test`,
      fetch: github.fetch,
      claimWaitMs: 20,
    });
  }

  it('starts the branch, uploads the screenshot, files the issue and records it', async () => {
    const github = new FakeGitHub(key.publicKey, '12345');
    const issues = tracker(github);
    const issue = await issues.file(report({ screenshot: { type: 'image/png', data: PNG } }));

    expect(issue).toEqual({ number: 101, url: 'https://github.com/owner/repo/issues/101' });
    expect(github.commits).toEqual([{ message: expect.any(String) as unknown, tree: 'tree0001', parents: [] }]);
    expect(github.trees).toEqual([[expect.objectContaining({ path: 'README.md', type: 'blob' })]]);
    expect(github.refs.get('feedback-attachments')).toBe('commit0002');
    const screenshot = github.files.get('feedback-attachments:feedback/fb-0123456789abcdef/screenshot.png');
    expect(screenshot?.content).toBe(PNG);
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0]!.labels).toEqual(['feedback']);
    expect(github.issues[0]!.title).toBe('Bug: The ladder freezes');
    expect(github.issues[0]!.body).toContain(
      `![Screenshot](https://github.com/owner/repo/blob/${screenshot!.commit}/feedback/fb-0123456789abcdef/screenshot.png?raw=true)`,
    );
    const record = github.files.get('feedback-attachments:feedback/fb-0123456789abcdef/issue.json');
    expect(JSON.parse(atob(record!.content))).toEqual(issue);
  });

  it('answers the recorded issue for a report sent again, with one installation token', async () => {
    const github = new FakeGitHub(key.publicKey, '12345');
    const issues = tracker(github);
    const first = await issues.file(report());
    const again = await issues.file(report());
    expect(again).toEqual(first);
    expect(github.issues).toHaveLength(1);
    expect(github.commits).toHaveLength(1);
    expect(github.tokensIssued).toBe(1);
  });

  it('files one issue for the same report sent twice at once', async () => {
    const github = new FakeGitHub(key.publicKey, '12345');
    const issues = tracker(github);
    let release = () => {};
    github.issueGate = new Promise((resolve) => {
      release = resolve;
    });
    const first = issues.file(report());
    await vi.waitFor(() => {
      expect(github.issuesAsked).toBe(1);
    });
    const second = issues.file(report());
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    expect(await second).toEqual(await first);
    expect(github.issues).toHaveLength(1);
  });

  it('files a report whose earlier claim was left behind long ago', async () => {
    const github = new FakeGitHub(key.publicKey, '12345');
    github.refs.set('feedback-attachments', 'commit0000');
    github.files.set('feedback-attachments:feedback/fb-0123456789abcdef/claim.json', {
      content: btoa(JSON.stringify({ at: '2026-01-01T00:00:00Z' })),
      commit: 'commit0000',
    });
    const issue = await tracker(github).file(report());
    expect(issue.number).toBe(101);
    expect(github.issues).toHaveLength(1);
  });

  it('files on an existing branch and reuses a screenshot already uploaded', async () => {
    const github = new FakeGitHub(key.publicKey, '12345');
    github.refs.set('feedback-attachments', 'commit0000');
    github.files.set('feedback-attachments:feedback/fb-0123456789abcdef/screenshot.jpg', {
      content: PNG,
      commit: 'commit0000',
    });
    const issue = await tracker(github).file(report({ screenshot: { type: 'image/jpeg', data: PNG } }));
    expect(issue.number).toBe(101);
    expect(github.commits).toHaveLength(0);
    expect(github.issues[0]!.body).toContain(
      '![Screenshot](https://github.com/owner/repo/blob/feedback-attachments/feedback/fb-0123456789abcdef/screenshot.jpg?raw=true)',
    );
  });

  it('throws a tracker failure with the status when GitHub refuses', async () => {
    const github = new FakeGitHub(key.publicKey, '99999');
    const failure = await tracker(github)
      .file(report())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IssueTrackerFailed);
    expect(failure).toMatchObject({ status: 401, step: 'installation token' });
    expect(github.issues).toHaveLength(0);
  });

  it('throws a tracker failure when GitHub does not answer', async () => {
    const failing = (() => Promise.reject(new TypeError('network'))) as unknown as typeof fetch;
    const issues = githubTracker({
      appId: '12345',
      privateKey: key.pem,
      installationId: '77',
      repo: 'owner/repo',
      branch: 'feedback-attachments',
      apiBase: 'https://unreachable.test',
      fetch: failing,
    });
    await expect(issues.file(report())).rejects.toMatchObject({ name: 'IssueTrackerFailed', status: 0 });
  });
});

describe('feedbackIssue', () => {
  it('lays out the report', () => {
    const { title, body } = feedbackIssue(
      report({
        kind: 'idea',
        text: 'Line one\n\nLine two',
        steps: ['Open it', 'Look'],
        expected: 'Green',
        actual: 'Red',
        writtenUp: true,
        context: [{ key: 'os', label: 'OS', value: 'macOS 15', detail: null }],
      }),
      'https://github.com/owner/repo/blob/main/feedback/x/screenshot.png?raw=true',
    );
    expect(title).toBe('Idea: The ladder freezes');
    expect(body).toContain('**Idea** · Tessera 0.3.0 · report `fb-0123456789abcdef` · reporter `usr_0123`');
    expect(body).toContain('> Line one\n>\n> Line two');
    expect(body).toContain('### Steps\n\n1. Open it\n2. Look');
    expect(body).toContain('### Expected\n\nGreen');
    expect(body).toContain('### Actual\n\nRed');
    expect(body).toContain("_The reporter's own agent wrote this up");
    expect(body).toContain('### Screenshot\n\n![Screenshot](https://github.com/owner/repo/blob/main/');
    expect(body).toContain('| OS | macOS 15 |');
  });

  it('leaves out what the report does not have', () => {
    const { body } = feedbackIssue(report({ text: '' }), null);
    expect(body).not.toMatch(/###|^>|reviewed it/m);
  });

  it('turns mentions and issue references into plain text everywhere', () => {
    const { title, body } = feedbackIssue(
      report({
        title: 'Ping @octocat about #12',
        text: 'cc @octocat, see #12 and GH-7 and owner/repo#3',
        steps: ['@team look'],
        context: [{ key: 'note', label: '@lead', value: '#9', detail: null }],
      }),
      null,
    );
    for (const text of [title, body]) {
      expect(text).not.toMatch(/@[a-z]/i);
      expect(text).not.toMatch(/#\d/);
      expect(text).not.toMatch(/GH-\d/);
    }
    expect(body).toContain('@\u2060octocat');
    expect(body).toContain('#\u206012');
  });

  it('keeps HTML, fences and pipes from breaking out', () => {
    const { body } = feedbackIssue(
      report({
        text: '<img src=x> ```',
        context: [
          { key: 'cell', label: 'a|b', value: 'one\ntwo|three', detail: null },
          { key: 'log', label: 'Log', value: 'tail', detail: 'before\n```\n</details>\n````\nafter' },
        ],
      }),
      null,
    );
    expect(body).toContain('&lt;img src=x&gt;');
    expect(body).not.toContain('<img');
    expect(body).toContain('| a\\|b | one<br>two\\|three |');
    const fences = body.split('\n').filter((line) => line.startsWith('```'));
    expect(fences).toEqual(['```text', '```']);
    expect(body).not.toMatch(/`{3}(?!text\n|\n\n<\/details>)/);
  });

  it('trims the longest details first to stay under the limit', () => {
    const { body } = feedbackIssue(
      report({
        context: [
          { key: 'short', label: 'Short', value: 's', detail: 'kept whole' },
          ...Array.from({ length: 19 }, (_, index) => ({
            key: `log${String(index)}`,
            label: `Log ${String(index)}`,
            value: 'v',
            detail: 'x'.repeat(40_000),
          })),
        ],
      }),
      null,
    );
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body.length).toBeGreaterThan(MAX_BODY - 1000);
    expect(body).toContain('kept whole');
    expect(body.split(TRIMMED)).toHaveLength(20);
  });

  it('cuts the title to 256 characters', () => {
    const { title } = feedbackIssue(report({ title: 'x'.repeat(300) }), null);
    expect(title).toHaveLength(256);
  });
});
