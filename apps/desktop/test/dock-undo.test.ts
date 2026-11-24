import { afterEach, describe, expect, it, vi } from 'vitest';
import { deskToasts } from '../src/workspace/dock/deskToasts.ts';
import { dismissUndo, offerUndo, UNDO_MS, undoStore } from '../src/workspace/dock/undo.ts';
import { patch, read } from '../src/app/store.ts';

const before = { layoutId: 'default', tree: {} as never, charts: {} };

afterEach(() => {
  deskToasts.clear();
  vi.useRealTimers();
  patch(undoStore, { offer: null, open: false });
});

const standing = () => deskToasts.getSnapshot().filter((t) => t.state === 'open');

describe('the dock’s undo (spec §2.5)', () => {
  it('offers a change back for 8 seconds, then ends', () => {
    vi.useFakeTimers();
    offerUndo('Closed NQ Z6 1m', before);
    expect(read(undoStore)).toMatchObject({ open: true, offer: { text: 'Closed NQ Z6 1m' } });
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(read(undoStore).open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(read(undoStore).open).toBe(false);
    expect(read(undoStore).offer?.text).toBe('Closed NQ Z6 1m');
  });

  it('a newer change replaces the offer, and the older one’s time never ends it', () => {
    vi.useFakeTimers();
    offerUndo('Floated Markets', before);
    const first = read(undoStore).offer!.seq;
    vi.advanceTimersByTime(5000);
    offerUndo('Moved Markets to the right side', before);
    dismissUndo(first);
    expect(read(undoStore)).toMatchObject({ open: true, offer: { text: 'Moved Markets to the right side' } });
    vi.advanceTimersByTime(UNDO_MS);
    expect(read(undoStore).open).toBe(false);
  });

  it('says the change in a toast with Undo, and the toast going ends the offer', () => {
    vi.useFakeTimers();
    offerUndo('Closed NQ Z6 1m', before);
    expect(standing().map((t) => [t.title, t.action?.label, t.ms])).toEqual([['Closed NQ Z6 1m', 'Undo', UNDO_MS]]);
    offerUndo('Floated Markets', before);
    expect(standing().map((t) => t.title)).toEqual(['Floated Markets']);
    expect(read(undoStore).open).toBe(true);
    deskToasts.pause();
    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(read(undoStore).open).toBe(true);
    deskToasts.resume();
    deskToasts.dismiss(standing()[0]!.id);
    expect(read(undoStore)).toMatchObject({ open: false, offer: { text: 'Floated Markets' } });
    offerUndo('Moved Markets to the right side', before);
    dismissUndo();
    expect(standing()).toEqual([]);
  });

  it('offers nothing without a dock to go back to', () => {
    offerUndo('Closed NQ Z6 1m', null);
    expect(read(undoStore).open).toBe(false);
  });
});
