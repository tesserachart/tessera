import type { EchoGuard } from '../../../app/echoGuard.ts';

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export const SAVE_AGAIN_MS = 3_000;

export interface NoteSaves {
  sendWith(send: (markdown: string) => Promise<unknown>): void;
  save(markdown: string): void;
  agree(markdown: string): void;
  stop(): void;
}

export function noteSaves(o: {
  readonly saved: string;
  readonly key: string;
  readonly guard: EchoGuard;
  readonly show: (state: SaveState) => void;
}): NoteSaves {
  let saved: string | null = o.saved;
  let again: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let send: (markdown: string) => Promise<unknown> = () => Promise.reject(new Error('nowhere to save'));
  const stopAgain = () => {
    if (again) clearTimeout(again);
    again = null;
  };
  const save = (markdown: string) => {
    if (markdown === saved) return;
    stopAgain();
    saved = markdown;
    const done = o.guard.write(o.key, markdown);
    o.show('saving');
    send(markdown).then(
      () => {
        if (done()) o.show('saved');
      },
      () => {
        if (!done()) return;
        saved = null;
        o.show('failed');
        if (stopped) return;
        again = setTimeout(() => {
          again = null;
          save(markdown);
        }, SAVE_AGAIN_MS);
      },
    );
  };
  return {
    sendWith: (to) => {
      send = to;
    },
    save,
    agree: (markdown) => {
      saved = markdown;
    },
    stop: () => {
      stopped = true;
      stopAgain();
    },
  };
}
