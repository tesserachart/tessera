import type { Alert, AlertFire, AlertStep, ChartLayer } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertFormView } from '../src/alerts/AlertForm.tsx';
import { AlertsList, type AlertActions } from '../src/alerts/AlertsList.tsx';
import {
  formFromAlert,
  formFromSeed,
  formSteps,
  toCreateInput,
  toUpdateInput,
  withOp,
  withSubject,
  withTarget,
  type AlertForm,
  type AlertSeed,
} from '../src/alerts/form.ts';
import { chartPlotChoices, levelChoice, stackChoices, stackOf } from '../src/alerts/seed.ts';
import { draggable, listOrder, markPrice, markersOn, reduceAlerts, type AlertsState } from '../src/alerts/store.ts';
import { fireWords, stateWords } from '../src/alerts/words.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';

afterEach(cleanup);

const DELIVER = { sound: true, desktop: true, discord: false };
const NOW = Date.UTC(2026, 9, 2, 18, 42, 30);

const seed = (over: Partial<AlertSeed> = {}): AlertSeed => ({
  instrument: 'NQZ6.CME',
  symbol: 'NQ Z6',
  interval: '5m',
  decimals: 2,
  tick: 0.25,
  price: 21000.25,
  ...over,
});

const ZERO_GAMMA = levelChoice({ key: 'zeta.classic.zero_gamma', label: 'Zero Gamma' });
const EMA9 = {
  key: 'plot:ema|[["length",9]]|ema',
  label: 'EMA 9',
  operand: { kind: 'plot' as const, indicator: 'ema', inputs: { length: 9 }, plot: 'ema', label: 'EMA 9' },
};
const LONDON_HIGH = {
  key: 'line:ci_1|[]|London high',
  label: 'London high · Sessions',
  operand: { kind: 'indicator_line' as const, indicator: 'ci_1', inputs: {}, label: 'London high', name: 'Sessions' },
};

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: 'al_1',
    symbol: 'NQ',
    instrument: 'NQZ6.CME',
    interval: '1m',
    steps: [{ subject: { kind: 'price' }, op: 'crosses_above', target: { kind: 'value', value: 21000 }, on: 'trade' }],
    withinBars: null,
    repeat: 'once',
    cooldownSecs: 60,
    expiresAt: null,
    message: null,
    deliver: DELIVER,
    askAnalyst: false,
    status: 'active',
    title: 'NQ crosses above 21000',
    createdBy: 'user',
    sessionId: null,
    createdAt: 1,
    updatedAt: 1,
    firedAt: null,
    fireCount: 0,
    live: { price: 21000, step: 0, bars: 0, problem: null },
    ...over,
  };
}

function fire(over: Partial<AlertFire> = {}): AlertFire {
  return {
    id: 'af_1',
    alertId: 'al_1',
    symbol: 'NQ',
    instrument: 'NQZ6.CME',
    title: 'NQ crosses above 21000',
    message: null,
    price: 21000.25,
    target: 21000,
    at: NOW * 1e6,
    barTime: null,
    source: 'Apex · Rithmic',
    deliver: DELIVER,
    discord: null,
    analyst: null,
    ...over,
  };
}

