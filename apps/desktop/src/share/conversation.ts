import type { SharedTurn, SharedWork } from '@tessera/protocol';
import { formatDuration } from '@tessera/ui';

type AnalystTurn = Extract<SharedTurn, { role: 'analyst' }>;

function count(n: number, one: string): string {
  return `${String(n)} ${one}${n === 1 ? '' : 's'}`;
}

export function workWords(turn: AnalystTurn): string {
  const steps = count(turn.work.length, 'step');
  return turn.workedMs === null ? steps : `Worked for ${formatDuration(turn.workedMs)} · ${steps}`;
}

export function workMeta(work: SharedWork): string | null {
  return work.failed ? 'failed' : work.meta;
}

export function filesWords(files: number): string | null {
  return files > 0 ? `${count(files, 'attachment')} left out` : null;
}
