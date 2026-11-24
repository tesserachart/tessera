import type { SessionMode } from '@tessera/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@tessera/ui';
import { useModeChange } from '../src/analyst/modeChange.tsx';
import { ModePicker } from '../src/areas/agents/ModePicker.tsx';
import { FULL_ACCESS_WARNING, MODES, asksFirst } from '../src/analyst/modes.ts';

afterEach(cleanup);

function Harness({ apply }: { apply: (m: SessionMode) => void }) {
  const [mode, setMode] = useState<SessionMode>('auto_modify');
  const { request, dialog } = useModeChange(mode, (m) => {
    apply(m);
    setMode(m);
  });
  return (
    <>
      <p data-testid="mode">{mode}</p>
      {MODES.map((m) => (
        <button key={m.value} type="button" onClick={() => request(m.value)}>
          {`pick ${m.value}`}
        </button>
      ))}
      {dialog}
    </>
  );
}

describe('the analyst’s modes (decision 0018)', () => {
  it('only Full access asks first; every step back is instant', () => {
    expect(MODES.map((m) => m.value)).toEqual(['read_only', 'supervised', 'auto_modify', 'full_access']);
    expect(asksFirst('auto_modify', 'full_access')).toBe(true);
    expect(asksFirst(null, 'full_access')).toBe(true);
    expect(asksFirst('full_access', 'full_access')).toBe(false);
    for (const to of ['supervised', 'auto_modify', 'read_only'] as const)
      expect(asksFirst('full_access', to)).toBe(false);
  });

  it('turning on Full access shows the one warning; Cancel keeps the mode, Turn on sets it', () => {
    const apply = vi.fn();
    render(<Harness apply={apply} />);
    fireEvent.click(screen.getByText('pick full_access'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_WARNING)).toBeTruthy();
    expect(FULL_ACCESS_WARNING).toMatch(/including live accounts\. Your risk limits still apply\.$/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByTestId('mode').textContent).toBe('auto_modify');

    fireEvent.click(screen.getByText('pick full_access'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(apply).toHaveBeenCalledWith('full_access');
    expect(screen.getByTestId('mode').textContent).toBe('full_access');

    fireEvent.click(screen.getByText('pick supervised'));
    expect(apply).toHaveBeenLastCalledWith('supervised');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the composer’s mode menu says under each mode what it may do, orders included', () => {
    render(
      <TooltipProvider>
        <ModePicker mode="auto_modify" onMode={vi.fn()} />
      </TooltipProvider>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Mode: Auto-modify' }), { key: 'Enter' });
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(MODES.map((m) => `${m.label}${m.hint}`));
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);
    for (const m of MODES.filter((x) => x.value !== 'full_access'))
      expect(m.hint).toMatch(/drafts no orders|Every order is a draft you approve/);
    expect(MODES.find((m) => m.value === 'full_access')!.hint).toMatch(
      /places, changes and closes orders without asking/,
    );
  });
});
