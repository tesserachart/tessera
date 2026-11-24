import { describe, expect, it } from 'vitest';
import { createOverlay } from '../src/app/overlay.ts';

function deferred() {
  let answer!: () => void;
  let refuse!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    answer = res;
    refuse = rej;
  });
  return { promise, answer, refuse };
}

describe('overlay', () => {
  it('shows each edit at once, and an older read never undoes a newer edit', async () => {
    const o = createOverlay();
    o.settle('reviewed', false);
    const a = deferred();
    const b = deferred();
    const first = o.write('reviewed', true, () => a.promise);
    expect(o.shown('reviewed', false)).toBe(true);
    const second = o.write('reviewed', false, () => b.promise);
    a.answer();
    await first;
    o.settle('reviewed', true);
    expect(o.shown('reviewed', true)).toBe(false);
    b.answer();
    await second;
    o.settle('reviewed', false);
    expect(o.shown('reviewed', false)).toBe(false);
  });

  it('takes news from elsewhere once nothing of its own is on its way', async () => {
    const o = createOverlay();
    o.settle('rating', 2);
    await o.write('rating', 4, () => Promise.resolve());
    o.settle('rating', 4);
    o.settle('rating', 5);
    expect(o.shown('rating', 5)).toBe(5);
  });

  it('shows the runtime again after a refusal', async () => {
    const o = createOverlay();
    o.settle('tags', ['a']);
    await expect(o.write('tags', ['a', 'b'], () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(o.shown('tags', ['a'])).toEqual(['a']);
  });

  it('keeps a draft being typed over any read, until it is sent and said back', async () => {
    const o = createOverlay();
    o.settle('rules', ['one']);
    o.edit('rules', ['one', '']);
    o.settle('rules', ['one', 'other']);
    expect(o.shown('rules', ['one', 'other'])).toEqual(['one', '']);
    await o.write('rules', ['one', 'two'], () => Promise.resolve());
    o.settle('rules', ['one', 'two']);
    expect(o.shown('rules', ['one', 'two'])).toEqual(['one', 'two']);
  });
});
