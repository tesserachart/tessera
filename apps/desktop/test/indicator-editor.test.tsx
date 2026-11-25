import { INDICATOR_SPECS, type IndicatorDetail, type IndicatorSeries, type IndicatorSpec } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeEditor } from '../src/areas/indicators/CodeEditor.tsx';
import { CustomEditor } from '../src/areas/indicators/CustomEditor.tsx';
import {
  CODE_MIN_PX,
  DEFAULT_CODE_SHARE,
  editorLayout,
  fitShare,
  PREVIEW_MIN_PX,
} from '../src/areas/indicators/layout.ts';
import { edit, pageStore, run, save, setPreviewInput } from '../src/areas/indicators/model.ts';
import { read, write } from '../src/app/store.ts';
import { answeringClient, setTestServices, TestRuntime } from './support/runtime.tsx';

vi.mock('../src/areas/indicators/PreviewChart.tsx', () => ({ PreviewChart: () => null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  write(editorLayout, { codeShare: DEFAULT_CODE_SHARE, codeOnly: false });
  write(pageStore, { ...read(pageStore), drafts: {}, runs: {}, inputs: {}, saved: {} });
});

const editor = (value: string) => (
  <CodeEditor
    value={value}
    label="Indicator code"
    onChange={() => undefined}
    onRun={() => undefined}
    onSave={() => undefined}
    problem={null}
  />
);

describe('the code editor', () => {
  it('opens on the code it is given, under its label, and takes new code into the same editor', () => {
    const { container, rerender } = render(editor('const a = 1;'));
    const content = container.querySelector('.cm-content')!;
    expect(content.getAttribute('aria-label')).toBe('Indicator code');
    expect(content.textContent).toBe('const a = 1;');
    rerender(editor('const b = 2;'));
    expect(container.querySelector('.cm-content')).toBe(content);
    expect(content.textContent).toBe('const b = 2;');
  });

  it('wraps long lines, and a wrapped line hangs under its own indent', () => {
    const { container } = render(editor('function f() {\n    return 1;\n}'));
    expect(container.querySelector('.cm-content')!.classList.contains('cm-lineWrapping')).toBe(true);
    const lines = [...container.querySelectorAll<HTMLElement>('.cm-line')];
    expect(lines.map((l) => l.style.getPropertyValue('--ia-indent'))).toEqual(['', '4ch', '']);
  });
});

describe('the room the code gets', () => {
  it('keeps the code and the preview at least their minimum width, whatever share is asked for', () => {
    const width = 1200;
    expect(fitShare(0.05, width) * width).toBe(CODE_MIN_PX);
    expect(width - fitShare(0.99, width) * width).toBeGreaterThanOrEqual(PREVIEW_MIN_PX);
    expect(fitShare(0.6, width)).toBe(0.6);
    expect(fitShare(0.6, 500)).toBe(DEFAULT_CODE_SHARE);
  });
});

describe('a custom indicator’s editor', () => {
  it('runs the code as it opens and a moment after typing, never again for a run’s own result', async () => {
    vi.useFakeTimers();
    const series = { spec: { title: 'Test', inputs: [], plots: [] }, logs: '' } as unknown as IndicatorSeries;
    const { client, calls } = answeringClient({ 'indicators.preview': () => series });
    const previews = () => calls.filter((c) => c.name === 'indicators.preview').length;
    render(
      <TestRuntime client={client}>
        <TooltipProvider>
          <CustomEditor
            id="new"
            indicator={null}
            chart={null}
            preview={{ instrument: 'NQ', tf: '1m' }}
            unavailable={null}
          />
        </TooltipProvider>
      </TestRuntime>,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(previews()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(previews()).toBe(1);
    act(() => edit('new', 'export const indicator = { title: "Edited" };'));
    await act(() => vi.advanceTimersByTimeAsync(699));
    expect(previews()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(previews()).toBe(2);
  });
});

const SERIES = { spec: { title: 'Test', inputs: [], plots: [] }, logs: '' } as unknown as IndicatorSeries;

function held<O>() {
  const waiting: ((value: O) => void)[] = [];
  const answer = () =>
    new Promise<O>((resolve) => {
      waiting.push(resolve);
    });
  return { waiting, answer };
}

const SPEC: IndicatorSpec = { ...INDICATOR_SPECS.find((s) => s.kind === 'sma')!, kind: 'custom', title: 'Stretch' };

const seriesTitled = (title: string): IndicatorSeries => ({
  indicator: 'new',
  version: null,
  spec: { ...SPEC, title },
  description: null,
  instrument: 'NQ',
  tf: '1m',
  inputs: {},
  time: [],
  plots: [],
  objects: { lines: [], labels: [], boxes: [] },
  bars: 0,
  computedFrom: null,
  computeMs: 0,
  cpuMs: 0,
  logs: '',
  provider: 'test',
});

const savedDetail = (id: string, code: string, version: number): IndicatorDetail => ({
  builtin: null,
  custom: {
    id,
    version,
    latest: version,
    spec: SPEC,
    description: null,
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'user',
  },
  code,
  versions: [],
});

describe('a custom indicator’s preview and save', () => {
  it('keeps the newest preview when an older one answers last', async () => {
    const previews = held<IndicatorSeries>();
    setTestServices(answeringClient({ 'indicators.preview': previews.answer }).client);
    edit('new', 'export const indicator = { title: "One" };');
    const first = run('new', 'NQ', '1m');
    await Promise.resolve();
    setPreviewInput('new', 'length', 9);
    const second = run('new', 'NQ', '1m');
    await vi.waitFor(() => expect(previews.waiting).toHaveLength(2));
    previews.waiting[1]!(seriesTitled('Newer'));
    await second;
    previews.waiting[0]!(seriesTitled('Older'));
    await first;
    expect(read(pageStore).runs.new?.series?.spec.title).toBe('Newer');
  });

  it('keeps what was typed while a save was on its way as the draft, and saves only what it sent', async () => {
    const saves = held<IndicatorDetail>();
    setTestServices(answeringClient({ 'indicators.update_custom': saves.answer }).client);
    write(pageStore, {
      ...read(pageStore),
      saved: { c1: { version: 1, code: 'v1', detail: savedDetail('c1', 'v1', 1) } },
      drafts: {},
    });
    edit('c1', 'v2');
    const saving = save('c1');
    await vi.waitFor(() => expect(saves.waiting).toHaveLength(1));
    edit('c1', 'v3');
    saves.waiting[0]!(savedDetail('c1', 'v2', 2));
    await saving;
    expect(read(pageStore).saved.c1?.code).toBe('v2');
    expect(read(pageStore).drafts.c1).toBe('v3');
  });

  it('says plainly that an indicator could not be opened, instead of loading for ever', async () => {
    const { client } = answeringClient({
      'indicators.get': () => {
        throw new Error('gone');
      },
    });
    render(
      <TestRuntime client={client}>
        <TooltipProvider>
          <CustomEditor
            id="c9"
            indicator={null}
            chart={null}
            preview={{ instrument: 'NQ', tf: '1m' }}
            unavailable={null}
          />
        </TooltipProvider>
      </TestRuntime>,
    );
    expect(await screen.findByText('This indicator could not be opened.')).toBeTruthy();
  });
});

describe('the code and its preview', () => {
  const open = () =>
    render(
      <TestRuntime client={answeringClient({ 'indicators.preview': () => SERIES }).client}>
        <TooltipProvider>
          <CustomEditor
            id="new"
            indicator={null}
            chart={null}
            preview={{ instrument: 'NQ', tf: '1m' }}
            unavailable={null}
          />
        </TooltipProvider>
      </TestRuntime>,
    );

  it('gives the code the whole page and brings the chart back with one click', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Maximise the code' }));
    expect(read(editorLayout).codeOnly).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show the chart' }));
    expect(read(editorLayout).codeOnly).toBe(false);
  });

  it('flips between code only and the chart from the keyboard while typing', () => {
    const { container } = open();
    const content = container.querySelector('.cm-content')!;
    fireEvent.keyDown(content, { key: 'Enter', keyCode: 13, ctrlKey: true, shiftKey: true });
    expect(read(editorLayout).codeOnly).toBe(true);
    fireEvent.keyDown(content, { key: 'Enter', keyCode: 13, ctrlKey: true, shiftKey: true });
    expect(read(editorLayout).codeOnly).toBe(false);
  });

  it('widens the code from the divider and puts it back with Enter', () => {
    const { container } = open();
    const body = container.querySelector<HTMLElement>('.ia-ed-body')!;
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect);
    const divider = screen.getByRole('separator', { name: 'Resize the code' });
    fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true });
    expect(read(editorLayout).codeShare).toBeCloseTo(DEFAULT_CODE_SHARE + 0.064);
    expect(body.style.getPropertyValue('--ia-code')).toBe('61.40%');
    fireEvent.keyDown(divider, { key: 'Enter' });
    expect(read(editorLayout).codeShare).toBe(DEFAULT_CODE_SHARE);
  });
});
