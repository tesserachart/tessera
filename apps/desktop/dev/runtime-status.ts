import type { DevRuntimeState } from '@tessera/bridge';

export const EXIT_DATA_DIR_LOCKED = 3;

export const EXIT_OTHER_CHECKOUT = 4;

export interface RuntimeStatus {
  state: DevRuntimeState;
  message: string;
}

export function startingStatus(mode: 'cargo' | 'bin'): RuntimeStatus {
  return {
    state: 'starting',
    message:
      mode === 'cargo'
        ? 'The dev server is starting the runtime (cargo builds it first; progress is in the bun run dev terminal).'
        : 'The dev server is starting the runtime.',
  };
}

// eslint-disable-next-line no-control-regex -- strips the terminal colour codes cargo and the runtime print
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function failedStatus(code: number | null, how: string, early: string): RuntimeStatus {
  if (code === EXIT_DATA_DIR_LOCKED) {
    const line = early
      .replace(ANSI, '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('is in use by another tessera-runtime'));
    const reason =
      line?.replace(/^tessera-runtime:\s*/, '') ?? 'the data directory is in use by another tessera-runtime';
    return {
      state: 'data_dir_locked',
      message: `The runtime cannot start: ${reason}. The dev server keeps retrying and connects once it is free.`,
    };
  }
  if (code === EXIT_OTHER_CHECKOUT) {
    const line = early
      .replace(ANSI, '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('was built from the checkout'));
    const reason =
      line?.replace(/^tessera-runtime:\s*/, '') ??
      'it was built from another checkout (a cargo target directory shared between checkouts)';
    return { state: 'failed', message: `The runtime cannot start: ${reason}.` };
  }
  return {
    state: 'failed',
    message:
      `The runtime failed to start (${how}); its output is in the bun run dev terminal. ` +
      'Fix the error and save: the dev server retries by itself.',
  };
}

export function unavailableBody(status: RuntimeStatus): string {
  return JSON.stringify({ error: 'runtime unavailable', state: status.state, message: status.message });
}
