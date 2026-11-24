import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { read, write } from '../src/app/store.ts';
import { AreaRail } from '../src/areas/AreaRail.tsx';
import { AreaView } from '../src/areas/AreaView.tsx';
import { areaStore } from '../src/areas/store.ts';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import { CommandRegistry } from '../src/commands/registry.ts';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import { tileDefinition } from '../src/workspace/tiles/index.ts';
import { TestRuntime } from './support/runtime.tsx';

vi.mock('../src/areas/indicators/PreviewChart.tsx', () => ({ PreviewChart: () => null }));

describe('the Indicators page', () => {
  const page = () => document.querySelector<HTMLElement>('.ar-layer[data-area="indicators"]');
  const shown = () => page() !== null && !page()!.hidden;

  beforeEach(() => {
    write(areaStore, { area: 'desk', previous: null });
    render(
      <TestRuntime client={{}} bridge={{ kind: 'browser' }}>
        <TooltipProvider>
          <ShellDataContext.Provider value={EMPTY_SHELL_DATA}>
            <AreaRail />
            <AreaView desk={<div />} />
          </ShellDataContext.Provider>
        </TooltipProvider>
      </TestRuntime>,
    );
  });

  afterEach(() => {
    write(areaStore, { area: 'desk', previous: null });
    cleanup();
  });

  it('opens full page from the rail, with its title, the indicator library and New indicator', async () => {
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Areas' })).getByRole('button', { name: 'Indicators' }),
    );
    expect(read(areaStore).area).toBe('indicators');
    expect(shown()).toBe(true);
    expect(await within(page()!).findByRole('heading', { level: 1, name: 'Indicators' })).toBeTruthy();
    const section = within(page()!).getByRole('region', { name: 'Indicators' });
    expect(within(section).getByRole('button', { name: 'New indicator' })).toBeTruthy();
  });

  it('opens full page from ⌥4 and from Go to Indicators in ⌘K', () => {
    const r = new CommandRegistry();
    const off = registerBuiltinCommands(r, { focusComposer: () => {} });
    const alt4 = { key: '4', code: 'Digit4', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false };
    act(() => {
      expect(r.handleKey(alt4, 'chart', 'other', false)).toBe('area.indicators');
    });
    expect(shown()).toBe(true);
    act(() => write(areaStore, { area: 'desk', previous: null }));
    expect(shown()).toBe(false);
    const go = r.get('area.indicators')!;
    expect(go.title).toBe('Go to Indicators');
    act(() => void go.run());
    expect(shown()).toBe(true);
    off();
  });

  it('is still a panel tile the desk can add', () => {
    expect(tileDefinition('indicators')).toMatchObject({ title: 'Indicators', singleton: true });
  });
});
