import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import {
  createDockview,
  LocalSelectionTransfer,
  PanelTransfer,
  type DockviewApi,
  type DockviewGroupPanel,
  type IDockviewHeaderActionsProps,
} from 'dockview-react';
import { afterEach, describe, expect, it } from 'vitest';
import { edgeGroup, ensureEdges } from '../src/workspace/dock/edges.ts';
import { clearDropOverlays, installDragSweep } from '../src/workspace/dock/header/dragSweep.ts';
import { PanelHeader } from '../src/workspace/dock/header/PanelHeader.tsx';
import { dropOnTabs, endTabDrag, startTabDrag } from '../src/workspace/dock/header/tabDrag.ts';

function desk(): DockviewApi {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const api = createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
  api.addPanel({ id: 'centre', component: 'centre', title: 'Centre' });
  return api;
}

function deskWithNotesOnTheLeft(): DockviewApi {
  const api = desk();
  ensureEdges(api, { collapsed: { left: true } });
  api.addPanel({
    id: 'notes',
    component: 'notes',
    title: 'Notes',
    position: { referenceGroup: edgeGroup(api, 'left')! },
  });
  return api;
}

function renderHeader(api: DockviewApi, group: DockviewGroupPanel) {
  const props = { group, containerApi: api, api: group.api } as unknown as IDockviewHeaderActionsProps;
  const { container } = render(
    <TooltipProvider>
      <PanelHeader {...props} />
    </TooltipProvider>,
  );
  return {
    tab: (kind: string) => container.querySelector<HTMLElement>(`.dock-tab[data-kind="${kind}"]`)!,
    tabs: () => [...container.querySelectorAll<HTMLElement>('.dock-tab')].map((t) => t.dataset.kind),
    header: () => container.querySelector<HTMLElement>('.panel-header')!,
  };
}

