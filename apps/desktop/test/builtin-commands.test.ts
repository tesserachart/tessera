import { describe, expect, it, vi } from 'vitest';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import { CommandRegistry } from '../src/commands/registry.ts';

const key = (k: string, code: string, mods: Partial<Record<'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: k,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('built-in commands', () => {
  it('keeps "/" with the analyst on a focused chart; ⌥I adds an indicator there', () => {
    const r = new CommandRegistry();
    const focusComposer = vi.fn();
    const off = registerBuiltinCommands(r, { focusComposer });
    expect(r.get('chart.addIndicator')?.shortcut).toBe('alt+i');
    expect(r.handleKey(key('/', 'Slash'), 'chart', 'other', false)).toBe('agent.focusComposer.slash');
    expect(focusComposer).toHaveBeenCalledOnce();
    off();
  });
});
