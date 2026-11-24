import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterPaint, afterShown, useLoadOnceShown, type Arrival } from '../src/app/onceShown.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const painted = async () => {
  vi.advanceTimersToNextFrame();
  await vi.advanceTimersByTimeAsync(1);
};

function playing(endTime: number): { animation: Animation; end: () => void } {
  let end: () => void = () => undefined;
  const finished = new Promise<Animation>((done) => (end = () => done(animation)));
  const animation = {
    playState: 'running',
    effect: { getComputedTiming: () => ({ endTime }) },
    finished,
  } as unknown as Animation;
  return { animation, end };
}

function animations(list: Animation[]) {
  Object.defineProperty(document, 'getAnimations', { value: () => list, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(document, 'getAnimations');
});

describe('work that waits for the next frame to be drawn', () => {
  it('starts in the task after that frame, once', () => {
    const run = vi.fn();
    afterPaint(run);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersToNextFrame();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('still starts when no frame comes, as in a hidden window', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    const run = vi.fn();
    afterPaint(run);
    vi.advanceTimersByTime(249);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never starts once stopped', () => {
    const run = vi.fn();
    afterPaint(run)();
    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(1_000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('work that waits until a surface is shown', () => {
  it('lets the surface’s entrance play to its end, then waits for that frame', async () => {
    const entrance = playing(240);
    animations([entrance.animation]);
    const run = vi.fn();
    afterShown(run);
    await painted();
    await painted();
    expect(run).not.toHaveBeenCalled();
    entrance.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    await painted();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is not held by an animation that never ends, such as a spinner', async () => {
    animations([playing(Infinity).animation]);
    const run = vi.fn();
    afterShown(run);
    await painted();
    await painted();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts anyway when an entrance runs past a second', async () => {
    animations([playing(5_000).animation]);
    const run = vi.fn();
    afterShown(run);
    await painted();
    await vi.advanceTimersByTimeAsync(1_000);
    await painted();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never starts once stopped while the entrance plays', async () => {
    const entrance = playing(240);
    animations([entrance.animation]);
    const run = vi.fn();
    const stop = afterShown(run);
    await painted();
    stop();
    entrance.end();
    await painted();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).not.toHaveBeenCalled();
  });
});

function words(a: Arrival<string>): string {
  if (a.kind === 'ready') return a.value;
  if (a.kind === 'failed') return `failed: ${String(a.error)}`;
  return 'waiting';
}

function Probe({ shown, load }: { shown: string | null; load: () => Promise<string> }) {
  return <p data-testid="arrival">{words(useLoadOnceShown(shown, load))}</p>;
}

const arrival = () => screen.getByTestId('arrival').textContent;
const onScreen = () =>
  act(async () => {
    await painted();
    await painted();
  });

describe('a load a surface starts when it opens', () => {
  it('has not begun when the surface first renders, and arrives once it is on screen', async () => {
    const load = vi.fn(() => Promise.resolve('details'));
    render(<Probe shown="1" load={load} />);
    expect(arrival()).toBe('waiting');
    expect(load).not.toHaveBeenCalled();
    await onScreen();
    expect(load).toHaveBeenCalledTimes(1);
    expect(arrival()).toBe('details');
  });

  it('starts nothing while closed, and shows no answer from an earlier opening', async () => {
    let n = 0;
    const load = vi.fn(() => Promise.resolve(`opening ${String(++n)}`));
    const view = render(<Probe shown={null} load={load} />);
    await onScreen();
    expect(load).not.toHaveBeenCalled();
    view.rerender(<Probe shown="1" load={load} />);
    await onScreen();
    expect(arrival()).toBe('opening 1');
    view.rerender(<Probe shown="2" load={load} />);
    expect(arrival()).toBe('waiting');
    await onScreen();
    expect(arrival()).toBe('opening 2');
  });

  it('drops an answer that comes after the surface closed', async () => {
    let answer: (v: string) => void = () => undefined;
    const load = () => new Promise<string>((done) => (answer = done));
    const view = render(<Probe shown="1" load={load} />);
    await onScreen();
    view.rerender(<Probe shown={null} load={load} />);
    await act(async () => answer('late'));
    expect(arrival()).toBe('waiting');
  });

  it('says why when the load fails', async () => {
    render(<Probe shown="1" load={() => Promise.reject(new Error('no runtime'))} />);
    await onScreen();
    expect(arrival()).toBe('failed: Error: no runtime');
  });
});
