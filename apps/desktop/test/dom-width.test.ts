import { createDockview, type DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it } from 'vitest';
import { LADDER_MIN_WIDTH } from '../src/orderflow/dom/ladderModel.ts';
import { GROUP_MIN_WIDTH, installMinimums } from '../src/workspace/dock/minimums.ts';
import { tesseraDockTheme } from '../src/workspace/dockTheme.ts';

const minWidthOf = (kind: string) => (kind === 'dom' ? LADDER_MIN_WIDTH : 0);
const settle = () => new Promise<void>((r) => queueMicrotask(r));

function desk(): DockviewApi {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const api = createDockview(host, {
    theme: tesseraDockTheme,
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
  api.layout(1200, 700);
  api.addPanel({ id: 'nq', component: 'chart', title: 'NQ Z6' });
  api.addPanel({
    id: 'es',
    component: 'chart',
    title: 'ES Z6',
    position: { referencePanel: 'nq', direction: 'right' },
  });
  api.addPanel({ id: 'dom', component: 'dom', title: 'DOM', position: { referencePanel: 'es', direction: 'right' } });
  api.getPanel('dom')!.group.api.setSize({ width: 264 });
  return api;
}

const width = (api: DockviewApi, id: string) => api.getPanel(id)!.group.width;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a DOM column on a narrowing desk', () => {
  it('keeps the width Bid, Price and Ask need, and the charts give up the rest', async () => {
    const api = desk();
    const off = installMinimums(api, minWidthOf);
    await settle();
    const charts = () => width(api, 'nq') + width(api, 'es');
    api.layout(1000, 600);
    const [wide, wideCharts] = [width(api, 'dom'), charts()];
    api.layout(816, 600);
    expect(width(api, 'dom')).toBeGreaterThan(LADDER_MIN_WIDTH - 1);
    api.layout(500, 600);
    expect(width(api, 'dom')).toBeGreaterThan(LADDER_MIN_WIDTH - 1);
    expect(wideCharts - charts()).toBeCloseTo(500 - (wide - width(api, 'dom')), 0);
    off();
  });

  it('holds the minimum only while the DOM is the group’s shown tile', async () => {
    const api = desk();
    const off = installMinimums(api, minWidthOf);
    await settle();
    const group = api.getPanel('dom')!.group;
    expect(group.minimumWidth).toBe(LADDER_MIN_WIDTH);
    api.addPanel({ id: 'tape', component: 'tape', title: 'T&S', position: { referenceGroup: group } });
    await settle();
    expect(group.activePanel?.id).toBe('tape');
    expect(group.minimumWidth).toBe(GROUP_MIN_WIDTH);
    api.getPanel('dom')!.api.setActive();
    await settle();
    expect(group.minimumWidth).toBe(LADDER_MIN_WIDTH);
    expect(api.getPanel('nq')!.group.minimumWidth).toBe(GROUP_MIN_WIDTH);
    off();
  });
});
