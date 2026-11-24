import { describe, expect, it } from 'vitest';

import { firstOpenText, MAC_FIRST_OPEN, WINDOWS_FIRST_OPEN } from '../src/firstOpen.ts';

describe('firstOpenText', () => {
  it('numbers the steps between the intro and the other way, when there is one', () => {
    expect(firstOpenText({ intro: 'Intro.', steps: ['One.', 'Two.'], alternative: 'Other.' })).toBe(
      'Intro.\n1. One.\n2. Two.\nOther.',
    );
    expect(firstOpenText({ intro: 'Intro.', steps: ['One.'] })).toBe('Intro.\n1. One.');
  });

  it('walks the Mac through Privacy & Security to Open Anyway', () => {
    const text = firstOpenText(MAC_FIRST_OPEN);
    expect(text).toContain('System Settings › Privacy & Security');
    expect(text).toContain('Open Anyway');
    expect(text).toContain('Control-click Tessera in Applications, choose Open');
  });

  it('walks Windows through SmartScreen to Run anyway', () => {
    const text = firstOpenText(WINDOWS_FIRST_OPEN);
    expect(text).toContain('More info, then Run anyway');
  });
});
