import type { ChartApi } from '@tessera/chart';
import type { Alert } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertFormHost } from '../src/alerts/AlertFormHost.tsx';
import { formFromAlert } from '../src/alerts/form.ts';
import { alertFormStore, closeAlertForm, editAlert } from '../src/alerts/formStore.ts';
import { alertsStore } from '../src/alerts/store.ts';
import { patch, read } from '../src/app/store.ts';
import { ChartAlerts } from '../src/chart/ChartAlerts.tsx';
import { answeringClient, seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

const DELIVER = { sound: true, desktop: true, discord: false };

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: 'al_1',
    symbol: 'NQ',
    instrument: 'NQZ6.CME',
    interval: '1m',
    steps: [{ subject: { kind: 'price' }, op: 'crosses', target: { kind: 'value', value: 20870.75 }, on: 'trade' }],
    withinBars: null,
    repeat: 'once',
    cooldownSecs: 60,
    expiresAt: null,
    message: null,
    deliver: DELIVER,
    askAnalyst: false,
    status: 'active',
    title: 'NQ Z6 crosses 20870.75',
    createdBy: 'user',
    sessionId: null,
    createdAt: 1,
    updatedAt: 1,
    firedAt: null,
    fireCount: 0,
    live: { price: 20870.75, step: 0, bars: 0, problem: null },
    ...over,
  };
}

const show = (...alerts: Alert[]) =>
  act(() => patch(alertsStore, { alerts: new Map(alerts.map((a) => [a.id, a])), recent: [], notes: [] }));

let calls: { name: string; input: unknown }[] = [];
let client: ReturnType<typeof answeringClient>['client'];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const answering = answeringClient({
    'alerts.delete': () => ({ deleted: true }),
    'alerts.pause': () => ({ alert: alert() }) as never,
  });
  client = answering.client;
  calls = answering.calls;
  setTestServices(client);
  seedTools(['alerts.delete', 'alerts.pause']);
});
afterEach(() => {
  cleanup();
  act(() => closeAlertForm());
  patch(alertsStore, { alerts: null, recent: [], notes: [] });
  vi.useRealTimers();
});

