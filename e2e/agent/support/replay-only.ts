/**
 * The e2e runner replays a committed recording before it calls an executor, so a step that replays
 * never reaches this code.
 */
import type { StepExecutor } from 'e2e';

export const RERECORD_HINT =
  'Re-record on a machine signed in to the model (`bunx e2e login openai --device` once): ' +
  '`bun run e2e:agent` (or `bun run e2e:agent <file>`), review the changed files under .e2e/cache and commit them.';

export const replayOnly: StepExecutor = {
  name: 'tessera-replay-only',
  version: '1',
  cache: 'inherit',
  runStep(ctx) {
    const prefix = ctx.replayedPrefix;
    const why = prefix
      ? `its recording stopped after ${String(prefix.replayedActions.length)} of ${String(prefix.totalActions)} actions (${prefix.stopReason})`
      : ctx.attempt.index > 0
        ? 'a retry never replays (run with --retries 0)'
        : 'no recording in .e2e/cache matches it';
    return Promise.resolve({
      status: 'blocked',
      errorCode: 'TEST_SETUP_FAILED',
      summary: `Replay-only run: the ${ctx.step.kind} step "${ctx.step.instruction}" would need the model because ${why}. ${RERECORD_HINT}`,
    });
  },
};
