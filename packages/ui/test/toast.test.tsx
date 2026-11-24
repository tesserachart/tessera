import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOAST_EXIT_MS,
  TOAST_MS,
  TOAST_RESUME_MIN_MS,
  ToastStack,
  arrive,
  createToastQueue,
  type ToastItem,
} from '../src/index.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let n = 0;
const item = (over: Partial<ToastItem> = {}): ToastItem => ({
  id: ++n,
  tone: 'ok',
  title: `Toast ${String(n)}`,
  detail: null,
  action: null,
  key: null,
  ms: 4000,
  state: 'open',
  ...over,
});
const open = (list: readonly ToastItem[]) => list.filter((t) => t.state === 'open').map((t) => t.title);

describe('a stack’s toasts as they arrive', () => {
  it('puts the newest last, and past three sends the oldest away', () => {
    const err = item({ tone: 'err', title: 'Not sent', ms: null });
    const a = item({ title: 'Working' });
    const b = item({ title: 'Moved' });
    let list = [a, b, err];
    const r = arrive(list, item({ title: 'Flat NQ Z6' }));
    expect(open(r.list)).toEqual(['Moved', 'Not sent', 'Flat NQ Z6']);
    expect(r.gone.map((t) => t.title)).toEqual(['Working']);
    list = r.list;
    const r2 = arrive(list, item({ title: 'Cancelled 2 NQ Z6' }));
    expect(open(r2.list)).toEqual(['Not sent', 'Flat NQ Z6', 'Cancelled 2 NQ Z6']);
    expect(r2.list.find((t) => t.title === 'Moved')?.state).toBe('closed');
  });

  it('replaces one with the same key, or the very same words', () => {
    const offer = item({ title: 'Closed NQ Z6 1m', key: 'undo' });
    const r = arrive([offer], item({ title: 'Floated Markets', key: 'undo' }));
    expect(open(r.list)).toEqual(['Floated Markets']);
    const same = item({ title: 'Moved' });
    expect(open(arrive([same], item({ title: 'Moved' })).list)).toEqual(['Moved']);
    expect(open(arrive([same], item({ title: 'Moved', tone: 'info' })).list)).toEqual(['Moved', 'Moved']);
  });

  it('keeps No answer up when a held-back Not sent arrives', () => {
    const unknown = item({
      tone: 'err',
      ms: null,
      title: 'No answer from the runtime',
      detail: 'Check Orders before sending it again',
    });
    const held = item({
      tone: 'err',
      ms: null,
      title: 'Not sent',
      detail: 'Already sending this order',
    });
    expect(open(arrive([unknown], held).list)).toEqual(['No answer from the runtime', 'Not sent']);
    expect(arrive([unknown], held).gone).toEqual([]);
  });
});

describe('a toast queue’s clocks', () => {
  it('ends a toast after its tone’s time; an error stays until dismissed', () => {
    vi.useFakeTimers();
    const q = createToastQueue();
    const onClose = vi.fn();
    q.push({ title: 'Filled at 20,639.25', detail: 'Buy 1 NQ Z6 at market', onClose });
    q.push({ tone: 'info', title: 'Drafted' });
    vi.advanceTimersByTime(TOAST_MS.ok! - 1);
    expect(open(q.getSnapshot())).toEqual(['Filled at 20,639.25', 'Drafted']);
    vi.advanceTimersByTime(1);
    expect(open(q.getSnapshot())).toEqual(['Drafted']);
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(q.getSnapshot().map((t) => t.title)).toEqual(['Drafted']);
    const id = q.push({ tone: 'err', title: 'Not sent', detail: 'QQQ is closed. Opens 04:00' });
    vi.advanceTimersByTime(60_000);
    expect(open(q.getSnapshot())).toEqual(['Not sent']);
    q.dismiss(id);
    expect(open(q.getSnapshot())).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('holds every clock while the pointer is over the stack, and leaves at least a moment after', () => {
    vi.useFakeTimers();
    const q = createToastQueue();
    q.push({ title: 'Working' });
    vi.advanceTimersByTime(3900);
    q.pause();
    vi.advanceTimersByTime(30_000);
    expect(open(q.getSnapshot())).toEqual(['Working']);
    q.push({ title: 'Moved' });
    vi.advanceTimersByTime(10_000);
    expect(open(q.getSnapshot())).toEqual(['Working', 'Moved']);
    q.resume();
    vi.advanceTimersByTime(TOAST_RESUME_MIN_MS - 1);
    expect(open(q.getSnapshot())).toEqual(['Working', 'Moved']);
    vi.advanceTimersByTime(1);
    expect(open(q.getSnapshot())).toEqual(['Moved']);
  });

  it('runs an action, then dismisses its toast; a key dismisses every toast with it', () => {
    vi.useFakeTimers();
    const q = createToastQueue();
    const order: string[] = [];
    const id = q.push({
      title: 'Closed NQ Z6 1m',
      key: 'undo',
      ms: 8000,
      action: { label: 'Undo', run: () => order.push('undo') },
      onClose: () => order.push('closed'),
    });
    q.act(id);
    expect(order).toEqual(['undo', 'closed']);
    q.act(id);
    expect(order).toEqual(['undo', 'closed']);
    q.push({ title: 'Floated Markets', key: 'undo' });
    q.dismiss('undo');
    expect(open(q.getSnapshot())).toEqual([]);
  });
});

describe('the toast stack', () => {
  it('says each toast with its tone, and a click, its × or its action dismisses it', () => {
    vi.useFakeTimers();
    const q = createToastQueue();
    const run = vi.fn();
    render(<ToastStack queue={q} label="Chart notices" />);
    act(() => {
      q.push({ title: 'Working', detail: 'Buy 2 NQ Z6 limit 20,630.75' });
      q.push({ tone: 'err', title: 'Not sent', detail: 'QQQ is closed. Opens 04:00', action: { label: 'Retry', run } });
    });
    expect(screen.getByRole('status').textContent).toContain('Buy 2 NQ Z6 limit 20,630.75');
    expect(screen.getByRole('alert').textContent).toContain('QQQ is closed. Opens 04:00');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').getAttribute('data-state')).toBe('closed');
    fireEvent.click(screen.getByText('Working'));
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed');
    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS);
    });
    expect(screen.queryByRole('status')).toBeNull();
    act(() => {
      q.push({ title: 'Moved' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed');
  });

  it('holds the clocks under the pointer and stands a hint under its toasts', () => {
    vi.useFakeTimers();
    const q = createToastQueue();
    const { container } = render(
      <ToastStack queue={q} label="Chart notices">
        <p className="hint">Click to place the stop · Esc to skip</p>
      </ToastStack>,
    );
    act(() => {
      q.push({ title: 'Working' });
      vi.advanceTimersByTime(3000);
    });
    const stack = container.querySelector('.t-toasts')!;
    fireEvent.pointerEnter(stack);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('open');
    fireEvent.pointerLeave(stack);
    act(() => {
      vi.advanceTimersByTime(TOAST_RESUME_MIN_MS);
    });
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed');
    expect(stack.lastElementChild?.className).toBe('hint');
  });
});
