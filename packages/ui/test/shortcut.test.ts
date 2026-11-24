import { describe, expect, it } from 'vitest';
import { detectPlatform, formatShortcut, matchesShortcut, modifierLabel, parseShortcut } from '../src/shortcut.ts';

const ev = (
  key: string,
  mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
  code?: string,
) => ({
  key,
  ...(code ? { code } : {}),
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
  metaKey: mods.meta ?? false,
});

describe('shortcuts', () => {
  it('parses modifiers and aliases', () => {
    expect(parseShortcut('mod+shift+K')).toMatchObject({ mod: true, shift: true, key: 'k' });
    expect(parseShortcut('esc').key).toBe('escape');
    expect(parseShortcut('ctrl+opt+t')).toMatchObject({ ctrl: true, alt: true, key: 't' });
    expect(() => parseShortcut('ctrl+')).toThrow();
  });

  it('mod is Ctrl on Linux and ⌘ on macOS', () => {
    expect(matchesShortcut(ev('k', { ctrl: true }), 'mod+k', 'other')).toBe(true);
    expect(matchesShortcut(ev('k', { meta: true }), 'mod+k', 'other')).toBe(false);
    expect(matchesShortcut(ev('k', { meta: true }), 'mod+k', 'mac')).toBe(true);
    expect(matchesShortcut(ev('k', { ctrl: true }), 'mod+k', 'mac')).toBe(false);
  });

  it('requires exact modifiers', () => {
    expect(matchesShortcut(ev('k', { ctrl: true, shift: true }), 'mod+k', 'other')).toBe(false);
    expect(matchesShortcut(ev('K', { ctrl: true, shift: true }), 'mod+shift+k', 'other')).toBe(true);
  });

  it('falls back to the physical key for Alt combinations', () => {
    expect(matchesShortcut(ev('¡', { alt: true }, 'Digit1'), 'alt+1', 'mac')).toBe(true);
    expect(matchesShortcut(ev('†', { alt: true, ctrl: true }, 'KeyT'), 'ctrl+alt+t', 'mac')).toBe(true);
  });

  it('formats per platform', () => {
    expect(formatShortcut('mod+k', 'mac')).toBe('⌘K');
    expect(formatShortcut('mod+k', 'other')).toBe('Ctrl+K');
    expect(formatShortcut('ctrl+alt+t', 'mac')).toBe('⌃⌥T');
    expect(formatShortcut('mod+enter', 'mac')).toBe('⌘⏎');
    expect(formatShortcut('mod+shift+.', 'other')).toBe('Ctrl+Shift+.');
    expect(formatShortcut('escape', 'other')).toBe('Esc');
  });

  it('detects the platform', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(detectPlatform({ platform: 'Linux x86_64' })).toBe('other');
  });
});

describe('a modifier named on its own', () => {
  it('is the Mac glyph on a Mac and the word everywhere else, as a shortcut shows it', () => {
    expect(['mod', 'ctrl', 'alt', 'shift', 'meta'].map((m) => modifierLabel(m as never, 'mac'))).toEqual([
      '⌘',
      '⌃',
      '⌥',
      '⇧',
      '⌘',
    ]);
    expect(['mod', 'ctrl', 'alt', 'shift', 'meta'].map((m) => modifierLabel(m as never, 'other'))).toEqual([
      'Ctrl',
      'Ctrl',
      'Alt',
      'Shift',
      'Super',
    ]);
    expect(modifierLabel('mod', 'other')).toBe(formatShortcut('mod+x', 'other').split('+')[0]);
  });
});
