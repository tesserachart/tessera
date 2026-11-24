import { constants } from 'node:os';

const SHELL_STATUS_AFTER_SIGINT = 128 + constants.signals.SIGINT;
const SHELL_STATUS_AFTER_SIGTERM = 128 + constants.signals.SIGTERM;

export function launcherExitStatus(
  stopSignal: NodeJS.Signals | null,
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  const stopped =
    signal === 'SIGINT' ||
    signal === 'SIGTERM' ||
    code === 0 ||
    code === SHELL_STATUS_AFTER_SIGINT ||
    code === SHELL_STATUS_AFTER_SIGTERM;
  if (stopSignal !== null && stopped) return 0;
  if (signal !== null) return 1;
  return code ?? 1;
}
