import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createDockview, type DockviewApi, type IDockviewHeaderActionsProps } from 'dockview-react';
import { afterEach, describe, expect, it } from 'vitest';
import { edgeBesideSash, installCollapsibleEdges, planCollapseDrag } from '../src/workspace/dock/collapse.ts';
import { PanelHeader } from '../src/workspace/dock/header/PanelHeader.tsx';
import { EDGE_SPEC, EDGE_STRIP, edgeGroup, ensureEdges, type EdgePos } from '../src/workspace/dock/edges.ts';
import { tesseraDockTheme } from '../src/workspace/dockTheme.ts';

function desk(): { api: DockviewApi; host: HTMLElement } {
  const host = document.createElement('div');
  host.style.width = '1600px';
  host.style.height = '900px';
  document.body.appendChild(host);
  const api = createDockview(host, {
    theme: { ...tesseraDockTheme, edgeGroupCollapsedSize: EDGE_STRIP },
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
  api.layout(1600, 900);
  api.addPanel({ id: 'centre', component: 'centre', title: 'Chart' });
  ensureEdges(api);
  api.addPanel({
    id: 'positions',
    component: 'positions',
    title: 'Positions',
    position: { referenceGroup: edgeGroup(api, 'bottom')! },
  });
  api.addPanel({
    id: 'accounts',
    component: 'accounts',
    title: 'Accounts',
    position: { referenceGroup: edgeGroup(api, 'bottom')! },
  });
  api.addPanel({
    id: 'trade',
    component: 'trade',
    title: 'Trade',
    position: { referenceGroup: edgeGroup(api, 'right')! },
  });
  api.addPanel({
    id: 'notes',
    component: 'notes',
    title: 'Notes',
    position: { referenceGroup: edgeGroup(api, 'left')! },
  });
  wrapRightInSideColumn(api);
  installCollapsibleEdges(api, host);
  api.layout(1600, 900);
  return { api, host };
}

function wrapRightInSideColumn(api: DockviewApi): void {
  const upper = edgeGroup(api, 'right');
  const host = upper?.element.parentElement;
  if (!upper || !host) return;
  const column = host.ownerDocument.createElement('div');
  column.className = 'dock-side';
  host.insertBefore(column, upper.element);
  column.append(upper.element);
}

function sashOf(host: HTMLElement, api: DockviewApi, pos: EdgePos): HTMLElement {
  const sash = [...host.querySelectorAll('.dv-sash')].find((el) => edgeBesideSash(api, el) === pos);
  expect(sash, `sash for ${pos}`).toBeTruthy();
  return sash as HTMLElement;
}

function sizeOf(api: DockviewApi, pos: EdgePos): number {
  const g = api.getEdgeGroup(pos)!;
  return pos === 'bottom' ? g.height : g.width;
}

function setOpen(api: DockviewApi, pos: EdgePos, size: number): void {
  const g = api.getEdgeGroup(pos)!;
  if (g.isCollapsed()) g.expand();
  g.setSize(pos === 'bottom' ? { height: size } : { width: size });
}

function collapseByDrag(host: HTMLElement, api: DockviewApi, pos: EdgePos, last: number): void {
  setOpen(api, pos, last);
  const sash = sashOf(host, api, pos);
  fireEvent.pointerDown(sash, { button: 0, clientX: 200, clientY: 200 });
  setOpen(api, pos, EDGE_SPEC[pos].min);
  fireEvent.pointerUp(document, { button: 0, clientX: 200, clientY: 400 });
}

function sameOpen(api: DockviewApi, pos: EdgePos, open: number): void {
  expect(Math.abs(sizeOf(api, pos) - open)).toBeLessThan(2);
}

function openByDrag(host: HTMLElement, api: DockviewApi, pos: EdgePos): void {
  const sash = sashOf(host, api, pos);
  fireEvent.pointerDown(sash, { button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerUp(document, { button: 0, clientX: 200, clientY: 210 });
}

function mountTab(api: DockviewApi, id: string): HTMLElement {
  const panel = api.getPanel(id)!;
  const props = {
    group: panel.group,
    containerApi: api,
    api: panel.group.api,
  } as unknown as IDockviewHeaderActionsProps;
  const { container } = render(<PanelHeader {...props} />);
  const tab = container.querySelector<HTMLElement>(`.dock-tab[data-kind="${panel.api.component}"]`);
  expect(tab, `tab ${id}`).toBeTruthy();
  return tab!;
}

function press(el: HTMLElement): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(el, { button: 0, clientX: 11, clientY: 10 });
  fireEvent.click(el, { button: 0, clientX: 11, clientY: 10 });
}

function stripName(strip: HTMLElement): string {
  return strip.querySelector('.dock-tab-icon')?.getAttribute('aria-label') ?? strip.textContent;
}

function treeSize(tree: unknown, pos: EdgePos): number {
  const edges = (tree as { edgeGroups?: Record<string, { size?: number }> }).edgeGroups;
  return edges?.[pos]?.size ?? 0;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('a collapsible pane’s last size', () => {
  it('stays collapsed until the drag leaves the strip, then opens at the larger of the last size and the drag', () => {
    expect(
      planCollapseDrag({ collapsed: true, lastOpen: 240, proposed: EDGE_STRIP, strip: EDGE_STRIP, minOpen: 120 }),
    ).toEqual({ collapsed: true, lastOpen: 240 });
    expect(
      planCollapseDrag({ collapsed: true, lastOpen: 240, proposed: 200, strip: EDGE_STRIP, minOpen: 120 }),
    ).toEqual({ collapsed: false, lastOpen: 240 });
    expect(
      planCollapseDrag({ collapsed: true, lastOpen: 240, proposed: 300, strip: EDGE_STRIP, minOpen: 120 }),
    ).toEqual({ collapsed: false, lastOpen: 300 });
  });

  it('collapses when an open drag meets the least size, and keeps the size from before the drag', () => {
    expect(
      planCollapseDrag({ collapsed: false, lastOpen: 240, proposed: 120, strip: EDGE_STRIP, minOpen: 120 }),
    ).toEqual({ collapsed: true, lastOpen: 240 });
    expect(
      planCollapseDrag({ collapsed: false, lastOpen: 240, proposed: 180, strip: EDGE_STRIP, minOpen: 120 }),
    ).toEqual({ collapsed: false, lastOpen: 180 });
  });
});

describe('each collapsible desk edge', () => {
  const cases: { pos: EdgePos; id: string; title: string; last: number }[] = [
    { pos: 'bottom', id: 'positions', title: 'Positions', last: 240 },
    { pos: 'right', id: 'trade', title: 'Trade', last: 400 },
    { pos: 'left', id: 'notes', title: 'Notes', last: 256 },
  ];

  for (const { pos, id, title, last } of cases) {
    it(`${pos}: a full collapse leaves a named tab, and click or drag opens it at the last size`, () => {
      const { api, host } = desk();
      setOpen(api, pos, last);
      const open = sizeOf(api, pos);
      expect(open).toBeGreaterThan(EDGE_SPEC[pos].min);

      collapseByDrag(host, api, pos, last);
      const g = api.getEdgeGroup(pos)!;
      expect(g.isCollapsed()).toBe(true);
      const strip = mountTab(api, id);
      expect(stripName(strip)).toBe(title);
      expect(strip.classList.contains('is-strip')).toBe(true);
      expect(strip.getAttribute('role')).toBe('button');
      expect(strip.getAttribute('aria-expanded')).toBe('false');

      act(() => press(strip));
      expect(g.isCollapsed()).toBe(false);
      sameOpen(api, pos, open);

      collapseByDrag(host, api, pos, last);
      expect(g.isCollapsed()).toBe(true);
      openByDrag(host, api, pos);
      expect(g.isCollapsed()).toBe(false);
      sameOpen(api, pos, open);

      collapseByDrag(host, api, pos, last);
      expect(g.isCollapsed()).toBe(true);
      const sash = sashOf(host, api, pos);
      fireEvent.pointerDown(sash, { button: 0, clientX: 200, clientY: 200 });
      const opened = sizeOf(api, pos);
      setOpen(api, pos, EDGE_SPEC[pos].min);
      fireEvent.pointerUp(document, { button: 0, clientX: 200, clientY: 200 });
      expect(g.isCollapsed()).toBe(false);
      sameOpen(api, pos, opened);
    });

    it(`${pos}: the last size and the collapsed strip survive a reload`, async () => {
      const first = desk();
      setOpen(first.api, pos, last);
      const open = sizeOf(first.api, pos);
      let saved = 0;
      first.api.getEdgeGroup(pos)!.onDidCollapsedChange(() => {
        queueMicrotask(() => {
          saved = treeSize(first.api.toJSON(), pos);
        });
      });
      collapseByDrag(first.host, first.api, pos, last);
      await Promise.resolve();
      expect(Math.abs(saved - open)).toBeLessThan(2);
      const json = first.api.toJSON();
      expect(Math.abs(treeSize(json, pos) - open)).toBeLessThan(2);
      first.host.remove();

      const { api, host } = desk();
      api.fromJSON(json);
      api.layout(1600, 900);
      const g = api.getEdgeGroup(pos)!;
      expect(g.isCollapsed()).toBe(true);
      const strip = mountTab(api, id);
      expect(stripName(strip)).toBe(title);
      expect(strip.classList.contains('is-strip')).toBe(true);
      openByDrag(host, api, pos);
      expect(g.isCollapsed()).toBe(false);
      sameOpen(api, pos, open);
    });
  }
});
