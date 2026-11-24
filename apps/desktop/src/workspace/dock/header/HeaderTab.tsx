import { ContextMenu, ContextMenuContent, ContextMenuTrigger, Icon, Tooltip, cx } from '@tessera/ui';
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel, IDockviewPanelHeaderProps } from 'dockview-react';
import {
  createElement,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useLayouts } from '../../../state/layouts.ts';
import { contextOf } from '../../controller.ts';
import { tileDefinition } from '../../tiles/registry.ts';
import { edgeOf, type EdgePos } from '../edges.ts';
import { showLinkColours } from '../links.ts';
import { collapseEdge, expandEdge } from '../motion.ts';
import { closeTile, panelKind } from '../open.ts';
import { TabMenuItems } from '../TabMenu.tsx';
import { keepMovedFocus, linkOf, tabEntries } from '../tabMenu.ts';
import { tileParams, useTileSettingsVersion } from '../tileSettings.ts';
import { panelName } from './panelName.ts';
import { endTabDrag, startTabDrag, startWindowDrag } from './tabDrag.ts';

export type DropSide = 'before' | 'after';

const PRESS_SLOP = 4;
const TIP_SIDE: Record<EdgePos, 'right' | 'left' | 'top'> = { left: 'right', right: 'left', bottom: 'top' };

function headerProps(panel: IDockviewPanel, containerApi: DockviewApi): IDockviewPanelHeaderProps {
  return { api: panel.api, containerApi, params: panel.params ?? {}, tabLocation: 'header' };
}

function useTabLink(panel: IDockviewPanel, containerApi: DockviewApi, linkable: boolean): string | null {
  useTileSettingsVersion();
  const layoutId = contextOf(containerApi)?.layoutId ?? '';
  const chartLinks = useLayouts((s) =>
    Object.values(s.layouts[layoutId]?.charts ?? {})
      .map((c) => c.linkGroup ?? '')
      .join(','),
  );
  if (!linkable) return null;
  const others = containerApi.panels
    .filter((p) => panelKind(p) !== 'chart')
    .map((p) => tileParams<{ link: string }>(p.api).link);
  return showLinkColours([...chartLinks.split(','), ...others]) ? linkOf(panel) : null;
}

function TabLabel({ panel, containerApi }: { panel: IDockviewPanel; containerApi: DockviewApi }) {
  const def = tileDefinition(panelKind(panel));
  if (def?.tab) return createElement(def.tab, headerProps(panel, containerApi));
  return <span className="dock-tab-title">{panelName(panel)}</span>;
}

