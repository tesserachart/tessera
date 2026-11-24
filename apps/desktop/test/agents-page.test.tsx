import type { AgentSessionSummary } from '@tessera/protocol';
import { PlatformProvider, TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analystStore, applySessions, EMPTY_ANALYST, selectSession } from '../src/analyst/analystStore.ts';
import { analystInView } from '../src/analyst/focus.ts';
import { read, write } from '../src/app/store.ts';
import { AreaRail } from '../src/areas/AreaRail.tsx';
import { AreaView } from '../src/areas/AreaView.tsx';
import { AREAS } from '../src/areas/registry.ts';
import { areaStore } from '../src/areas/store.ts';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import { CommandRegistry } from '../src/commands/registry.ts';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import { tileDefinition } from '../src/workspace/tiles/index.ts';
import { TestRuntime } from './support/runtime.tsx';

const session: AgentSessionSummary = {
  id: 's_1',
  title: 'ORB plan',
  preset: 'Trader',
  provider: 'codex',
  model: 'gpt-5',
  mode: 'supervised',
  status: 'idle',
  origin: { kind: 'agent', sessionId: 's_1', provider: 'codex' },
  sourceLabel: null,
  createdAt: 0,
  updatedAt: 0,
};

function altDigit(shortcut: string) {
  const digit = /^alt\+(\d)$/.exec(shortcut)?.[1];
  if (!digit) throw new Error(`not an ⌥ digit: ${shortcut}`);
  return { key: digit, code: `Digit${digit}`, ctrlKey: false, altKey: true, shiftKey: false, metaKey: false };
}

describe('every area', () => {
  afterEach(() => write(areaStore, { area: 'desk', previous: null }));

  const pages = AREAS.filter((a) => a.id !== 'desk');

  it('but the desk is a page of its own', () => {
    expect(pages.filter((a) => a.page === null).map((a) => a.id)).toEqual([]);
  });

  it('opens its page from its shortcut and its Go to command', () => {
    const r = new CommandRegistry();
    const off = registerBuiltinCommands(r, { focusComposer: () => {} });
    for (const a of pages.filter((p) => !p.accounts)) {
      write(areaStore, { area: 'desk', previous: null });
      const id = r.handleKey(altDigit(a.shortcut), 'chart', 'other', false);
      expect([id, read(areaStore).area]).toEqual([`area.${a.id}`, a.id]);
      write(areaStore, { area: 'desk', previous: null });
      void r.get(`area.${a.id}`)!.run();
      expect(read(areaStore).area).toBe(a.id);
    }
    off();
  });

  it('that is also a panel names a panel the desk can add', () => {
    for (const a of AREAS.filter((p) => p.tile))
      expect(tileDefinition(a.tile!), a.id).toMatchObject({ singleton: true });
  });
});

describe('the Agents page', () => {
  const page = () => document.querySelector<HTMLElement>('.ar-layer[data-area="agents"]');
  const shown = () => page() !== null && !page()!.hidden;

  beforeEach(() => {
    write(areaStore, { area: 'desk', previous: null });
    act(() => {
      applySessions({ type: 'snapshot', sessions: [session] });
      selectSession('s_1');
    });
    render(
      <TestRuntime client={{}} bridge={{ kind: 'browser' }}>
        <PlatformProvider value="other">
          <TooltipProvider>
            <ShellDataContext.Provider value={EMPTY_SHELL_DATA}>
              <AreaRail />
              <AreaView desk={<div />} />
            </ShellDataContext.Provider>
          </TooltipProvider>
        </PlatformProvider>
      </TestRuntime>,
    );
  });

  afterEach(() => {
    cleanup();
    write(areaStore, { area: 'desk', previous: null });
    write(analystStore, EMPTY_ANALYST);
  });

  it('opens full page from the rail, with its sessions and the analyst’s composer', async () => {
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Areas' })).getByRole('button', { name: 'Analyst' }));
    expect(read(areaStore).area).toBe('agents');
    expect(shown()).toBe(true);
    expect(await within(page()!).findByRole('heading', { level: 1, name: 'Analyst' })).toBeTruthy();
    const analyst = within(page()!).getByRole('region', { name: 'Analyst' });
    expect(within(analyst).getByRole('textbox', { name: 'Ask the analyst' })).toBeTruthy();
    expect(within(page()!).getByRole('complementary', { name: 'Sessions' })).toBeTruthy();
  });

  it('opens full page from ⌥3 and from Go to Analyst in ⌘K', () => {
    const r = new CommandRegistry();
    const off = registerBuiltinCommands(r, { focusComposer: () => {} });
    act(() => {
      expect(r.handleKey(altDigit('alt+3'), 'chart', 'other', false)).toBe('area.agents');
    });
    expect(shown()).toBe(true);
    act(() => write(areaStore, { area: 'desk', previous: null }));
    expect(shown()).toBe(false);
    const go = r.get('area.agents')!;
    expect(go.title).toBe('Go to Analyst');
    act(() => void go.run());
    expect(shown()).toBe(true);
    off();
  });

  it('counts as the analyst in view, so its replies are read there', () => {
    act(() => write(areaStore, { area: 'agents', previous: 'desk' }));
    expect(analystInView()).toBe(true);
    act(() => write(areaStore, { area: 'journal', previous: 'agents' }));
    expect(analystInView()).toBe(false);
  });

  it('is still the Analyst panel the desk can add', () => {
    expect(tileDefinition('analyst')).toMatchObject({ title: 'Analyst', singleton: true });
  });
});
