import { PlatformProvider, TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import {
  isLoneModifierPress,
  modifierRows,
  searchRows,
  usesModifier,
  type ModifierRow,
} from '../src/commands/modifierMap.ts';
import { CommandRegistry, commands } from '../src/commands/registry.ts';
import { useKeybindings } from '../src/commands/useKeybindings.ts';
import { read } from '../src/app/store.ts';
import { KeyOverlay } from '../src/shell/KeyOverlay.tsx';
import { closeKeyOverlay, keyOverlayStore } from '../src/shell/keyOverlay.ts';

const press = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

function builtinRows(held: 'alt' | 'meta', platform: 'mac' | 'other' = 'mac'): ModifierRow[] {
  const r = new CommandRegistry();
  const off = registerBuiltinCommands(r, { focusComposer: () => undefined });
  const rows = modifierRows(r.all(), held, {
    platform,
    zone: 'global',
    hasChart: false,
    isEnabled: (c) => r.isEnabled(c.id),
  });
  off();
  return rows;
}

describe('which actions a modifier owns, read from the registry', () => {
  it('⌥ lists the drawing tools with their keys, and says why they cannot run without a chart', () => {
    const rows = builtinRows('alt');
    const fixed = rows.find((r) => r.id === 'chart.draw.profile_range');
    expect(fixed).toMatchObject({ title: 'Draw: Fixed range volume profile', shortcut: 'alt+shift+p' });
    expect(fixed?.enabled).toBe(false);
    expect(fixed?.why).toBe('Open a chart first');
    expect(rows.every((r) => usesModifier(r.shortcut, 'alt', 'mac'))).toBe(true);
    expect(rows.some((r) => r.id === 'palette.open')).toBe(false);
  });

  it('⌘ lists the mod keys on a Mac; elsewhere they belong to Ctrl', () => {
    expect(builtinRows('meta').some((r) => r.id === 'palette.open')).toBe(true);
    expect(builtinRows('meta').some((r) => r.id === 'chart.draw.trend_line')).toBe(false);
    expect(usesModifier('mod+k', 'ctrl', 'other')).toBe(true);
    expect(usesModifier('mod+k', 'ctrl', 'mac')).toBe(false);
    expect(usesModifier('ctrl+tab', 'ctrl', 'mac')).toBe(true);
  });

  it('a command that knows why it cannot run says so', () => {
    const r = new CommandRegistry();
    r.register({
      id: 'buy',
      title: 'Buy market',
      group: 'Trade',
      shortcut: 'alt+w',
      zone: 'chart',
      when: () => false,
      unavailable: () => 'Order hotkeys are off',
      run: () => undefined,
    });
    const rows = modifierRows(r.all(), 'alt', {
      platform: 'mac',
      zone: 'global',
      hasChart: false,
      isEnabled: (c) => r.isEnabled(c.id),
    });
    expect(rows[0]?.why).toBe('Order hotkeys are off');
  });

  it('a key shown in two zones under one title is one row', () => {
    const r = new CommandRegistry();
    r.register({ id: 'a', title: 'Breakeven', group: 'Trade', shortcut: 'alt+e', zone: 'chart', run: () => undefined });
    r.register({ id: 'b', title: 'Breakeven', group: 'Trade', shortcut: 'alt+e', zone: 'dom', run: () => undefined });
    const rows = modifierRows(r.all(), 'alt', { platform: 'mac', zone: 'dom', hasChart: true, isEnabled: () => true });
    expect(rows.map((x) => x.id)).toEqual(['b']);
  });

  it('typing the rest of the chord picks that row first; a name finds the rest', () => {
    const rows = builtinRows('alt');
    const first = (key: string, code: string, shiftKey = false) =>
      searchRows(rows, { query: key, first: { key, code, shiftKey } }, 'alt', 'mac')[0]?.id;
    expect(first('P', 'KeyP', true)).toBe('chart.draw.profile_range');
    expect(first('p', 'KeyP')).toBe('chart.orderflow.volume_profile');
    expect(searchRows(rows, { query: 'fib', first: null }, 'alt', 'mac')[0]?.id).toBe('chart.draw.fib_retracement');
  });

  it('only a modifier pressed on its own arms the overlay', () => {
    expect(isLoneModifierPress(press('Alt', { altKey: true }))).toBe('alt');
    expect(isLoneModifierPress(press('Meta', { metaKey: true }))).toBe('meta');
    expect(isLoneModifierPress(press('Alt', { altKey: true, metaKey: true }))).toBeNull();
    expect(isLoneModifierPress(press('Alt', { altKey: true, shiftKey: true }))).toBeNull();
    expect(isLoneModifierPress(press('AltGraph', { altKey: true, ctrlKey: true }))).toBeNull();
    expect(isLoneModifierPress(press('Shift', { shiftKey: true }))).toBeNull();
  });
});

const ran: string[] = [];
let unregister: () => void = () => undefined;

function Host() {
  useKeybindings(commands);
  return <KeyOverlay />;
}

function mount() {
  render(
    <PlatformProvider value="mac">
      <TooltipProvider>
        <button type="button">chart</button>
        <input aria-label="note" />
        <Host />
      </TooltipProvider>
    </PlatformProvider>,
  );
}

const tap = (key: 'Alt' | 'Meta', target: Element | Window = window) => {
  const mods = key === 'Alt' ? { altKey: true } : { metaKey: true };
  fireEvent.keyDown(target, { key, ...mods });
  fireEvent.keyUp(target, { key });
};
const typeKey = (key: string, code: string, shiftKey = false) => fireEvent.keyDown(window, { key, code, shiftKey });
const overlay = () => screen.queryByRole('dialog', { name: '⌥ keys' });
const selected = () => screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true');

describe('the key overlay', () => {
  beforeEach(() => {
    ran.length = 0;
    const run = (id: string) => () => void ran.push(id);
    unregister = commands.registerAll([
      { id: 'draw.fixed', title: 'Draw: Fixed range', group: 'Chart', shortcut: 'alt+shift+p', run: run('draw.fixed') },
      { id: 'profile', title: 'Volume profile', group: 'Chart', shortcut: 'alt+p', run: run('profile') },
      { id: 'focus', title: 'Focus mode', group: 'View', shortcut: 'mod+alt+f', run: run('focus') },
      {
        id: 'off',
        title: 'Needs a DOM',
        group: 'DOM',
        shortcut: 'alt+o',
        zone: 'dom',
        when: () => false,
        run: run('off'),
      },
      { id: 'palette', title: 'Open command palette', group: 'General', shortcut: 'mod+k', run: run('palette') },
      { id: 'slash', title: 'Ask', group: 'Analyst', shortcut: '/', run: run('slash') },
    ]);
    mount();
  });
  afterEach(() => {
    act(() => closeKeyOverlay());
    cleanup();
    unregister();
    vi.useRealTimers();
  });

  it('tapping ⌥ lists every ⌥ action from the registry, with the reason one cannot run', () => {
    act(() => tap('Alt'));
    expect(overlay()).not.toBeNull();
    const names = screen.getAllByRole('option').map((o) => o.querySelector('.name')?.textContent);
    expect(names).toEqual(['Draw: Fixed range', 'Volume profile', 'Needs a DOM', 'Focus mode']);
    const off = screen.getAllByRole('option').find((o) => o.textContent.includes('Needs a DOM'))!;
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(off.textContent).toContain('Focus a DOM first');
    expect(screen.queryByText('Open command palette')).toBeNull();
  });

  it('typing the rest of the chord highlights it and Enter runs it, without taking the focus', () => {
    const chart = screen.getByRole('button', { name: 'chart' });
    chart.focus();
    act(() => tap('Alt', chart));
    act(() => typeKey('P', 'KeyP', true));
    expect(selected()?.textContent).toContain('Draw: Fixed range');
    act(() => typeKey('Enter', 'Enter'));
    expect(ran).toEqual(['draw.fixed']);
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(chart);
  });

  it('a name searches, a click runs, and a plain key never reaches the desk', () => {
    act(() => tap('Alt'));
    act(() => {
      for (const ch of '/foc') typeKey(ch, '');
    });
    expect(ran).toEqual([]);
    act(() => {
      for (let i = 0; i < 4; i++) typeKey('Backspace', 'Backspace');
    });
    act(() => {
      for (const ch of 'focus') typeKey(ch, '');
    });
    fireEvent.click(screen.getByText('Focus mode'));
    expect(ran).toEqual(['focus']);
    expect(overlay()).toBeNull();
  });

  it('Esc, a second tap, or a click outside dismisses it; tapping ⌘ switches to the ⌘ list', () => {
    act(() => tap('Alt'));
    act(() => typeKey('Escape', 'Escape'));
    expect(overlay()).toBeNull();
    act(() => tap('Alt'));
    act(() => tap('Alt'));
    expect(overlay()).toBeNull();
    act(() => tap('Alt'));
    act(() => tap('Meta'));
    expect(screen.getByRole('dialog', { name: '⌘ keys' })).not.toBeNull();
    expect(screen.getByText('Open command palette')).not.toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'chart' }));
    expect(read(keyOverlayStore).held).toBeNull();
  });

  it('a chord, a modifier-click or a text field never summons it', () => {
    act(() => {
      fireEvent.keyDown(window, { key: 'Alt', altKey: true });
      fireEvent.keyDown(window, { key: 'p', code: 'KeyP', altKey: true });
      fireEvent.keyUp(window, { key: 'p' });
      fireEvent.keyUp(window, { key: 'Alt' });
    });
    expect(ran).toEqual(['profile']);
    expect(overlay()).toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
      fireEvent.pointerDown(screen.getByRole('button', { name: 'chart' }), { metaKey: true });
      fireEvent.keyUp(window, { key: 'Meta' });
    });
    expect(read(keyOverlayStore).held).toBeNull();
    const note = screen.getByRole('textbox', { name: 'note' });
    note.focus();
    act(() => tap('Alt', note));
    expect(overlay()).toBeNull();
  });

  it('holding ⌥ shows it after 400 ms; a chord then runs and closes it; letting go keeps it open', () => {
    vi.useFakeTimers();
    act(() => {
      fireEvent.keyDown(window, { key: 'Alt', altKey: true });
      vi.advanceTimersByTime(399);
    });
    expect(overlay()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(overlay()).not.toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: 'Shift', altKey: true, shiftKey: true });
    });
    expect(overlay()).not.toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: 'P', code: 'KeyP', altKey: true, shiftKey: true });
    });
    expect(ran).toEqual(['draw.fixed']);
    expect(overlay()).toBeNull();
    act(() => fireEvent.keyUp(window, { key: 'Alt' }));
    act(() => {
      fireEvent.keyDown(window, { key: 'Alt', altKey: true });
      vi.advanceTimersByTime(500);
      fireEvent.keyUp(window, { key: 'Alt' });
    });
    expect(read(keyOverlayStore)).toMatchObject({ held: 'alt', pinned: true });
  });
});
