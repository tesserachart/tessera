import type { TelemetryConfigOutput, TelemetryStatusOutput, TelemetryWindowEvent } from '@tessera/protocol';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const posthog = vi.hoisted(() => ({ loads: 0 }));
vi.mock('posthog-js/no-external', async (importOriginal) => {
  posthog.loads += 1;
  return importOriginal();
});

const requests = vi.hoisted(() => ({ fetch: vi.fn(), xhr: vi.fn(), beacon: vi.fn() }));

beforeAll(() => {
  vi.stubGlobal('fetch', requests.fetch);
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      open = requests.xhr;
      send = requests.xhr;
      setRequestHeader = () => undefined;
      addEventListener = () => undefined;
    },
  );
  Object.defineProperty(navigator, 'sendBeacon', { value: requests.beacon, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const HAS_PROJECT: TelemetryStatusOutput = { available: true };

const NOTHING_REMOTE: TelemetryConfigOutput = { asked: true, flags: {}, replay: null, surveys: [] };

const pause = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const LOADING_HANG_GUARD_MS = 60_000;

const FRESH = { crashes: true, usage: null };
const EVERYTHING = { crashes: true, usage: true };

async function openWindow(
  consent: unknown,
  status: TelemetryStatusOutput = HAS_PROJECT,
  remote: TelemetryConfigOutput | (() => TelemetryConfigOutput) = NOTHING_REMOTE,
) {
  vi.resetModules();
  localStorage.clear();
  const support = await import('./support/runtime.tsx');
  const telemetry = await import('../src/app/telemetry.ts');
  const settings = await import('../src/state/runtimeSettings.ts');
  const areas = await import('../src/areas/store.ts');
  const { ErrorBoundary } = await import('../src/app/ErrorBoundary.tsx');
  const flags = await import('../src/app/flags.ts');
  const survey = await import('../src/app/survey.ts');
  const { client, calls } = support.answeringClient({
    'telemetry.status': () => status,
    'telemetry.config': () => (typeof remote === 'function' ? remote() : remote),
    'telemetry.capture': ({ events }) => ({ sent: events.length }),
  });
  support.setTestServices(client);
  support.seedTools(['telemetry.status']);
  settings.putRuntimeSettings({ 'telemetry.consent': consent }, true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stop = telemetry.installTelemetry();
  function Window({ children }: { children?: ReactNode }) {
    telemetry.useTelemetry();
    return children;
  }
  const view = render(
    <support.TestRuntime client={client}>
      <Window />
    </support.TestRuntime>,
  );
  const sent = (): TelemetryWindowEvent[] =>
    calls
      .filter((c) => c.name === 'telemetry.capture')
      .flatMap((c) => (c.input as { events: TelemetryWindowEvent[] }).events);
  const names = () => sent().map((e) => e.event);
  const stopDrawing = (part: string) => {
    function Broken(): never {
      throw new TypeError('no instrument');
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    view.rerender(
      <support.TestRuntime client={client}>
        <Window>
          <ErrorBoundary name={part}>
            <Broken />
          </ErrorBoundary>
        </Window>
      </support.TestRuntime>,
    );
  };
  let now = consent as Record<string, unknown>;
  const answer = (change: Record<string, unknown>) => {
    now = { ...now, ...change };
    act(() => settings.putRuntimeSettings({ 'telemetry.consent': now }, false));
  };
  const statusAsked = () => vi.waitFor(() => expect(calls.map((c) => c.name)).toContain('telemetry.status'));
  const on = () => vi.waitFor(() => expect(names()).toContain('app opened'), { timeout: LOADING_HANG_GUARD_MS });
  const mount = (child: ReactNode) =>
    view.rerender(
      <support.TestRuntime client={client}>
        <Window>{child}</Window>
      </support.TestRuntime>,
    );
  return { telemetry, flags, survey, areas, calls, sent, names, stopDrawing, answer, statusAsked, on, stop, mount };
}

describe('crash reports and usage analytics from the window', { timeout: 2 * LOADING_HANG_GUARD_MS }, () => {
  it('with crash reports off, sends nothing and never loads posthog-js before the usage answer or after No', async () => {
    for (const usage of [null, false]) {
      const w = await openWindow({ crashes: false, usage });
      const loadsBefore = posthog.loads;
      await w.statusAsked();
      w.stopDrawing('Ticket');
      act(() => w.areas.showArea('journal'));
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('late'), message: 'late' }));
      await pause(1_500);
      expect(w.sent()).toEqual([]);
      expect(posthog.loads).toBe(loadsBefore);
      w.stop();
      cleanup();
    }
  });

  it('a fresh install sends a part that stops drawing as a crash report, and usage only after the Yes', async () => {
    const w = await openWindow(FRESH);
    w.stopDrawing('Ticket');
    await vi.waitFor(() => expect(w.names()).toContain('$exception'), { timeout: LOADING_HANG_GUARD_MS });
    act(() => w.areas.showArea('journal'));
    await pause(1_500);
    expect(w.names()).toEqual(['$exception']);
    expect(w.calls.map((c) => c.name)).not.toContain('telemetry.config');
    w.answer({ usage: true });
    await vi.waitFor(() => expect(w.names()).toContain('area opened'), { timeout: LOADING_HANG_GUARD_MS });
    expect(w.names()).toEqual(['$exception', 'app opened', 'area opened']);
    w.stop();
  });

  it('crash reports off sends no error, while usage still goes', async () => {
    const w = await openWindow({ crashes: false, usage: true });
    await w.on();
    w.stopDrawing('Ticket');
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('late'), message: 'late' }));
    act(() => w.areas.showArea('journal'));
    await vi.waitFor(() => expect(w.names()).toContain('area opened'), { timeout: LOADING_HANG_GUARD_MS });
    await pause(1_200);
    expect(w.names()).not.toContain('$exception');
    w.stop();
  });

  it('on Yes, a part that stops drawing reaches the runtime as an exception, and posthog-js sends nothing itself', async () => {
    const w = await openWindow(EVERYTHING);
    await w.on();
    w.stopDrawing('Ticket');
    await vi.waitFor(() => expect(w.names()).toContain('$exception'), { timeout: LOADING_HANG_GUARD_MS });
    const exception = w.sent().find((e) => e.event === '$exception')!;
    expect(exception.properties).toMatchObject({ kind: 'render', place: 'Ticket' });
    expect(exception.properties.component_stack).toContain('Broken');
    expect(exception.properties.$exception_list).toEqual([
      expect.objectContaining({ type: 'TypeError', value: 'no instrument' }),
    ]);
    window.dispatchEvent(new Event('pagehide'));
    await pause(100);
    expect(requests.fetch).not.toHaveBeenCalled();
    expect(requests.xhr).not.toHaveBeenCalled();
    expect(requests.beacon).not.toHaveBeenCalled();
    expect(document.querySelectorAll('script')).toHaveLength(0);
    w.stop();
  });

  it('an error nothing caught is sent once, with where it was thrown', async () => {
    const w = await openWindow(EVERYTHING);
    await w.on();
    const error = new TypeError('x is undefined');
    for (let i = 0; i < 3; i++)
      window.dispatchEvent(
        new ErrorEvent('error', { error, message: error.message, filename: 'app.js', lineno: 12, colno: 4 }),
      );
    await vi.waitFor(() => expect(w.names()).toContain('$exception'), { timeout: LOADING_HANG_GUARD_MS });
    await pause(1_200);
    const exceptions = w.sent().filter((e) => e.event === '$exception');
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.properties).toMatchObject({ kind: 'error', place: 'app.js:12:4' });
    w.stop();
  });

  it('names the areas and panels opened, and nothing about them', async () => {
    const w = await openWindow(EVERYTHING);
    await w.on();
    const listeners: ((panel: { api: { component: string } }) => void)[] = [];
    const dock = {
      onDidAddPanel: (listener: (panel: { api: { component: string } }) => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    };
    let restoring = true;
    const unwatch = w.telemetry.watchPanelOpens(dock as never, () => restoring);
    listeners.forEach((l) => l({ api: { component: 'chart' } }));
    restoring = false;
    act(() => w.areas.showArea('journal'));
    listeners.forEach((l) => l({ api: { component: 'dom' } }));
    await vi.waitFor(() => expect(w.names()).toContain('panel opened'), { timeout: LOADING_HANG_GUARD_MS });
    const product = w.sent().filter((e) => e.event !== 'app opened');
    expect(product.map((e) => [e.event, e.properties.area ?? e.properties.panel])).toEqual([
      ['area opened', 'journal'],
      ['panel opened', 'dom'],
    ]);
    unwatch();
    w.stop();
  });

  it('No to usage stops it at once and keeps crash reports, and Yes again resumes without a second app opened', async () => {
    const w = await openWindow(EVERYTHING);
    await w.on();
    w.answer({ usage: false });
    act(() => w.areas.showArea('research'));
    w.stopDrawing('Chart');
    await vi.waitFor(() => expect(w.names()).toContain('$exception'), { timeout: LOADING_HANG_GUARD_MS });
    await pause(1_500);
    expect(w.names()).toEqual(['app opened', '$exception']);
    w.answer({ usage: true });
    await pause(50);
    act(() => w.areas.showArea('journal'));
    await vi.waitFor(() => expect(w.names()).toContain('area opened'), { timeout: LOADING_HANG_GUARD_MS });
    expect(w.names()).toEqual(['app opened', '$exception', 'area opened']);
    expect(w.sent()[2]!.properties.area).toBe('journal');
    w.stop();
  });

  it('a flag from the project chooses the feature; without sharing the feature keeps its fallback', async () => {
    const seen: (boolean | string)[] = [];
    for (const [share, remote] of [
      [false, NOTHING_REMOTE],
      [true, { ...NOTHING_REMOTE, flags: { 'analyst-trading-sessions': false } }],
    ] as const) {
      const w = await openWindow({ crashes: true, usage: share }, HAS_PROJECT, remote);
      function Gate() {
        seen.push(w.flags.useFlag('analyst-trading-sessions'));
        return null;
      }
      w.mount(<Gate />);
      if (share) {
        await w.on();
        await vi.waitFor(() => expect(w.names()).toContain('$feature_flag_called'), {
          timeout: LOADING_HANG_GUARD_MS,
        });
        const called = w.sent().find((e) => e.event === '$feature_flag_called')!;
        expect(called.properties).toMatchObject({
          $feature_flag: 'analyst-trading-sessions',
          $feature_flag_response: false,
        });
      } else {
        await w.statusAsked();
        await pause(1_500);
        expect(w.calls.map((c) => c.name)).not.toContain('telemetry.config');
      }
      expect(seen.at(-1)).toBe(share ? false : true);
      w.stop();
      cleanup();
    }
  });

  it('a survey answer goes out once, keyed by question, with what the person did on the survey', async () => {
    const pmf = {
      id: 'pmf',
      name: 'Alpha: how would you feel',
      questions: [
        {
          id: 'q1',
          kind: 'single_choice' as const,
          question: 'How would you feel?',
          description: null,
          choices: ['Very disappointed', 'Somewhat disappointed', 'Not disappointed'],
          optional: false,
        },
        { id: 'q2', kind: 'open' as const, question: 'Why?', description: null, choices: [], optional: true },
      ],
    };
    const w = await openWindow(EVERYTHING, HAS_PROJECT, { ...NOTHING_REMOTE, surveys: [pmf] });
    let due: ReturnType<typeof w.survey.useDueSurvey> | null = null;
    function Ask() {
      due = w.survey.useDueSurvey();
      return null;
    }
    w.mount(<Ask />);
    await w.on();
    await vi.waitFor(() => expect(due?.survey?.id).toBe('pmf'), { timeout: LOADING_HANG_GUARD_MS });
    act(() => due!.send({ q1: 'Very disappointed', q2: '  ' }));
    await vi.waitFor(() => expect(w.names()).toContain('survey sent'), { timeout: LOADING_HANG_GUARD_MS });
    const sent = w.sent().find((e) => e.event === 'survey sent')!;
    expect(sent.properties).toMatchObject({
      $survey_id: 'pmf',
      $survey_response_q1: 'Very disappointed',
      $set: { '$survey_responded/pmf': true },
    });
    expect(sent.properties).not.toHaveProperty('$survey_response_q2');
    expect(due!.survey).toBeNull();
    w.stop();
  });

  it('waits for the runtime to share before it takes the project’s answer', async () => {
    let asks = 0;
    const w = await openWindow(EVERYTHING, HAS_PROJECT, () => {
      asks += 1;
      return asks < 3
        ? { ...NOTHING_REMOTE, asked: false }
        : { ...NOTHING_REMOTE, flags: { 'analyst-trading-sessions': 'held' } };
    });
    const seen: (boolean | string)[] = [];
    function Gate() {
      seen.push(w.flags.useFlag('analyst-trading-sessions'));
      return null;
    }
    w.mount(<Gate />);
    await w.statusAsked();
    await pause(500);
    expect(w.names()).toEqual([]);
    await w.on();
    expect(asks).toBeGreaterThanOrEqual(3);
    expect(seen.at(-1)).toBe('held');
    w.stop();
  });
});
