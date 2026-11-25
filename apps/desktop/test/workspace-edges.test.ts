import { createDockview, type DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMomentary, isMomentary, markMomentary, momentaryOpen } from '../src/workspace/dock/edges.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

function dock(): DockviewApi {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
}

describe('an edge collapsed for now, with three workspaces mounted', () => {
  it('belongs to its own workspace: another loading or saving never reads or clears it', () => {
    const shown = dock();
    const kept = dock();
    markMomentary(shown, 'left', true);
    clearMomentary(kept);
    expect(isMomentary(shown, 'left')).toBe(true);
    expect(momentaryOpen(shown)).toEqual({ left: false });
    expect(isMomentary(kept, 'left')).toBe(false);
    expect(momentaryOpen(kept)).toEqual({});
  });
});
