import { Icon, Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from '@tessera/ui';
import type { DockviewApi, DockviewGroupPanel, IDockviewHeaderActionsProps, IDockviewPanel } from 'dockview-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useStageView } from '../../../state/layouts.ts';
import { contextOf } from '../../controller.ts';
import { tileDefinition } from '../../tiles/registry.ts';
import { dockRevision, placeOf, subscribeDock, type EdgePos, type PanelPlace } from '../edges.ts';
import { panelKind } from '../open.ts';
import { LibraryMenu } from '../PanelsLibrary.tsx';
import { keepMovedFocus } from '../tabMenu.ts';
import { useEdgeCollapsed } from '../useEdgeCollapsed.ts';
import type { Fold } from './fit.ts';
import { HeaderFolds } from './folds.ts';
import { HeaderEnd } from './HeaderEnd.tsx';
import { HeaderTab, StripTab, type DropSide } from './HeaderTab.tsx';
import { panelName } from './panelName.ts';
import { dropOnTabs, insertionIndex, tabDropOf } from './tabDrag.ts';
import { useHeaderFit } from './useHeaderFit.ts';

const ADD_TO: Record<PanelPlace, string> = {
  left: 'Add to the left side',
  right: 'Add to the right side',
  bottom: 'Add to the bottom',
  centre: 'Add to this group',
  floating: 'Add to this float',
  popout: 'Add to this window',
};

export const ADD_TO_DESK = 'Add to the desk';

const NOTHING_FOLDED: ReadonlySet<Fold> = new Set();

function useGroupPanels(group: DockviewGroupPanel, containerApi: DockviewApi): readonly IDockviewPanel[] {
  const subscribe = useCallback(
    (changed: () => void) => {
      const titles = new Map<string, { dispose: () => void }>();
      const watchTitles = () => {
        for (const [id, sub] of titles)
          if (!group.panels.some((p) => p.id === id)) {
            sub.dispose();
            titles.delete(id);
          }
        for (const p of group.panels) if (!titles.has(p.id)) titles.set(p.id, p.api.onDidTitleChange(changed));
      };
      const moved = () => {
        watchTitles();
        changed();
      };
      watchTitles();
      const subs = [
        group.api.onDidActivePanelChange(changed),
        containerApi.onDidAddPanel(moved),
        containerApi.onDidRemovePanel(moved),
        containerApi.onDidMovePanel(moved),
        containerApi.onDidLayoutFromJSON(moved),
      ];
      const offDock = subscribeDock(changed);
      return () => {
        offDock();
        for (const s of subs) s.dispose();
        for (const s of titles.values()) s.dispose();
      };
    },
    [group, containerApi],
  );
  const key = useSyncExternalStore(subscribe, () =>
    [dockRevision(), group.activePanel?.id ?? '', ...group.panels.map((p) => `${p.id}:${p.title ?? ''}`)].join('|'),
  );
  const [panels, setPanels] = useState<{ key: string; list: readonly IDockviewPanel[] }>(() => ({
    key,
    list: [...group.panels],
  }));
  if (panels.key !== key) setPanels({ key, list: [...group.panels] });
  return panels.list;
}

function slotUnder(e: DragEvent, vertical: boolean): number | null {
  const tab = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-slot]') : null;
  if (!tab) return null;
  const r = tab.getBoundingClientRect();
  const after = vertical ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
  return insertionIndex(Number(tab.dataset.slot), after);
}

function useTabDrops(containerApi: DockviewApi, group: DockviewGroupPanel, vertical: boolean) {
  const [dropAt, setDropAt] = useState<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const doc = el.ownerDocument;
    const accepted = (e: DragEvent) => {
      const at = slotUnder(e, vertical);
      if (at === null || !tabDropOf(containerApi, e.dataTransfer)) return null;
      e.preventDefault();
      e.stopPropagation();
      return at;
    };
    const over = (e: DragEvent) => {
      const at = accepted(e);
      if (at === null) return;
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      setDropAt(at);
    };
    const drop = (e: DragEvent) => {
      const at = accepted(e);
      if (at === null) return;
      setDropAt(null);
      dropOnTabs(containerApi, group, at, e.dataTransfer);
    };
    const leave = (e: DragEvent) => {
      if (!(e.relatedTarget instanceof Node) || !el.contains(e.relatedTarget)) setDropAt(null);
    };
    const done = () => setDropAt(null);
    el.addEventListener('dragenter', over);
    el.addEventListener('dragover', over);
    el.addEventListener('drop', drop);
    el.addEventListener('dragleave', leave);
    doc.addEventListener('dragend', done, true);
    doc.defaultView?.addEventListener('blur', done);
    return () => {
      el.removeEventListener('dragenter', over);
      el.removeEventListener('dragover', over);
      el.removeEventListener('drop', drop);
      el.removeEventListener('dragleave', leave);
      doc.removeEventListener('dragend', done, true);
      doc.defaultView?.removeEventListener('blur', done);
    };
  }, [containerApi, group, vertical]);
  return [strip, dropAt] as const;
}

function sideAt(dropAt: number | null, slot: number): DropSide | null {
  return dropAt === slot ? 'before' : dropAt === slot + 1 ? 'after' : null;
}