describe('the alert form’s model', () => {
  it('starts at the price under the pointer: crosses it, on any trade, once, with the user’s deliveries', () => {
    const f = formFromSeed(seed(), DELIVER);
    expect(f).toMatchObject({ op: 'crosses', target: 'value', value: '21000.25', on: 'trade', repeat: 'once' });
    expect(f.deliver).toEqual(DELIVER);
    const input = toCreateInput(f, NOW);
    expect(input).toEqual({
      ok: {
        instrument: 'NQZ6.CME',
        interval: '5m',
        steps: [{ subject: { kind: 'price' }, op: 'crosses', target: { kind: 'value', value: 21000.25 }, on: 'trade' }],
        repeat: 'once',
        deliver: DELIVER,
      },
    });
    expect(toCreateInput({ ...f, value: '' }, NOW)).toEqual({ error: 'Type a price' });
    const every = toCreateInput({ ...f, repeat: 'every', cooldown: '30', expiry: '1h', message: ' check it ' }, NOW);
    expect(every).toMatchObject({
      ok: { repeat: 'every', cooldownSecs: 30, expiresAt: (NOW + 3_600_000) * 1e6, message: 'check it' },
    });
    expect(toCreateInput({ ...f, repeat: 'every', cooldown: '-1' }, NOW)).toHaveProperty('error');
  });

  it('keeps a level by its vendor key and makes a sweep and reclaim a two-step sequence', () => {
    const f = formFromSeed(seed({ target: ZERO_GAMMA, price: 20950 }), DELIVER);
    expect(f.target).toBe(ZERO_GAMMA.key);
    const swept = withOp(f, 'sweep_above');
    expect(formSteps(swept)).toEqual({
      ok: [
        { subject: { kind: 'price' }, op: 'crosses_above', target: ZERO_GAMMA.operand, on: 'trade' },
        { subject: { kind: 'price' }, op: 'below', target: ZERO_GAMMA.operand, on: 'bar_close' },
      ],
    });
    expect(toCreateInput(swept, NOW)).toMatchObject({ ok: { withinBars: 3, interval: '5m' } });
    expect(toCreateInput({ ...swept, within: '0' }, NOW)).toEqual({ error: 'The window is 1 to 500 bars' });
    expect(withTarget(f, 'value', 20950).value).toBe('20950.00');
  });

  it('reads an indicator’s plot at bar close', () => {
    const f = formFromSeed(seed({ target: EMA9 }), DELIVER);
    expect(f.on).toBe('bar_close');
    const steps = formSteps({ ...f, on: 'trade' });
    expect(steps).toEqual({
      ok: [{ subject: { kind: 'price' }, op: 'crosses', target: EMA9.operand, on: 'bar_close' }],
    });
  });

  it('watches a big trade or one print of at least a size, on either side', () => {
    const f = withSubject(formFromSeed(seed(), DELIVER), 'big_trade:ask');
    expect(f).toMatchObject({ op: 'at_least', target: 'value', value: '50', on: 'trade' });
    expect(toCreateInput({ ...f, value: '120' }, NOW)).toMatchObject({
      ok: {
        steps: [
          {
            subject: { kind: 'big_trade', side: 'ask' },
            op: 'at_least',
            target: { kind: 'value', value: 120 },
            on: 'trade',
          },
        ],
      },
    });
    expect(toCreateInput({ ...f, value: '0' }, NOW)).toEqual({ error: 'Type a size of at least 1 contract' });
    expect(toCreateInput({ ...f, value: '2.5' }, NOW)).toEqual({ error: 'Type a size of at least 1 contract' });
    const print = withSubject({ ...f, value: '120' }, 'print:bid');
    expect(print.value).toBe('120');
    expect(formSteps(print)).toMatchObject({ ok: [{ subject: { kind: 'print', side: 'bid' }, op: 'at_least' }] });
    const back = withSubject(print, 'price');
    expect(back).toMatchObject({ op: 'crosses', value: '' });
    const saved: AlertStep[] = [
      {
        subject: { kind: 'big_trade', side: 'either' },
        op: 'at_least',
        target: { kind: 'value', value: 80 },
        on: 'trade',
      },
    ];
    const opened = formFromAlert(alert({ steps: saved }), { symbol: 'NQ Z6', decimals: 2, tick: 0.25 });
    expect(opened).toMatchObject({ subject: 'big_trade:either', op: 'at_least', value: '80' });
  });

  it('watches price come back to a stacked imbalance the study draws, with its rule and its minimum stack', () => {
    const study: ChartLayer = {
      id: 'L-si',
      kind: 'stacked_imbalance',
      namespace: 'user',
      visible: true,
      params: { inputs: { ratio: 4, stackRows: 4, rowTicks: 'auto' } },
      sessionId: null,
    };
    const choices = stackChoices(study, 'NQ');
    expect(choices.map((c) => c.label)).toEqual([
      'Price back in a stack, either side (4:1)',
      'Price back in a buy stack (4:1)',
      'Price back in a sell stack (4:1)',
    ]);
    expect(choices[1]!.operand).toEqual({
      kind: 'stacked_imbalance',
      side: 'ask',
      ratio: 4,
      minVolume: 5,
      minDifference: 0,
      includeZero: false,
      rowTicks: 4,
    });
    expect(chartPlotChoices([study], 'ES').map((c) => c.operand)).toContainEqual(
      expect.objectContaining({ side: 'bid', rowTicks: 1 }),
    );
    expect(chartPlotChoices([{ ...study, visible: false }], 'NQ')).toEqual([]);

    const f = formFromSeed(seed({ subject: choices[1]!, count: stackOf(study), more: choices }), DELIVER);
    expect(f).toMatchObject({ subject: choices[1]!.key, op: 'at_least', target: 'value', value: '4', on: 'trade' });
    expect(toCreateInput(f, NOW)).toMatchObject({
      ok: {
        interval: '5m',
        steps: [{ subject: choices[1]!.operand, op: 'at_least', target: { kind: 'value', value: 4 }, on: 'trade' }],
      },
    });
    expect(toCreateInput({ ...f, value: '0' }, NOW)).toEqual({ error: 'Type a stack of 1 to 50 rows' });
    const big = withSubject(f, 'big_trade:ask');
    expect(big.value).toBe('50');
    expect(withSubject(big, choices[2]!.key).value).toBe('3');
    const stack: Alert = alert({
      steps: [{ subject: choices[2]!.operand, op: 'at_least', target: { kind: 'value', value: 3 }, on: 'trade' }],
      live: { price: null, step: 0, bars: 0, problem: null },
    });
    expect(formFromAlert(stack, { symbol: 'NQ Z6', decimals: 2, tick: 0.25 })).toMatchObject({
      subject: choices[2]!.key,
      value: '3',
    });
    expect(markPrice(stack)).toBeNull();
  });

  it('opens an alert as it is, and saves only what the form shows', () => {
    const sweep: AlertStep[] = [
      { subject: { kind: 'price' }, op: 'crosses_above', target: LONDON_HIGH.operand, on: 'trade' },
      { subject: { kind: 'price' }, op: 'below', target: LONDON_HIGH.operand, on: 'bar_close' },
    ];
    const a = alert({ steps: sweep, withinBars: 4, interval: '5m', sessionId: 'S1', createdBy: 'agent' });
    const f = formFromAlert(a, { symbol: 'NQ Z6', decimals: 2, tick: 0.25 });
    expect(f).toMatchObject({ op: 'sweep_above', target: LONDON_HIGH.key, within: '4', canAsk: true, fixed: null });
    expect(toUpdateInput({ ...f, askAnalyst: true }, NOW)).toEqual({
      ok: {
        id: 'al_1',
        steps: sweep,
        interval: '5m',
        withinBars: 4,
        repeat: 'once',
        deliver: DELIVER,
        expiresAt: 0,
        message: '',
        askAnalyst: true,
      },
    });
    const three = alert({
      steps: [...sweep, { subject: { kind: 'price' }, op: 'above', target: { kind: 'value', value: 1 }, on: 'trade' }],
      withinBars: 6,
      title: 'NQ …',
      expiresAt: 99,
    });
    const g = formFromAlert(three, { symbol: 'NQ Z6', decimals: 2, tick: 0.25 });
    expect(g.fixed?.title).toBe('NQ …');
    const out = toUpdateInput({ ...g, message: 'later' }, NOW);
    expect(out).toMatchObject({ ok: { withinBars: 6, message: 'later' } });
    expect('ok' in out && 'steps' in out.ok).toBe(false);
    expect('ok' in out && 'expiresAt' in out.ok).toBe(false);
  });
});

