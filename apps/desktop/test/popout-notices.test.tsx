import type { TileSpec } from '@tessera/bridge';
import type { CopyNote, EventMeta } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TileWindow } from '../src/app/TileWindow.tsx';
import { noteOnChart } from '../src/chart/chartNotice.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';

const CHART = { layoutId: 'default', tileId: 'chart-nq' };
const POP_OUT: Omit<TileSpec, 'width' | 'height'> = {
  kind: 'chart',
  id: `pop-${CHART.layoutId}-${CHART.tileId}`,
  title: 'NQ',
  params: { layoutId: CHART.layoutId, panelId: CHART.tileId },
};
const REFUSED = { tone: 'err' as const, text: 'No live price for NQZ6 since 14:42. Nothing sent.' };
const COPIED: CopyNote = {
  groupId: 'g_1',
  leaderId: 'paper-main',
  title: 'Buy 2 NQZ6: copied to 1 of 2',
  detail: 'Paper 3 did not answer',
  tone: 'err',
  ts: 1,
};

function windowRoot(): HTMLElement {
  return document.body.appendChild(document.createElement('div'));
}

function deskRuntime() {
  const windows = new Set<(data: unknown, meta: EventMeta) => void>();
  const client: FakeClient = {
    subscribe: (topic, _params, handler) => {
      if (topic !== 'copy.notes') return () => undefined;
      windows.add(handler);
      return () => windows.delete(handler);
    },
  };
  const publish = (note: CopyNote) => {
    for (const handler of windows) handler(note, { topic: 'copy.notes', seq: 1, subscriptionId: 's' });
  };
  return { client, publish };
}

async function mainWindow(client: FakeClient = {}) {
  vi.resetModules();
  const [{ TestRuntime: MainRuntime }, { useCopyNotes }, { DeskToasts }] = await Promise.all([
    import('./support/runtime.tsx'),
    import('../src/shell/copyNotes.ts'),
    import('../src/workspace/dock/DeskToasts.tsx'),
  ]);
  function MainFooter() {
    useCopyNotes();
    return <DeskToasts />;
  }
  return render(
    <MainRuntime client={client}>
      <MainFooter />
    </MainRuntime>,
    { container: windowRoot() },
  );
}

function popOutWindow(client: FakeClient = {}) {
  return render(
    <TestRuntime client={client}>
      <TileWindow tile={POP_OUT} />
    </TestRuntime>,
    { container: windowRoot() },
  );
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('a pop-out chart window’s notices', () => {
  it('shows a paper order refused in the pop-out there, with Retry, and not in the main window', async () => {
    const main = await mainWindow();
    const popOut = popOutWindow();
    const retry = vi.fn();

    act(() => noteOnChart(CHART, REFUSED, { account: 'Paper', retry }));

    const notices = within(popOut.container).getByLabelText('Desk notices');
    expect(within(notices).getByRole('alert').textContent).toBe(
      'Not sent · Paper · No live price for NQZ6 since 14:42',
    );
    fireEvent.click(within(notices).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(within(main.container).queryByLabelText('Desk notices')).toBeNull();
  });

  it('leaves the copier’s notes, which no one window caused, to the main window', async () => {
    const runtime = deskRuntime();
    const main = await mainWindow(runtime.client);
    const popOut = popOutWindow(runtime.client);

    act(() => runtime.publish(COPIED));

    expect(within(main.container).getByRole('alert').textContent).toBe(
      'Buy 2 NQZ6: copied to 1 of 2 · Paper 3 did not answer',
    );
    expect(within(popOut.container).queryByLabelText('Desk notices')).toBeNull();
  });
});
