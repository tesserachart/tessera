import { describe, expect, it } from 'vitest';
import { isPrimaryPress, isSecondaryPress } from '../src/shell/secondaryPress.ts';

const press = (type: string, button: number, buttons: number, ctrlKey = false) => ({ type, button, buttons, ctrlKey });

describe('which press is a secondary click', () => {
  it.each([
    ['a right press', press('pointerdown', 2, 2), true, true, false, false],
    ['a right mouse press', press('mousedown', 2, 2), true, true, false, false],
    ['a left press', press('pointerdown', 0, 1), false, false, true, true],
    ['a Control-click', press('pointerdown', 0, 1, true), true, false, false, true],
    ['a right press while the left is held', press('pointermove', 2, 3), true, true, false, false],
    ['a right release while the left is held', press('pointermove', 2, 1), false, false, false, false],
    ['a plain move', press('pointermove', -1, 1), false, false, false, false],
    ['the context menu', press('contextmenu', 2, 0), true, true, false, false],
    ['a right release', press('pointerup', 2, 0), false, false, false, false],
  ])(
    '%s: secondary on a Mac %s, elsewhere %s; primary on a Mac %s, elsewhere %s',
    (_, e, macSecondary, otherSecondary, macPrimary, otherPrimary) => {
      expect(isSecondaryPress(e, 'mac')).toBe(macSecondary);
      expect(isSecondaryPress(e, 'other')).toBe(otherSecondary);
      expect(isPrimaryPress(e, 'mac')).toBe(macPrimary);
      expect(isPrimaryPress(e, 'other')).toBe(otherPrimary);
    },
  );
});