function TabShell({
  panel,
  group,
  containerApi,
  className,
  role,
  style,
  attrs,
  onPress,
  onKey,
  children,
}: {
  panel: IDockviewPanel;
  group: DockviewGroupPanel;
  containerApi: DockviewApi;
  className: string;
  role: 'tab' | 'button';
  style?: CSSProperties;
  attrs: Record<string, string | number | boolean | undefined>;
  onPress: () => void;
  onKey?: (e: KeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const down = useRef<{ x: number; y: number } | null>(null);
  const ctx = contextOf(containerApi);
  const name = panelName(panel);
  const close = () => closeTile(panel.id);
  const onAux = (e: MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    close();
  };
  return (
    <ContextMenu onOpenChange={setMenu}>
      <ContextMenuTrigger asChild>
        <div
          className={className}
          role={role}
          style={style}
          {...attrs}
          data-kind={panelKind(panel)}
          draggable
          onDragStart={(e) => {
            if (ctx?.popout)
              startWindowDrag(e.dataTransfer, { layoutId: ctx.layoutId, panelId: panel.id, title: name });
            else startTabDrag(e.dataTransfer, containerApi, { groupId: group.id, panelId: panel.id, title: name });
          }}
          onDragEnd={endTabDrag}
          onMouseDown={(e) => {
            // a middle-button press starts the browser's autoscroll unless prevented
            if (e.button === 1) e.preventDefault();
          }}
          onAuxClick={onAux}
          onPointerDown={(e) => {
            down.current = { x: e.clientX, y: e.clientY };
          }}
          onClick={(e) => {
            const d = down.current;
            down.current = null;
            if (e.button !== 0 || e.defaultPrevented) return;
            if (d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > PRESS_SLOP) return;
            onPress();
          }}
          onKeyDown={onKey}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={keepMovedFocus}>
        {menu ? <TabMenuItems entries={tabEntries(containerApi, panel)} as="context" /> : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function HeaderTab({
  panel,
  group,
  containerApi,
  active,
  hidden,
  titleFit,
  closeFolded,
  slot,
  drop,
}: {
  panel: IDockviewPanel;
  group: DockviewGroupPanel;
  containerApi: DockviewApi;
  active: boolean;
  hidden: boolean;
  titleFit: number | null;
  closeFolded: boolean;
  slot: number;
  drop: DropSide | null;
}) {
  const def = tileDefinition(panelKind(panel));
  const link = useTabLink(panel, containerApi, def?.linkable ?? false);
  const name = panelName(panel);
  const fit = titleFit === null ? undefined : ({ '--title-fit': `${String(titleFit)}px` } as CSSProperties);
  return (
    <TabShell
      panel={panel}
      group={group}
      containerApi={containerApi}
      className={cx('dock-tab', active && 'is-active')}
      role="tab"
      style={fit}
      attrs={{
        'data-slot': slot,
        'aria-selected': active,
        tabIndex: active ? 0 : -1,
        'data-fit-tab': '',
        'data-active': active || undefined,
        'data-folded': hidden || undefined,
        'data-squeezed': titleFit !== null || undefined,
        'data-link': link ?? undefined,
        'data-drop': drop ?? undefined,
      }}
      onPress={() => {
        const edge = edgeOf(group);
        if (edge && active) collapseEdge(containerApi, edge, 'pointer');
        else panel.api.setActive();
      }}
      onKey={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        panel.api.setActive();
      }}
    >
      <span className="dock-tab-label" data-fit-title="">
        <TabLabel panel={panel} containerApi={containerApi} />
      </span>
      <Tooltip content="Close">
        <button
          type="button"
          className="dock-tab-x"
          data-fold={active ? 'tab-close' : undefined}
          data-folded={(active && closeFolded) || undefined}
          aria-label={`Close ${name}`}
          tabIndex={-1}
          draggable={false}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            closeTile(panel.id);
          }}
        >
          <Icon name="close" />
        </button>
      </Tooltip>
    </TabShell>
  );
}

export function StripTab({
  panel,
  group,
  containerApi,
  edge,
  slot,
  drop,
}: {
  panel: IDockviewPanel;
  group: DockviewGroupPanel;
  containerApi: DockviewApi;
  edge: EdgePos;
  slot: number;
  drop: DropSide | null;
}) {
  const def = tileDefinition(panelKind(panel));
  const name = panelName(panel);
  const open = (via: 'key' | 'pointer') => {
    if (group.activePanel !== panel) panel.api.setActive();
    expandEdge(containerApi, edge, via);
  };
  const worded = edge === 'bottom';
  return (
    <TabShell
      panel={panel}
      group={group}
      containerApi={containerApi}
      className={cx('dock-tab', 'is-strip', worded && 'is-worded')}
      role="button"
      attrs={{
        tabIndex: 0,
        'aria-expanded': false,
        'data-collapsed': true,
        'data-slot': slot,
        'data-drop': drop ?? undefined,
      }}
      onPress={() => open('pointer')}
      onKey={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open('key');
      }}
    >
      {worded ? (
        <TabLabel panel={panel} containerApi={containerApi} />
      ) : (
        <Tooltip content={name} shortcut={def?.shortcut} side={TIP_SIDE[edge]}>
          <span className="dock-tab-icon" aria-label={name}>
            {def ? <Icon name={def.icon} /> : null}
            {def?.badge ? createElement(def.badge, headerProps(panel, containerApi)) : null}
          </span>
        </Tooltip>
      )}
    </TabShell>
  );
}