describe('an alert, by mouse', () => {
  it('its form pauses it and deletes it, and a paused one reads Resume', async () => {
    const a = alert();
    show(a);
    render(
      <TestRuntime client={client}>
        <AlertFormHost />
      </TestRuntime>,
    );
    act(() => {
      editAlert(a, { decimals: 2, tick: 0.25 });
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(calls).toContainEqual({ name: 'alerts.pause', input: { id: 'al_1', paused: true } }));
    show({ ...a, status: 'paused' });
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls).toContainEqual({ name: 'alerts.delete', input: { id: 'al_1' } }));
    await waitFor(() => expect(read(alertFormStore).open).toBeNull());
  });

  it('a new alert’s form has neither', () => {
    show();
    patch(alertFormStore, {
      open: { form: { ...formOf(alert()), id: null }, at: null, price: 20870.75, seq: 1 },
    });
    render(
      <TestRuntime client={client}>
        <AlertFormHost />
      </TestRuntime>,
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('a right-click on its tag on the chart edits, pauses, lists or deletes it', async () => {
    show(alert());
    const chart = {
      coords: () => ({
        plot: { x: 0, y: 0, w: 600, h: 400 },
        priceAxis: { x: 600, w: 70 },
        yOfPrice: () => 200,
        priceOfY: () => 20870.75,
      }),
      on: () => () => undefined,
    } as unknown as ChartApi;
    render(
      <TestRuntime client={client}>
        <TooltipProvider>
          <ChartAlerts
            chart={chart}
            ids={new Set(['NQZ6.CME'])}
            decimals={2}
            tick={0.25}
            target={{ layoutId: 'l', tileId: 't' }}
          />
        </TooltipProvider>
      </TestRuntime>,
    );
    vi.useRealTimers();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Alert: NQ Z6 crosses 20870.75' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Edit…', 'Pause', 'All alerts', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(calls).toContainEqual({ name: 'alerts.delete', input: { id: 'al_1' } }));
  });
});

describe('an alert line dragged on the chart', () => {
  it('leaves a newer drag alone when the move it replaced is refused', async () => {
    let refuse: (e: Error) => void = () => undefined;
    const held = answeringClient({
      'alerts.update': () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    });
    setTestServices(held.client);
    seedTools(['alerts.update']);
    const second = alert({
      id: 'al_2',
      title: 'NQ Z6 crosses 20850.00',
      steps: [{ subject: { kind: 'price' }, op: 'crosses', target: { kind: 'value', value: 20850 }, on: 'trade' }],
      live: { price: 20850, step: 0, bars: 0, problem: null },
    });
    show(alert(), second);
    const yOf = (p: number) => 200 - (p - 20870.75) * 8;
    const chart = {
      coords: () => ({
        plot: { x: 0, y: 0, w: 600, h: 400 },
        priceAxis: { x: 600, w: 70 },
        yOfPrice: yOf,
        priceOfY: (y: number) => 20870.75 + (200 - y) / 8,
      }),
      on: () => () => undefined,
    } as unknown as ChartApi;
    render(
      <TestRuntime client={held.client}>
        <TooltipProvider>
          <ChartAlerts
            chart={chart}
            ids={new Set(['NQZ6.CME'])}
            decimals={2}
            tick={0.25}
            target={{ layoutId: 'l', tileId: 't' }}
          />
        </TooltipProvider>
      </TestRuntime>,
    );
    vi.useRealTimers();
    const tag = (title: string) => screen.getByRole('button', { name: `Alert: ${title}` });
    const first = tag('NQ Z6 crosses 20870.75');
    fireEvent.pointerDown(first, { button: 0, pointerId: 1, clientY: yOf(20870.75) });
    fireEvent.pointerMove(first, { pointerId: 1, clientY: yOf(20875) });
    fireEvent.pointerUp(first, { pointerId: 1, clientY: yOf(20875) });
    await waitFor(() => expect(held.calls.map((c) => c.name)).toContain('alerts.update'));
    const other = tag('NQ Z6 crosses 20850.00');
    fireEvent.pointerDown(other, { button: 0, pointerId: 2, clientY: yOf(20850) });
    fireEvent.pointerMove(other, { pointerId: 2, clientY: yOf(20852) });
    expect(other.textContent).toContain('20,852.00');
    await act(async () => {
      refuse(new Error('refused'));
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(tag('NQ Z6 crosses 20850.00').textContent).toContain('20,852.00');
  });
});

describe('an alert form whose save is still on its way', () => {
  it('leaves the next form open, with nothing of the old answer, when the old save answers', async () => {
    let answer: (a: unknown) => void = () => undefined;
    const held = answeringClient({
      'alerts.update': () =>
        new Promise((resolve) => {
          answer = resolve;
        }) as never,
    });
    setTestServices(held.client);
    seedTools(['alerts.update']);
    const first = alert();
    const second = alert({ id: 'al_2', title: 'NQ Z6 crosses 20850.00' });
    show(first, second);
    render(
      <TestRuntime client={held.client}>
        <TooltipProvider>
          <AlertFormHost />
        </TooltipProvider>
      </TestRuntime>,
    );
    act(() => {
      editAlert(first, { decimals: 2, tick: 0.25 });
      vi.advanceTimersByTime(0);
    });
    vi.useRealTimers();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(held.calls.map((c) => c.name)).toContain('alerts.update'));
    act(() => {
      editAlert(second, { decimals: 2, tick: 0.25 });
    });
    await waitFor(() => expect(read(alertFormStore).open?.form.id).toBe('al_2'));
    await act(async () => {
      answer(first);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(read(alertFormStore).open?.form.id).toBe('al_2');
  });
});

function formOf(a: Alert) {
  return formFromAlert(a, { symbol: 'NQ Z6', decimals: 2, tick: 0.25 });
}
