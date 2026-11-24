import { describe, expect, it } from 'vitest';
import { decide, dropped, MAX_ATTEMPTS, MAX_WAIT_SECONDS, type Job } from './runner-dropped.ts';

const checkout = 'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';

const refusedJob: Job = {
  id: 126970960008,
  name: 'Check',
  conclusion: 'failure',
  completed_at: '2026-11-05T00:46:57Z',
  steps: [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Set up runner', conclusion: 'failure' },
    { name: checkout, conclusion: 'skipped' },
    { name: 'bun run check --job ts --skip vitest,perf', conclusion: 'failure' },
  ],
};
const refusedLog = `2026-11-05T00:46:50.4873611Z A job started hook has been configured by the self-hosted runner administrator
2026-11-05T00:46:50.5066765Z ##[error]You used all 200 sandbox starts included in the last 24 hours.
Your running sandboxes keep running. New ones can start again at 02:17 UTC.
Then try again.
2026-11-05T00:46:50.5623260Z error: Script not found "check"`;

const shutdownJob: Job = {
  id: 126932334587,
  name: 'Check',
  conclusion: 'failure',
  completed_at: '2026-11-04T23:26:35Z',
  steps: [
    { name: checkout, conclusion: 'success' },
    { name: 'bun run check --job ts --skip vitest,perf', conclusion: 'cancelled' },
  ],
};
const shutdownLog = `2026-11-04T23:26:10.3236894Z @tessera/bridge typecheck: Exited with code 0
2026-11-04T23:26:17.1300314Z ##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.
2026-11-04T23:26:29.8191730Z ##[error]The operation was canceled.`;

const testJob: Job = {
  id: 1,
  name: 'Check',
  conclusion: 'failure',
  completed_at: '2026-11-05T03:00:00Z',
  steps: [
    { name: checkout, conclusion: 'success' },
    { name: 'bun run check --only vitest', conclusion: 'failure' },
  ],
};
const testLog = `FAIL  scripts/workflows.test.ts > the workflows > pin every action
##[error]Process completed with exit code 1.`;

const windowsJob = (conclusion: string): Job => ({
  id: 2,
  name: 'Check (Windows)',
  conclusion,
  completed_at: '2026-11-05T01:30:00Z',
  steps: [
    { name: 'Git Bash on PATH', conclusion: 'success' },
    { name: checkout, conclusion: 'success' },
  ],
});

const nextestJob: Job = {
  id: 127533450599,
  name: 'Check (Windows)',
  conclusion: 'failure',
  completed_at: '2026-11-05T21:12:27Z',
  steps: [
    { name: 'Git Bash on PATH', conclusion: 'success' },
    { name: checkout, conclusion: 'success' },
    { name: 'cargo clippy (Windows)', conclusion: 'success' },
    { name: 'cargo nextest (Windows)', conclusion: 'failure' },
  ],
};
const nextestLog = `2026-11-05T21:12:01.3400803Z \u001b[31;1m        FAIL\u001b[0m [  15.855s] (1233/1592) \u001b[35;1mtessera-rithmic::orders\u001b[0m \u001b[34;1mtessera_moves_a_rithmic_stop_to_breakeven_and_then_trails_it_by_modifies\u001b[0m
2026-11-05T21:12:15.3756576Z \u001b[31;1merror\u001b[0m: test run failed
2026-11-05T21:12:15.4008531Z ##[error]Process completed with exit code 100.`;

const at = (iso: string) => new Date(iso);

