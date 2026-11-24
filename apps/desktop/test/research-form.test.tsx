import type { SaveStudyInput } from '@tessera/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { blankStudy } from '../src/areas/research/model.ts';
import { StudyForm } from '../src/areas/research/StudyForm.tsx';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { TestRuntime } from './support/runtime.tsx';

afterEach(() => {
  cleanup();
  putRuntimeSettings({ 'display.timeZone': null }, false);
});

function form(value: SaveStudyInput) {
  const changes: SaveStudyInput[] = [];
  render(
    <TestRuntime client={{}}>
      <StudyForm value={value} onChange={(v) => changes.push(v)} />
    </TestRuntime>,
  );
  return changes;
}

describe('the study form’s window', () => {
  it('takes the times a trader types in their own time zone', () => {
    putRuntimeSettings({ 'display.timeZone': 'Europe/London' }, false);
    const changes = form(blankStudy('NQ'));
    fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '14:30' } });
    expect(changes.at(-1)?.data.window).toEqual({ start: '14:30', end: '', timeZone: 'Europe/London' });
    expect(screen.getByText('Window')).toBeTruthy();
  });

  it('keeps a window’s own zone and names it when it is not the trader’s', () => {
    putRuntimeSettings({ 'display.timeZone': 'Europe/London' }, false);
    const s = blankStudy('NQ');
    const changes = form({ ...s, data: { ...s.data, window: { start: '09:30', end: '11:30' } } });
    expect(screen.getByText('Window · New York')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '12:00' } });
    expect(changes.at(-1)?.data.window).toEqual({ start: '09:30', end: '12:00', timeZone: 'America/New_York' });
  });
});