function HeaderStrip({
  group,
  containerApi,
  panels,
  edge,
}: {
  group: DockviewGroupPanel;
  containerApi: DockviewApi;
  panels: readonly IDockviewPanel[];
  edge: EdgePos;
}) {
  const [strip, dropAt] = useTabDrops(containerApi, group, edge !== 'bottom');
  return (
    <div
      ref={strip}
      className="panel-header is-strip"
      data-edge={edge}
      role="group"
      aria-label={`${edge === 'bottom' ? 'Bottom' : edge === 'left' ? 'Left side' : 'Right side'} panels`}
    >
      {panels.map((p, i) => (
        <StripTab
          key={p.id}
          panel={p}
          group={group}
          containerApi={containerApi}
          edge={edge}
          slot={i}
          drop={sideAt(dropAt, i)}
        />
      ))}
    </div>
  );
}

function MoreTabs({ hidden, folded }: { hidden: readonly IDockviewPanel[]; folded: boolean }) {
  return (
    <Menu>
      <Tooltip content="More tabs">
        <MenuTrigger asChild>
          <button
            type="button"
            className="panel-header-more"
            data-fit-more=""
            data-folded={folded || undefined}
            tabIndex={folded ? -1 : undefined}
            aria-label={`${String(hidden.length)} more tabs`}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {String(Math.max(1, hidden.length))} more
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="start" onCloseAutoFocus={keepMovedFocus}>
        {hidden.map((p) => {
          const def = tileDefinition(panelKind(p));
          return (
            <MenuItem key={p.id} {...(def ? { icon: def.icon } : {})} onSelect={() => p.api.setActive()}>
              {panelName(p)}
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

function AddHere({ into, folded }: { into: DockviewGroupPanel | 'centre'; folded: boolean }) {
  return (
    <LibraryMenu
      into={into}
      label={into === 'centre' ? ADD_TO_DESK : ADD_TO[placeOf(into)]}
      tip="Add a panel here"
      trigger={
        <button
          type="button"
          className="dock-act dock-new-tab"
          data-fold="add"
          data-folded={folded || undefined}
          tabIndex={folded ? -1 : undefined}
          aria-label="Add a panel here"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Icon name="plus" />
        </button>
      }
    />
  );
}

function HeaderEndSlot({ end }: { end: ReactNode }) {
  return end ? (
    <div className="panel-header-end" data-fit-fixed="">
      {end}
    </div>
  ) : null;
}

function EmptyHeaderRow({ into, end }: { into: DockviewGroupPanel | 'centre' | null; end?: ReactNode }) {
  return (
    <div className="panel-header">
      {into ? <AddHere into={into} folded={false} /> : null}
      <div className="panel-header-room" />
      <HeaderEndSlot end={end} />
    </div>
  );
}

export function DeskHeader() {
  return (
    <div className="dv-tabs-and-actions-container">
      <div className="dv-void-container" />
      <div className="dv-right-actions-container">
        <EmptyHeaderRow into="centre" />
      </div>
    </div>
  );
}

function HeaderRow({
  group,
  containerApi,
  panels,
  active,
  end,
}: {
  group: DockviewGroupPanel;
  containerApi: DockviewApi;
  panels: readonly IDockviewPanel[];
  active: IDockviewPanel;
  end: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const fit = useHeaderFit(root, `${active.id}|${panels.map((p) => p.id).join(',')}`);
  const [strip, dropAt] = useTabDrops(containerApi, group, false);
  const away = contextOf(containerApi)?.popout === true;
  const folded = fit?.folded ?? NOTHING_FOLDED;
  const shown = (i: number) => !fit || fit.shown.has(i);
  const hidden = panels.filter((_, i) => !shown(i));
  const title = tileDefinition(panelKind(active))?.title ?? 'Panel';
  return (
    <HeaderFolds.Provider value={folded}>
      <div ref={root} className="panel-header">
        <div ref={strip} className="panel-header-tabs" role="tablist" aria-label={`${title} tabs`}>
          {panels.map((p, i) => (
            <HeaderTab
              key={p.id}
              panel={p}
              group={group}
              containerApi={containerApi}
              active={p === active}
              hidden={!shown(i)}
              titleFit={p === active ? (fit?.titleFit ?? null) : null}
              closeFolded={folded.has('tab-close')}
              slot={i}
              drop={sideAt(dropAt, i)}
            />
          ))}
        </div>
        <MoreTabs hidden={hidden} folded={hidden.length === 0} />
        {away ? null : <AddHere into={group} folded={folded.has('add')} />}
        <div className="panel-header-room" />
        <HeaderEnd containerApi={containerApi} group={group} panel={active} folded={folded} />
        <HeaderEndSlot end={end} />
      </div>
    </HeaderFolds.Provider>
  );
}

export function PanelHeader({ group, containerApi, end }: IDockviewHeaderActionsProps & { end?: ReactNode }) {
  const { edge, collapsed } = useEdgeCollapsed(group, containerApi);
  useStageView(contextOf(containerApi)?.layoutId ?? null);
  const panels = useGroupPanels(group, containerApi);
  const active = group.activePanel ?? panels[0];
  if (collapsed && edge) return <HeaderStrip group={group} containerApi={containerApi} panels={panels} edge={edge} />;
  if (!active) {
    const away = contextOf(containerApi)?.popout === true;
    return <EmptyHeaderRow into={away ? null : group} end={end} />;
  }
  return <HeaderRow group={group} containerApi={containerApi} panels={panels} active={active} end={end} />;
}

export function NoTab() {
  return null;
}