function press(el: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(el, { button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerUp(el, { button: 0, clientX: to.x, clientY: to.y });
  fireEvent.click(el, { button: 0, clientX: to.x, clientY: to.y });
}

afterEach(() => {
  cleanup();
  endTabDrag();
  document.body.innerHTML = '';
});

describe('a panel header', () => {
  it('is a strip of named icons while its edge is collapsed, and a row of titled tabs once it opens or a title changes', () => {
    const api = deskWithNotesOnTheLeft();
    const panel = api.getPanel('notes')!;
    const h = renderHeader(api, edgeGroup(api, 'left')!);
    expect(h.header().classList.contains('is-strip')).toBe(true);
    expect(h.tab('notes').getAttribute('role')).toBe('button');
    expect(h.tab('notes').querySelector('.dock-tab-icon')?.getAttribute('aria-label')).toBe('Notes');
    act(() => api.getEdgeGroup('left')!.expand());
    expect(h.header().classList.contains('is-strip')).toBe(false);
    expect(h.tab('notes').getAttribute('role')).toBe('tab');
    expect(h.tab('notes').querySelector('.dock-tab-title')?.textContent).toBe('Notes');
    act(() => panel.api.setTitle('Notes | today'));
    expect(h.tab('notes').querySelector('.dock-tab-title')?.textContent).toBe('Notes | today');
    act(() => api.getEdgeGroup('left')!.collapse());
    expect(h.tab('notes').querySelector('.dock-tab-icon')?.getAttribute('aria-label')).toBe('Notes | today');
  });

  it('folds its open edge away on a press of the tab it already shows', async () => {
    const api = deskWithNotesOnTheLeft();
    act(() => api.getEdgeGroup('left')!.expand());
    const h = renderHeader(api, edgeGroup(api, 'left')!);
    act(() => press(h.tab('notes'), { x: 10, y: 10 }, { x: 10, y: 10 }));
    await waitFor(() => expect(api.getEdgeGroup('left')!.isCollapsed()).toBe(true));
  });

  it('opens its collapsed edge on a press, but not on a press that drags', () => {
    const api = deskWithNotesOnTheLeft();
    const h = renderHeader(api, edgeGroup(api, 'left')!);
    press(h.tab('notes'), { x: 10, y: 10 }, { x: 30, y: 10 });
    expect(api.getEdgeGroup('left')!.isCollapsed()).toBe(true);
    act(() => press(h.tab('notes'), { x: 10, y: 10 }, { x: 12, y: 11 }));
    expect(api.getEdgeGroup('left')!.isCollapsed()).toBe(false);
  });

  it('opens its edge on the tab pressed when another tab of the strip was showing', () => {
    const api = deskWithNotesOnTheLeft();
    api.addPanel({
      id: 'todo',
      component: 'todo',
      title: 'To do',
      position: { referenceGroup: edgeGroup(api, 'left')! },
    });
    expect(edgeGroup(api, 'left')!.activePanel?.id).toBe('todo');
    const h = renderHeader(api, edgeGroup(api, 'left')!);
    act(() => press(h.tab('notes'), { x: 10, y: 10 }, { x: 11, y: 10 }));
    expect(api.getEdgeGroup('left')!.isCollapsed()).toBe(false);
    expect(edgeGroup(api, 'left')!.activePanel?.id).toBe('notes');
  });

  it('shows the group’s tabs in order, the active one selected, and a press shows another', () => {
    const api = desk();
    const group = api.getPanel('centre')!.group;
    api.addPanel({ id: 'tape', component: 'tape', title: 'T&S', position: { referenceGroup: group } });
    const h = renderHeader(api, group);
    expect(h.tabs()).toEqual(['centre', 'tape']);
    expect(h.tab('tape').getAttribute('aria-selected')).toBe('true');
    act(() => press(h.tab('centre'), { x: 5, y: 5 }, { x: 5, y: 5 }));
    expect(group.activePanel?.id).toBe('centre');
    expect(h.tab('centre').getAttribute('aria-selected')).toBe('true');
  });

  it('is a header with its add button in a group that holds no panel', () => {
    const api = desk();
    const group = api.addGroup({ referencePanel: 'centre', direction: 'right' });
    expect(group.panels).toHaveLength(0);
    const h = renderHeader(api, group);
    expect(h.tabs()).toEqual([]);
    expect(h.header().querySelector('[aria-label="Add a panel here"]')).not.toBeNull();
  });
});

describe('a tab dropped on a header', () => {
  function threeTabs() {
    const api = desk();
    const group = api.getPanel('centre')!.group;
    for (const id of ['dom', 'tape'])
      api.addPanel({ id, component: id, title: id, position: { referenceGroup: group } });
    return { api, group };
  }
  const drag = (api: DockviewApi, group: DockviewGroupPanel, panelId: string) =>
    startTabDrag(null, api, { groupId: group.id, panelId, title: panelId });

  it('lands where it is let go among the tabs, and leaves nothing of the drag behind', () => {
    const { api, group } = threeTabs();
    const h = renderHeader(api, group);
    drag(api, group, 'tape');
    act(() => void dropOnTabs(api, group, 0, null));
    expect(h.tabs()).toEqual(['tape', 'centre', 'dom']);
    expect(LocalSelectionTransfer.getInstance<PanelTransfer>().hasData(PanelTransfer.prototype)).toBe(false);
    drag(api, group, 'tape');
    act(() => void dropOnTabs(api, group, 3, null));
    expect(h.tabs()).toEqual(['centre', 'dom', 'tape']);
  });

  it('moves a tab from another group in at the place it is dropped', () => {
    const { api, group } = threeTabs();
    api.addPanel({ id: 'trade', component: 'trade', title: 'Trade', position: { direction: 'right' } });
    const from = api.getPanel('trade')!.group;
    drag(api, from, 'trade');
    act(() => void dropOnTabs(api, group, 1, null));
    expect(group.panels.map((p) => p.id)).toEqual(['centre', 'trade', 'dom', 'tape']);
  });

  it('takes no drop it does not carry', () => {
    const { api, group } = threeTabs();
    expect(dropOnTabs(api, group, 0, null)).toBe(false);
    expect(group.panels.map((p) => p.id)).toEqual(['centre', 'dom', 'tape']);
  });
});

describe('the drag sweep', () => {
  function leftOverlay() {
    const target = document.createElement('div');
    const zone = document.createElement('div');
    zone.className = 'dv-drop-target-dropzone';
    target.appendChild(zone);
    document.body.appendChild(target);
    target.addEventListener('dragend', () => zone.remove());
    return zone;
  }

  it('hands an overlay a drag left behind to the target that drew it, so it takes it down', () => {
    const zone = leftOverlay();
    expect(clearDropOverlays(document)).toBe(1);
    expect(zone.isConnected).toBe(false);
  });

  it('clears overlays once the pointer moves again or the window loses focus', () => {
    const stop = installDragSweep(document);
    const zone = leftOverlay();
    fireEvent.mouseMove(document.body);
    expect(zone.isConnected).toBe(false);
    stop();
  });
});
