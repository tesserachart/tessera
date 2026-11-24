import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

import { type FiledIssue, type FiledReport, type IssueTracker, IssueTrackerFailed } from './feedback.ts';
import { feedbackIssue } from './feedbackIssue.ts';

const GITHUB_API = 'https://api.github.com';
export const DEFAULT_FEEDBACK_BRANCH = 'feedback-attachments';
const FEEDBACK_LABEL = 'feedback';

const TIMEOUT_MS = 15_000;
const TOKEN_MARGIN_MS = 60_000;
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 540;
const CLAIM_WAIT_MS = 1_000;
const CLAIM_WAITS = 20;
const CLAIM_STALE_MS = 10 * 60_000;

const BRANCH_README = [
  '# Feedback attachments',
  '',
  'Tessera Cloud writes the files of in-app feedback reports here: `feedback/<report id>/claim.json`, written',
  'once by the request that files the report, `feedback/<report id>/screenshot.*` and',
  '`feedback/<report id>/issue.json`, the issue each report became. Nothing on this branch is merged anywhere.',
  '',
].join('\n');

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
  repo: string;
  branch: string;
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  claimWaitMs?: number;
}

const InstallationToken = z.object({ token: z.string(), expires_at: z.string() });
const Sha = z.object({ sha: z.string() });
const Contents = z.object({ path: z.string(), content: z.string().default('') });
const Written = z.object({ content: z.object({ path: z.string() }), commit: Sha });
const CreatedIssue = z.object({ number: z.number(), html_url: z.string() });
const IssueRecord = z.object({ number: z.number(), url: z.string() });
const ClaimRecord = z.object({ at: z.string() });

interface CachedToken {
  token: string;
  renewAt: number;
}

const tokens = new Map<string, CachedToken>();

interface Answer {
  status: number;
  body: unknown;
}

