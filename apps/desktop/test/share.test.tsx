import type { AccountState, Layout, ShareChartInput, ShareLink } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patch } from '../src/app/store.ts';
import type * as Capture from '../src/feedback/capture.ts';
import { captureWindow } from '../src/feedback/capture.ts';
import { canShare, CHART_CANVAS_ATTR, sharedOnWords } from '../src/share/model.ts';
import { LEFT_OUT_WORDS, ShareDialog } from '../src/share/ShareDialog.tsx';
import { quietWhileSharing, TRADING_STATE_ATTR } from '../src/share/quiet.ts';
import { closeShare, shareChart } from '../src/share/store.ts';
import { defaultChartState, layoutsStore } from '../src/state/layouts.ts';
import { answeringClient, seedTools, TestRuntime } from './support/runtime.tsx';

vi.mock('../src/feedback/capture.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Capture>();
  return {
    ...real,
    captureWindow: vi.fn(() =>
      Promise.resolve({
        type: 'image/png',
        data: 'iVBORw0KGgo=',
        preview: 'data:image/png;base64,iVBORw0KGgo=',
        width: 1600,
        height: 900,
        bytes: 9,
      }),
    ),
  };
});

const LINK: ShareLink = {
  id: 'Ab3dE6gH9jK2',
  url: 'https://account.example.test/s/Ab3dE6gH9jK2',
  kind: 'chart',
  title: 'NQZ6.CME · 5m',
  createdAt: '2026-11-23T10:00:00.000Z',
};

const SIGNED_IN: AccountState = {
  phase: 'signed_in',
  user: { email: 'trader@example.test', name: null },
  access: 'full',
  entitlements: ['share'],
  verifiedAt: null,
  checking: false,
  offline: false,
  signingIn: false,
  problem: null,
};

const TARGET = { layoutId: 'L', tileId: 'chart-1' };

function seedChart(): void {
  const layout: Layout = {
    id: 'L',
    name: 'L',
    revision: 1,
    updatedAt: 0,
    activeChartId: 'chart-1',
    dock: null,
    charts: { 'chart-1': defaultChartState('chart-1', 'Chart', 'NQZ6.CME', '5m') },
    trade: null,
  };
  patch(layoutsStore, { layouts: { L: layout } });
}

function mount() {
  const { client, calls } = answeringClient({ 'share.chart': () => LINK });
  seedTools(['share.chart', 'share.list', 'share.delete']);
  render(
    <TestRuntime client={client}>
      <TooltipProvider>
        <ShareDialog />
      </TooltipProvider>
    </TestRuntime>,
  );
  return { shared: () => calls.filter((c) => c.name === 'share.chart').map((c) => c.input as ShareChartInput) };
}

function canvas(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(CHART_CANVAS_ATTR, 'chart-1');
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  closeShare();
  seedChart();
});

afterEach(() => {
  cleanup();
  document.querySelectorAll(`[${CHART_CANVAS_ATTR}]`).forEach((el) => el.remove());
});

describe('sharing a chart', () => {
  it('shows the picture first and makes a link only on Create link, then Done closes it', async () => {
    const el = canvas();
    const w = mount();
    await act(() => shareChart(TARGET));
    expect(await screen.findByText(LEFT_OUT_WORDS)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'The picture of the chart that is shared' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Link' })).toBeNull();
    expect(w.shared()).toEqual([]);
    expect(vi.mocked(captureWindow).mock.lastCall?.[1]).toBe(el);
    expect(vi.mocked(captureWindow).mock.lastCall?.[2]).toEqual(
      expect.arrayContaining([`[${TRADING_STATE_ATTR}]`, '[role="toolbar"]']),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByDisplayValue(LINK.url)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(w.shared()).toEqual([
      {
        image: { type: 'image/png', data: 'iVBORw0KGgo=', width: 1600, height: 900 },
        instrument: 'NQZ6.CME',
        timeframe: '5m',
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.querySelector('[data-share-flow]')).toBeNull();
  });

  it('hides the chart’s orders, positions and countdown only while it is pictured', async () => {
    canvas();
    mount();
    const events: string[] = [];
    const off = quietWhileSharing(TARGET.tileId, () => {
      events.push('quiet');
      return () => events.push('restored');
    });
    vi.mocked(captureWindow).mockImplementationOnce(() => {
      events.push('pictured');
      return Promise.resolve({ type: 'image/png', data: 'iVBORw0KGgo=', preview: '', width: 10, height: 10, bytes: 9 });
    });
    await act(() => shareChart(TARGET));
    off();
    expect(events).toEqual(['quiet', 'pictured', 'restored']);
  });

  it('cancels before a link exists and sends nothing', async () => {
    canvas();
    const w = mount();
    await act(() => shareChart(TARGET));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('[data-share-flow]')).toBeNull();
    expect(w.shared()).toEqual([]);
  });

  it('says so in plain words when the chart is not on screen, and sends nothing', async () => {
    const w = mount();
    await act(() => shareChart(TARGET));
    expect(await screen.findByText('This chart isn’t on screen. Show it, then share again.')).toBeTruthy();
    expect(w.shared()).toEqual([]);
  });

  it('drops a share closed before its picture is taken', async () => {
    canvas();
    const w = mount();
    let taken: () => void = () => undefined;
    vi.mocked(captureWindow).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          taken = () =>
            resolve({ type: 'image/png', data: 'iVBORw0KGgo=', preview: '', width: 10, height: 10, bytes: 9 });
        }),
    );
    const running = shareChart(TARGET);
    act(() => closeShare());
    taken();
    await act(() => running);
    expect(w.shared()).toEqual([]);
    expect(document.querySelector('[data-share-flow]')).toBeNull();
  });
});

describe('who can share', () => {
  it('is a signed-in account with access on a Cloud that offers sharing', () => {
    expect(canShare(SIGNED_IN)).toBe(true);
    expect(canShare(null)).toBe(false);
    expect(canShare({ ...SIGNED_IN, entitlements: [] })).toBe(false);
    expect(canShare({ ...SIGNED_IN, access: 'pending' })).toBe(false);
    expect(canShare({ ...SIGNED_IN, phase: 'signed_out' })).toBe(false);
  });
});

describe('when a link was shared', () => {
  it('reads in the display zone, with the year only when it is not this one', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    expect(sharedOnWords('2026-11-23T10:00:00.000Z', 'America/New_York', now)).toBe('Nov 23, 05:00');
    expect(sharedOnWords('2025-03-01T10:00:00.000Z', 'UTC', now)).toBe('Mar 1, 2025, 10:00');
    expect(sharedOnWords('not a date', 'UTC', now)).toBe('');
  });
});
