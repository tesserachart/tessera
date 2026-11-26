import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DIALOG_OPEN, Dialog, DialogContent, useRootFlag } from '../src/index.ts';

afterEach(() => {
  cleanup();
});

const flagged = (attribute: string) => document.documentElement.hasAttribute(attribute);

function Flag({ on }: { on: boolean }) {
  useRootFlag('data-test-flag', on);
  return null;
}

describe('a page-wide flag', () => {
  it('stays on while any holder holds it', () => {
    const a = render(<Flag on />);
    const b = render(<Flag on />);
    expect(flagged('data-test-flag')).toBe(true);
    a.unmount();
    expect(flagged('data-test-flag')).toBe(true);
    b.unmount();
    expect(flagged('data-test-flag')).toBe(false);
  });

  it('marks the page while a dialog is open, and not once it closes', () => {
    const dialog = (open: boolean) => (
      <Dialog open={open}>
        <DialogContent title="Settings">body</DialogContent>
      </Dialog>
    );
    const view = render(dialog(true));
    expect(flagged(DIALOG_OPEN)).toBe(true);
    act(() => view.rerender(dialog(false)));
    expect(flagged(DIALOG_OPEN)).toBe(false);
  });
});
