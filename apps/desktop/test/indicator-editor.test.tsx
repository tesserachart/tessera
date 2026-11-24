import type { IndicatorSeries } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeEditor } from '../src/areas/indicators/CodeEditor.tsx';
import { CustomEditor } from '../src/areas/indicators/CustomEditor.tsx';
import { edit } from '../src/areas/indicators/model.ts';
import { answeringClient, TestRuntime } from './support/runtime.tsx';

vi.mock('../src/areas/indicators/PreviewChart.tsx', () => ({ PreviewChart: () => null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
