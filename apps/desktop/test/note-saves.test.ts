import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEchoGuard } from '../src/app/echoGuard.ts';
import { noteSaves, SAVE_AGAIN_MS, type SaveState } from '../src/areas/journal/parts/noteSaves.ts';

afterEach(() => {
  vi.useRealTimers();
});

function notes() {
  const sent: { markdown: string; ok: () => void; fail: () => void }[] = [];
  const shown: SaveState[] = [];
  const saves = noteSaves({
    saved: 'Waited for the pullback.',
    key: 'note',
    guard: createEchoGuard(),
    show: (s) => shown.push(s),
  });
  saves.sendWith(
    (markdown) =>
      new Promise<void>((ok, fail) => {
        sent.push({ markdown, ok, fail: () => fail(new Error('the disk is full')) });
      }),
  );
  return { saves, sent, shown };
}

describe('a journal note’s autosave', () => {
  it('says what the newest save did, whichever answers last', async () => {
    const { saves, sent, shown } = notes();
    saves.save('Waited.');
    saves.save('Waited for it.');
    sent[1]!.ok();
    sent[0]!.fail();
    await vi.waitFor(() => expect(shown.at(-1)).toBe('saved'));
    await Promise.resolve();
    expect(shown.at(-1)).toBe('saved');
  });

  it('sends a failed save again, by itself and when the same text is saved again', async () => {
    vi.useFakeTimers();
    const { saves, sent, shown } = notes();
    saves.save('Took the trade early.');
    sent[0]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.at(-1)).toBe('failed');
    saves.save('Took the trade early.');
    expect(sent.map((s) => s.markdown)).toEqual(['Took the trade early.', 'Took the trade early.']);
    sent[1]!.fail();
    await vi.advanceTimersByTimeAsync(SAVE_AGAIN_MS);
    expect(sent).toHaveLength(3);
    sent[2]!.ok();
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.at(-1)).toBe('saved');
  });

  it('saves nothing it already has, and tries nothing again once stopped', async () => {
    vi.useFakeTimers();
    const { saves, sent } = notes();
    saves.save('Waited for the pullback.');
    expect(sent).toEqual([]);
    saves.save('Sized down.');
    saves.stop();
    sent[0]!.fail();
    await vi.advanceTimersByTimeAsync(SAVE_AGAIN_MS * 2);
    expect(sent).toHaveLength(1);
  });
});
