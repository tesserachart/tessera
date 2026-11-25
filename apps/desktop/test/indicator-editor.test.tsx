import type { IndicatorSeries } from '@tessera/protocol';
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
import { edit } from '../src/areas/indicators/model.ts';
import { read, write } from '../src/app/store.ts';
import { answeringClient, TestRuntime } from './support/runtime.tsx';

vi.mock('../src/areas/indicators/PreviewChart.tsx', () => ({ PreviewChart: () => null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  write(editorLayout, { codeShare: DEFAULT_CODE_SHARE, codeOnly: false });
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