describe('a job the runner dropped', () => {
  it('is one the sandbox refused to start, rerun once its starts come back', () => {
    expect(dropped(refusedJob, refusedLog, at('2026-11-05T00:47:00Z'))).toEqual({
      job: 'Check',
      cause: 'refused',
      startsAgainAt: at('2026-11-05T02:17:00Z'),
    });
  });

  it('reads a reset after midnight as the next day, and one just past as now', () => {
    const lateJob = { ...refusedJob, completed_at: '2026-11-04T23:50:00Z' };
    expect(dropped(lateJob, refusedLog, at('2026-11-04T23:50:00Z'))).toMatchObject({
      startsAgainAt: at('2026-11-05T02:17:00Z'),
    });
    const pastJob = { ...refusedJob, completed_at: '2026-11-04T20:57:37Z' };
    const pastLog = refusedLog.replace('02:17', '20:54');
    expect(dropped(pastJob, pastLog, at('2026-11-04T20:58:00Z'))).toMatchObject({
      startsAgainAt: at('2026-11-04T20:54:00Z'),
    });
  });

  it('is one whose runner was stopped or lost while it ran', () => {
    expect(dropped(shutdownJob, shutdownLog, at('2026-11-04T23:27:00Z'))).toEqual({ job: 'Check', cause: 'shutdown' });
    const lost = 'The self-hosted runner: tessera-boat-1 lost communication with the server.';
    expect(dropped(testJob, lost, at('2026-11-05T03:00:00Z'))).toEqual({ job: 'Check', cause: 'shutdown' });
  });

  it('is one that never got a checkout, whatever the runner said', () => {
    expect(dropped(refusedJob, 'error: Script not found "check"', at('2026-11-05T00:47:00Z'))).toEqual({
      job: 'Check',
      cause: 'no checkout',
    });
  });

  it('is never one that checked out and failed a test', () => {
    expect(dropped(testJob, testLog, at('2026-11-05T03:00:00Z'))).toBeNull();
  });

  it('is never a Windows job whose tests failed, however coloured its log', () => {
    expect(dropped(nextestJob, nextestLog, at('2026-11-05T21:19:39Z'))).toBeNull();
  });

  it('is a Windows job whose runner stopped amid coloured test output', () => {
    expect(dropped(nextestJob, `${nextestLog}\n${shutdownLog}`, at('2026-11-05T21:19:39Z'))).toEqual({
      job: 'Check (Windows)',
      cause: 'shutdown',
    });
  });
});

describe('the rerun', () => {
  it('waits for the sandbox starts to come back, a minute past the reset', () => {
    expect(decide([{ job: refusedJob, text: refusedLog }], 1, at('2026-11-05T01:00:00Z'))).toEqual({
      rerun: true,
      waitSeconds: 78 * 60,
      report: 'Check: the runner refused to start it until 02:17 UTC',
    });
  });

  it('starts at once after a runner stopped mid-job', () => {
    expect(decide([{ job: shutdownJob, text: shutdownLog }], 1, at('2026-11-04T23:30:00Z'))).toMatchObject({
      rerun: true,
      waitSeconds: 0,
    });
  });

  it('covers every failed job, so one real failure keeps the run red', () => {
    const decision = decide(
      [
        { job: refusedJob, text: refusedLog },
        { job: { ...testJob, name: 'Check (Windows)' }, text: testLog },
      ],
      1,
      at('2026-11-05T01:00:00Z'),
    );
    expect(decision).toEqual({
      rerun: false,
      waitSeconds: 0,
      report: 'Check (Windows) failed on its own; a rerun would not change it.',
    });
  });

  it('reruns two dropped jobs once both can start', () => {
    const decision = decide(
      [
        { job: refusedJob, text: refusedLog },
        { job: windowsJob('failure'), text: shutdownLog },
      ],
      1,
      at('2026-11-05T02:00:00Z'),
    );
    expect(decision.rerun).toBe(true);
    expect(decision.waitSeconds).toBe(18 * 60);
    expect(decision.report.split('\n')).toHaveLength(2);
  });

  it('never waits longer than one hosted job may run', () => {
    const decision = decide([{ job: refusedJob, text: refusedLog }], 1, at('2026-11-04T18:00:00Z'));
    expect(decision.waitSeconds).toBe(MAX_WAIT_SECONDS);
  });

  it('stops after a few attempts, and does nothing when nothing failed', () => {
    expect(decide([{ job: shutdownJob, text: shutdownLog }], MAX_ATTEMPTS, at('2026-11-05T00:00:00Z')).rerun).toBe(
      false,
    );
    expect(decide([], 1, at('2026-11-05T00:00:00Z'))).toEqual({
      rerun: false,
      waitSeconds: 0,
      report: 'No job failed.',
    });
  });
});