export function githubTracker(config: GitHubAppConfig): IssueTracker {
  const api = (config.apiBase ?? GITHUB_API).replace(/\/+$/, '');
  const fetcher = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? TIMEOUT_MS;
  const claimWaitMs = config.claimWaitMs ?? CLAIM_WAIT_MS;
  const cacheKey = `${api}|${config.appId}|${config.installationId}`;
  const repo = `/repos/${config.repo}`;
  const branch = config.branch;
  const onBranch = `?ref=${encodeURIComponent(branch)}`;

  async function call(
    step: string,
    method: string,
    path: string,
    options: { auth: string; body?: unknown; allow?: readonly number[] },
  ): Promise<Answer> {
    let response: Response;
    try {
      response = await fetcher(`${api}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'tessera-cloud',
          authorization: `Bearer ${options.auth}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new IssueTrackerFailed(0, step);
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok || options.allow?.includes(response.status) === true) return { status: response.status, body };
    if (response.status === 401) tokens.delete(cacheKey);
    throw new IssueTrackerFailed(response.status, step);
  }

  function parsed<T>(step: string, schema: z.ZodType<T>, answer: Answer): T {
    const result = schema.safeParse(answer.body);
    if (!result.success) throw new IssueTrackerFailed(answer.status, `${step} (unexpected answer)`);
    return result.data;
  }

  async function installationToken(): Promise<string> {
    const cached = tokens.get(cacheKey);
    if (cached !== undefined && cached.renewAt > Date.now()) return cached.token;
    const key = await importPKCS8(config.privateKey, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - JWT_BACKDATE_S)
      .setExpirationTime(now + JWT_LIFETIME_S)
      .setIssuer(config.appId)
      .sign(key);
    const step = 'installation token';
    const answer = await call(step, 'POST', `/app/installations/${config.installationId}/access_tokens`, {
      auth: jwt,
    });
    const { token, expires_at: expiresAt } = parsed(step, InstallationToken, answer);
    tokens.set(cacheKey, { token, renewAt: Date.parse(expiresAt) - TOKEN_MARGIN_MS });
    return token;
  }

  async function filedBefore(auth: string, id: string): Promise<FiledIssue | null> {
    const step = 'read issue record';
    const answer = await call(step, 'GET', `${repo}/contents/feedback/${id}/issue.json${onBranch}`, {
      auth,
      allow: [404],
    });
    if (answer.status === 404) return null;
    const { content } = parsed(step, Contents, answer);
    let record: unknown;
    try {
      record = JSON.parse(atob(content.replace(/\s/g, '')));
    } catch {
      throw new IssueTrackerFailed(answer.status, `${step} (unreadable)`);
    }
    return parsed(step, IssueRecord, { status: answer.status, body: record });
  }

  async function claim(auth: string, id: string): Promise<boolean> {
    const written = await call('claim report', 'PUT', `${repo}/contents/feedback/${id}/claim.json`, {
      auth,
      body: { message: `Filing ${id}`, content: btoa(JSON.stringify({ at: new Date().toISOString() })), branch },
      allow: [422],
    });
    return written.status !== 422;
  }

  async function claimedAt(auth: string, id: string): Promise<number | null> {
    const step = 'read claim';
    const answer = await call(step, 'GET', `${repo}/contents/feedback/${id}/claim.json${onBranch}`, {
      auth,
      allow: [404],
    });
    if (answer.status === 404) return null;
    const { content } = parsed(step, Contents, answer);
    try {
      const record = ClaimRecord.parse(JSON.parse(atob(content.replace(/\s/g, ''))));
      return Date.parse(record.at);
    } catch {
      return null;
    }
  }

  async function filedByAnother(auth: string, id: string): Promise<FiledIssue | null> {
    const at = await claimedAt(auth, id);
    if (at === null || Date.now() - at > CLAIM_STALE_MS) return null;
    for (let wait = 0; wait < CLAIM_WAITS; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, claimWaitMs));
      const filed = await filedBefore(auth, id);
      if (filed !== null) return filed;
    }
    throw new IssueTrackerFailed(409, 'wait for the report another request is filing');
  }

  async function ensureBranch(auth: string): Promise<void> {
    const found = await call('read branch', 'GET', `${repo}/git/ref/heads/${branch}`, { auth, allow: [404] });
    if (found.status !== 404) return;
    const tree = parsed(
      'create branch tree',
      Sha,
      await call('create branch tree', 'POST', `${repo}/git/trees`, {
        auth,
        body: { tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: BRANCH_README }] },
      }),
    );
    const commit = parsed(
      'create branch commit',
      Sha,
      await call('create branch commit', 'POST', `${repo}/git/commits`, {
        auth,
        body: { message: 'Start the feedback attachments branch', tree: tree.sha, parents: [] },
      }),
    );
    await call('create branch', 'POST', `${repo}/git/refs`, {
      auth,
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
      allow: [422],
    });
  }

  async function uploadScreenshot(auth: string, report: FiledReport): Promise<string | null> {
    const shot = report.screenshot;
    if (shot === null) return null;
    const extension = shot.type === 'image/png' ? 'png' : 'jpg';
    const path = `feedback/${report.id}/screenshot.${extension}`;
    const step = 'upload screenshot';
    const written = await call(step, 'PUT', `${repo}/contents/${path}`, {
      auth,
      body: { message: `Screenshot for ${report.id}`, content: shot.data, branch },
      allow: [422],
    });
    if (written.status !== 422) {
      const { content, commit } = parsed(step, Written, written);
      return blobUrl(commit.sha, content.path);
    }
    const existing = parsed(
      'read screenshot',
      Contents,
      await call('read screenshot', 'GET', `${repo}/contents/${path}${onBranch}`, { auth }),
    );
    return blobUrl(branch, existing.path);
  }

  function blobUrl(ref: string, path: string): string {
    return `https://github.com/${config.repo}/blob/${ref}/${path}?raw=true`;
  }

  async function recordIssue(auth: string, id: string, issue: FiledIssue): Promise<void> {
    try {
      await call('write issue record', 'PUT', `${repo}/contents/feedback/${id}/issue.json`, {
        auth,
        body: { message: `Issue for ${id}`, content: btoa(JSON.stringify(issue)), branch },
        allow: [422],
      });
    } catch (error) {
      if (!(error instanceof IssueTrackerFailed)) throw error;
      console.error('feedback: issue filed but its record was not written', id, issue.number, error.status);
    }
  }

  return {
    async file(report) {
      const auth = await installationToken();
      const before = await filedBefore(auth, report.id);
      if (before !== null) return before;
      await ensureBranch(auth);
      if (!(await claim(auth, report.id))) {
        const filed = await filedByAnother(auth, report.id);
        if (filed !== null) return filed;
      }
      const screenshotUrl = await uploadScreenshot(auth, report);
      const draft = feedbackIssue(report, screenshotUrl);
      const step = 'create issue';
      const created = parsed(
        step,
        CreatedIssue,
        await call(step, 'POST', `${repo}/issues`, {
          auth,
          body: { title: draft.title, body: draft.body, labels: [FEEDBACK_LABEL] },
        }),
      );
      const issue = { number: created.number, url: created.html_url };
      await recordIssue(auth, report.id, issue);
      return issue;
    },
  };
}

export function privateKeyPem(secret: string): string {
  return secret.replace(/\\n/g, '\n');
}