describe('an order-flow firing', () => {
  it('names its size and side, and says big buyer or big seller', async () => {
    const f = fire({
      title: 'NQ prints a big trade of at least 50 at the ask',
      price: 20641.63,
      size: 65,
      side: 'ask',
    });
    expect(fireWords(f)).toEqual({ title: 'NQ Z6 65 at the ask · 20,641.63', detail: f.title });
    expect(fireWords(fire()).title).toBe('NQ Z6 21,000.25');
    const { VOICE_LINES } = await import('../src/sound/voice/lines.ts');
    expect(VOICE_LINES.big_buyer).toMatchObject({ text: 'Big buyer.', event: 'alert', tone: 'alertAsk' });
    expect(VOICE_LINES.big_seller).toMatchObject({ text: 'Big seller.', event: 'alert', tone: 'alertBid' });
  });
});

describe('the alerts store', () => {
  const empty: AlertsState = { alerts: null, recent: [], discord: false, notes: [] };

  it('folds the topic: a snapshot, changes, a removal, firings and their deliveries', () => {
    let s = reduceAlerts(empty, { type: 'snapshot', alerts: [alert()], recent: [], discord: true });
    expect(s.alerts?.size).toBe(1);
    expect(s.discord).toBe(true);
    s = reduceAlerts(s, { type: 'changed', alert: alert({ id: 'al_2', status: 'paused' }) });
    s = reduceAlerts(s, { type: 'fired', fire: fire() });
    s = reduceAlerts(s, { type: 'delivered', fire: fire({ discord: 'sent' }) });
    expect(s.recent).toEqual([fire({ discord: 'sent' })]);
    expect(listOrder(s.alerts).watching.map((a) => a.id)).toEqual(['al_2', 'al_1'].sort().reverse());
    s = reduceAlerts(s, { type: 'removed', id: 'al_1' });
    expect([...(s.alerts?.keys() ?? [])]).toEqual(['al_2']);
    expect(s.recent).toEqual([]);
  });

  it('marks what a chart of the instrument shows, and drags only a fixed price', () => {
    const all = new Map(
      [
        alert(),
        alert({ id: 'al_2', status: 'triggered' }),
        alert({ id: 'al_3', instrument: 'ESZ6.CME' }),
        alert({
          id: 'al_4',
          steps: [{ ...alert().steps[0]!, target: ZERO_GAMMA.operand }],
          live: { price: null, step: 0, bars: 0, problem: 'no level' },
        }),
        alert({
          id: 'al_5',
          createdAt: 0,
          status: 'paused',
          live: { price: null, step: 0, bars: 0, problem: null },
        }),
      ].map((a) => [a.id, a]),
    );
    expect(markersOn(all, new Set(['NQ', 'NQZ6.CME'])).map((a) => a.id)).toEqual(['al_1', 'al_5']);
    expect(markPrice(all.get('al_5')!)).toBe(21000);
    expect(draggable(alert())).toBe(true);
    expect(draggable(alert({ steps: [{ ...alert().steps[0]!, target: ZERO_GAMMA.operand }] }))).toBe(false);
    expect(stateWords(alert({ live: { price: null, step: 0, bars: 0, problem: 'no level' } }))).toEqual({
      word: 'Waiting',
      note: 'no level',
    });
    expect(
      stateWords(
        alert({
          steps: [...alert().steps, ...alert().steps],
          withinBars: 3,
          live: { price: 1, step: 1, bars: 2, problem: null },
        }),
      ),
    ).toEqual({ word: 'Active', note: 'step 2 of 2, 2/3 bars' });
  });
});

