import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TOAST_EXIT_MS } from '@tessera/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskToasts } from '../src/workspace/dock/DeskToasts.tsx';
import { deskToasts } from '../src/workspace/dock/deskToasts.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  deskToasts.clear();
  vi.advanceTimersByTime(TOAST_EXIT_MS);
  vi.useRealTimers();
});

describe('the shell footer’s notices', () => {
  it('keeps the latest outcome on the footer and earlier details and actions reachable in its menu', () => {
    const undo = vi.fn();
    render(<DeskToasts />);
    act(() => {
      deskToasts.push({ title: 'Moved Markets', detail: 'To the right edge', action: { label: 'Undo', run: undo } });
      deskToasts.push({ tone: 'err', title: 'Not sent', detail: 'The connection is unavailable' });
    });
    const summary = screen.getByRole('button', {
      name: 'Notice details: Not sent · The connection is unavailable',
    });
    expect(summary.title).toBe('Not sent · The connection is unavailable');
    expect(screen.getByRole('alert').textContent).toBe('Not sent · The connection is unavailable');
    fireEvent.keyDown(summary, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: 'Current notices' });
    expect(within(menu).getByText('To the right edge')).toBeTruthy();
    expect(within(menu).getByText('The connection is unavailable')).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(
      deskToasts
        .getSnapshot()
        .filter((t) => t.state === 'open')
        .map((t) => t.title),
    ).toEqual(['Not sent']);
  });

  it('keeps No answer in Current notices when a held-back Not sent arrives', () => {
    render(<DeskToasts />);
    act(() => {
      deskToasts.push({
        tone: 'err',
        title: 'No answer from the runtime',
        detail: 'Check Orders before sending it again',
      });
      deskToasts.push({
        tone: 'err',
        title: 'Not sent',
        detail: 'Already sending this order',
      });
    });
    expect(screen.getByRole('alert').textContent).toBe('Not sent · Already sending this order');
    expect(screen.getByText('2')).toBeTruthy();
    const summary = screen.getByRole('button', {
      name: 'Notice details: Not sent · Already sending this order',
    });
    fireEvent.keyDown(summary, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: 'Current notices' });
    expect(within(menu).getByText('No answer from the runtime')).toBeTruthy();
    expect(within(menu).getByText('Check Orders before sending it again')).toBeTruthy();
    expect(within(menu).getByText('Already sending this order')).toBeTruthy();
    expect(
      deskToasts
        .getSnapshot()
        .filter((t) => t.state === 'open')
        .map((t) => [t.title, t.detail]),
    ).toEqual([
      ['No answer from the runtime', 'Check Orders before sending it again'],
      ['Not sent', 'Already sending this order'],
    ]);
  });

  it('holds timed actions while reading by keyboard and releases them after the component unmounts', () => {
    const { unmount } = render(<DeskToasts />);
    act(() => deskToasts.push({ title: 'Moved Markets', ms: 4000 }));
    const summary = screen.getByRole('button', { name: 'Notice details: Moved Markets' });
    fireEvent.focus(summary);
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole('status').textContent).toBe('Moved Markets');
    unmount();
    act(() => vi.advanceTimersByTime(4000));
    expect(deskToasts.getSnapshot().filter((t) => t.state === 'open')).toEqual([]);
  });

  it('resumes normally for a new notice after the last hovered notice is dismissed', () => {
    render(<DeskToasts />);
    act(() => deskToasts.push({ title: 'Moved Markets', ms: 4000 }));
    fireEvent.pointerEnter(screen.getByLabelText('Desk notices'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Moved Markets' }));
    act(() => deskToasts.push({ title: 'Saved workspace', ms: 4000 }));
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByLabelText('Desk notices')).toBeNull();
  });
});
