import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

export const MAX_ATTEMPTS = 3;
export const MAX_WAIT_SECONDS = 5 * 60 * 60;
const MARGIN_SECONDS = 60;
const HALF_DAY_MS = 12 * 60 * 60 * 1000;
const DAY_MS = 2 * HALF_DAY_MS;

const SHUTDOWN = ['The runner has received a shutdown signal', 'lost communication with the server'];
const STARTS_AGAIN = /New ones can start again at (\d{2}):(\d{2}) UTC/;
const CHECKOUT = 'Run actions/checkout@';

export interface Step {
  name: string;
  conclusion: string | null;
}

export interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  completed_at: string | null;
  steps?: Step[];
}

export type Drop =
  | { job: string; cause: 'refused'; startsAgainAt: Date }
  | { job: string; cause: 'shutdown' }
  | { job: string; cause: 'no checkout' };

export interface Decision {
  rerun: boolean;
  waitSeconds: number;
  report: string;
}

function startsAgainAt(hours: number, minutes: number, refusedAt: Date): Date {
  const day = Date.UTC(refusedAt.getUTCFullYear(), refusedAt.getUTCMonth(), refusedAt.getUTCDate());
  const sameDay = day + (hours * 60 + minutes) * 60 * 1000;
  return new Date(sameDay < refusedAt.getTime() - HALF_DAY_MS ? sameDay + DAY_MS : sameDay);
}

export function dropped(job: Job, text: string, now: Date): Drop | null {
  const refused = STARTS_AGAIN.exec(text);
  if (refused) {
    const refusedAt = job.completed_at ? new Date(job.completed_at) : now;
    return { job: job.name, cause: 'refused', startsAgainAt: startsAgainAt(+refused[1]!, +refused[2]!, refusedAt) };
  }
  if (SHUTDOWN.some((message) => text.includes(message))) return { job: job.name, cause: 'shutdown' };
  const checkouts = (job.steps ?? []).filter((step) => step.name.startsWith(CHECKOUT));
  if (checkouts.length > 0 && checkouts.every((step) => step.conclusion !== 'success')) {
    return { job: job.name, cause: 'no checkout' };
  }
  return null;
}

const describe = (drop: Drop): string => {
  switch (drop.cause) {
    case 'refused':
      return `${drop.job}: the runner refused to start it until ${drop.startsAgainAt.toISOString().slice(11, 16)} UTC`;
    case 'shutdown':
      return `${drop.job}: its runner stopped while it ran`;
    case 'no checkout':
      return `${drop.job}: it never got a checkout`;
  }
};

export function decide(failed: readonly { job: Job; text: string }[], attempt: number, now: Date): Decision {
  const keep = (report: string): Decision => ({ rerun: false, waitSeconds: 0, report });
  if (failed.length === 0) return keep('No job failed.');
  const drops: Drop[] = [];
  for (const { job, text } of failed) {
    const drop = dropped(job, text, now);
    if (!drop) return keep(`${job.name} failed on its own; a rerun would not change it.`);
    drops.push(drop);
  }
  const report = drops.map(describe).join('\n');
  if (attempt >= MAX_ATTEMPTS) return keep(`${report}\nAlready run ${String(attempt)} times; leaving it.`);
  const until = Math.max(
    now.getTime(),
    ...drops.map((drop) => (drop.cause === 'refused' ? drop.startsAgainAt.getTime() + MARGIN_SECONDS * 1000 : 0)),
  );
  const waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.ceil((until - now.getTime()) / 1000));
  return { rerun: true, waitSeconds, report };
}

function gh(...args: string[]): string {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

async function jobLog(repo: string, job: number): Promise<string> {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set');
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const asked = await fetch(`${api}/repos/${repo}/actions/jobs/${String(job)}/logs`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    redirect: 'manual',
  });
  const location = asked.headers.get('location');
  const log = location ? await fetch(location) : asked;
  if (!log.ok) throw new Error(`job ${String(job)} logs: HTTP ${String(log.status)}`);
  return log.text();
}

async function orEmpty(what: string, read: () => string | Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (e) {
    console.error(`${what} not read: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { run: { type: 'string' }, attempt: { type: 'string' } } });
  const repo = process.env.GITHUB_REPOSITORY;
  const attempt = Number(values.attempt);
  if (!repo || !values.run || !Number.isInteger(attempt) || attempt < 1) {
    console.error('usage: GITHUB_REPOSITORY=<owner/repo> bun scripts/runner-dropped.ts --run <id> --attempt <n>');
    process.exit(2);
  }
  const jobs = JSON.parse(
    gh(`repos/${repo}/actions/runs/${values.run}/attempts/${String(attempt)}/jobs?per_page=100`, '--jq', '.jobs'),
  ) as Job[];
  const failed = await Promise.all(
    jobs
      .filter((job) => job.conclusion === 'failure')
      .map(async (job) => ({
        job,
        text: [
          await orEmpty(`${job.name} log`, () => jobLog(repo, job.id)),
          await orEmpty(`${job.name} annotations`, () =>
            gh(`repos/${repo}/check-runs/${String(job.id)}/annotations`, '--jq', '.[].message'),
          ),
        ].join('\n'),
      })),
  );
  const { rerun, waitSeconds, report } = decide(failed, attempt, new Date());
  console.error(report);
  console.info(`rerun=${String(rerun)}\nwait=${String(waitSeconds)}`);
}