function FormHarness({
  start,
  onSubmit,
  discord = false,
}: {
  start: AlertForm;
  onSubmit: (f: AlertForm) => void;
  discord?: boolean;
}) {
  const [f, setF] = useState(start);
  return (
    <AlertFormView
      form={f}
      onChange={setF}
      onSubmit={() => onSubmit(f)}
      onCancel={() => undefined}
      price={21000.25}
      discord={discord}
    />
  );
}

describe('the alert form', () => {
  it('takes a price, a condition and its options, and submits', () => {
    const submit = vi.fn();
    render(<FormHarness start={formFromSeed(seed({ target: ZERO_GAMMA }), DELIVER)} onSubmit={submit} />);
    const form = screen.getByRole('form', { name: 'New alert' });
    expect(within(form).getByText('NQ Z6')).toBeTruthy();
    expect(within(form).queryByRole('textbox', { name: 'Price' })).toBeNull();
    expect(within(form).getByText('Discord (not set)')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Every time' }));
    const cool = within(form).getByRole('textbox', { name: 'Cool-down' });
    fireEvent.change(cool, { target: { value: '15' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Message' }), { target: { value: 'gamma flip' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Desktop' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Bar close' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    expect(submit).toHaveBeenCalledTimes(1);
    const f = submit.mock.calls[0]![0] as AlertForm;
    expect(toCreateInput(f, NOW)).toMatchObject({
      ok: {
        steps: [{ op: 'crosses', target: ZERO_GAMMA.operand, on: 'bar_close' }],
        repeat: 'every',
        cooldownSecs: 15,
        message: 'gamma flip',
        deliver: { sound: true, desktop: false, discord: false },
      },
    });
  });

  it('asks a stacked imbalance alert for a stack in rows and the interval its zones are found on', () => {
    const study = {
      id: 'L-si',
      kind: 'stacked_imbalance',
      namespace: 'user',
      visible: true,
      params: { inputs: {} },
      sessionId: null,
    } as ChartLayer;
    const choices = stackChoices(study, 'NQ');
    render(
      <FormHarness
        start={formFromSeed(seed({ subject: choices[0]!, count: 3, more: choices }), DELIVER)}
        onSubmit={() => undefined}
      />,
    );
    const form = screen.getByRole('form', { name: 'New alert' });
    const stack = within(form).getByRole('textbox', { name: 'Stack' });
    expect((stack as HTMLInputElement).value).toBe('3');
    expect(within(form).getByText('rows')).toBeTruthy();
    expect(within(form).getByText('Interval')).toBeTruthy();
    expect(within(form).queryByRole('button', { name: 'Bar close' })).toBeNull();
  });

  it('shows the window of a sweep, the price box of a price, and the analyst’s switch only on its alerts', () => {
    const submit = vi.fn();
    const f = withOp(formFromSeed(seed({ target: LONDON_HIGH }), DELIVER), 'sweep_above');
    const { unmount } = render(<FormHarness start={f} onSubmit={submit} discord />);
    expect(screen.getByRole('textbox', { name: 'Within' })).toBeTruthy();
    expect(screen.getByText('Discord')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Ask the analyst to look' })).toBeNull();
    unmount();
    const own = formFromAlert(alert({ sessionId: 'S1', createdBy: 'agent' }), {
      symbol: 'NQ Z6',
      decimals: 2,
      tick: 0.25,
    });
    render(<FormHarness start={own} onSubmit={submit} />);
    expect(screen.getByRole('form', { name: 'Change the alert' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Price').value).toBe('21000.00');
    expect(screen.getByRole('switch', { name: 'Ask the analyst to look' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});

function withRuntime(children: ReactNode) {
  const closed = { status: 'closed', server: null };
  const client = {
    request: vi.fn(() => new Promise(() => undefined)),
    subscribe: () => () => undefined,
    state: { subscribe: () => () => undefined, getSnapshot: () => closed },
  };
  return <TestRuntime client={client as unknown as FakeClient}>{children}</TestRuntime>;
}

describe('the Alerts list', () => {
  const act$ = (): AlertActions & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      edit: (a) => calls.push(`edit ${a.id}`),
      pause: (a, paused) => {
        calls.push(`${paused ? 'pause' : 'resume'} ${a.id}`);
        return Promise.resolve(a.id === 'al_2' ? 'Refused for a reason' : null);
      },
      remove: (a) => {
        calls.push(`delete ${a.id}`);
        return Promise.resolve(null);
      },
    };
  };

  it('lists those watching first, then the spent, then the firings, with their verbs', async () => {
    const alerts = new Map(
      [
        alert({ id: 'al_1', createdAt: 3, message: 'open drive' }),
        alert({ id: 'al_2', createdAt: 2, status: 'paused', title: 'NQ is below 20900' }),
        alert({ id: 'al_3', createdAt: 4, status: 'triggered', title: 'NQ sweeps', fireCount: 1, firedAt: NOW * 1e6 }),
      ].map((a) => [a.id, a]),
    );
    const act2 = act$();
    render(
      withRuntime(
        <AlertsList alerts={alerts} fires={[fire({ discord: 'sent', title: 'NQ sweeps' })]} act={act2} nowMs={NOW} />,
      ),
    );
    const rows = document.querySelectorAll('tr[data-alert]');
    expect([...rows].map((r) => r.getAttribute('data-alert'))).toEqual(['al_1', 'al_2', 'al_3']);
    expect(screen.getByText('Watching · 2')).toBeTruthy();
    expect(screen.getByText('Fired · 1')).toBeTruthy();
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('NQ crosses above 21000')).toBeTruthy();
    expect(first.getByText('21,000.00')).toBeTruthy();
    expect(first.getByText('Active')).toBeTruthy();
    const second = within(rows[1] as HTMLElement);
    expect(second.getByText('Paused')).toBeTruthy();
    const third = within(rows[2] as HTMLElement);
    expect(third.getByText('Fired')).toBeTruthy();
    const fired = document.querySelector<HTMLElement>('tr[data-fire="af_1"]')!;
    expect(within(fired).getByText('Apex · Rithmic')).toBeTruthy();
    expect(within(fired).getByText('Discord')).toBeTruthy();
    expect(within(fired).getByText('21,000.25')).toBeTruthy();

    await act(async () => {
      fireEvent.click(first.getByRole('button', { name: 'Pause' }));
      fireEvent.click(second.getByRole('button', { name: 'Resume' }));
      fireEvent.click(third.getByRole('button', { name: 'Re-arm' }));
      fireEvent.click(first.getByRole('button', { name: 'Delete NQ crosses above 21000' }));
      fireEvent.click(first.getByRole('button', { name: 'Edit' }));
      await Promise.resolve();
    });
    expect(act2.calls).toEqual(['pause al_1', 'resume al_2', 'resume al_3', 'delete al_1', 'edit al_1']);
    expect(second.getByText('Refused for a reason')).toBeTruthy();
  });

  it('says how to make one when there is none', () => {
    render(withRuntime(<AlertsList alerts={new Map()} fires={[]} act={act$()} nowMs={NOW} />));
    expect(screen.getByText(/No alerts\. Right-click the chart at a price/)).toBeTruthy();
  });
});
