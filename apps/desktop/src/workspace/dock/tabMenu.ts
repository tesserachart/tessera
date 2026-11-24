import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { SPLIT_CHART_KEY } from '../../shell/keys.ts';
import { DEFAULT_VIEW, layoutsStore } from '../../state/layouts.ts';
import { splitChart } from '../addChart.ts';
import { contextOf, setChartLink, setSyncInterval } from '../controller.ts';
import { tileDefinition } from '../tiles/registry.ts';
import { isEdgePos, placeOf, type DockArea, type EdgePos } from './edges.ts';
import { LINK_GROUPS, normalizeLink, type LinkGroup } from './links.ts';
import type { Fold } from './header/fit.ts';
import { isMaximised, toggleMaximise } from './maximise.ts';
import { closeTile, floatTile, moveTile, panelKind, toggleEdge } from './open.ts';
import { popOutTile, requestDockBack } from './popouts.ts';
import { setTileParams, tileParams } from './tileSettings.ts';
import { openTileSettings } from './tileSettingsUi.ts';
import { read } from '../../app/store.ts';
import { canFullscreen, toggleFullscreen } from '../../app/host.ts';

export type TabEntry =
  | {
      type: 'item';
      id: string;
      label: string;
      shortcut?: string;
      current?: boolean;
      disabled?: boolean;
      destructive?: boolean;
      run: () => void;
    }
  | { type: 'sub'; id: string; label: string; items: TabEntry[] }
  | { type: 'sep'; id: string };

const EDGE_WORDS: Record<EdgePos, string> = { left: 'left side', right: 'right side', bottom: 'bottom' };

const COLLAPSE_KEYS: Record<EdgePos, string> = { bottom: 'mod+alt+p', left: 'mod+b', right: 'mod+alt+b' };

const AREAS: { area: DockArea; label: string }[] = [
  { area: 'left', label: 'Left side' },
  { area: 'right', label: 'Right side' },
  { area: 'bottom', label: 'Bottom' },
  { area: 'centre', label: 'Centre' },
];

export function linkOf(panel: IDockviewPanel): LinkGroup | null {
  if (panelKind(panel) === 'chart') {
    const p = tileParams<{ layoutId: string; tileId: string }>(panel.api);
    return normalizeLink(read(layoutsStore).layouts[p.layoutId ?? '']?.charts[p.tileId ?? '']?.linkGroup);
  }
  return normalizeLink(tileParams<{ link: string }>(panel.api).link);
}

export function setLink(panel: IDockviewPanel, group: string | null): void {
  if (panelKind(panel) === 'chart') {
    const p = tileParams<{ tileId: string }>(panel.api);
    if (p.tileId) void setChartLink(p.tileId, group);
    return;
  }
  const pinned = group !== null && tileParams<{ instrument: string }>(panel.api).instrument !== undefined;
  setTileParams<{ link: string | undefined; instrument: string | undefined }>(panel.api, {
    link: group ?? undefined,
    ...(pinned ? { instrument: undefined } : {}),
  });
}

function shareInterval(panel: IDockviewPanel): TabEntry[] {
  const layoutId = tileParams<{ layoutId: string }>(panel.api).layoutId ?? '';
  const on = (read(layoutsStore).views[layoutId] ?? DEFAULT_VIEW).syncInterval;
  return [
    { type: 'sep', id: 'sep-share' },
    { type: 'item', id: 'share-interval', label: 'Share interval', current: on, run: () => void setSyncInterval(!on) },
  ];
}

function linkEntries(panel: IDockviewPanel, kind: string): TabEntry[] {
  const link = linkOf(panel);
  return [
    {
      type: 'sub',
      id: 'link',
      label: 'Link',
      items: [
        ...LINK_GROUPS.map((g) => ({
          type: 'item' as const,
          id: `link-${g}`,
          label: g,
          current: link === g,
          run: () => setLink(panel, g),
        })),
        {
          type: 'item' as const,
          id: 'link-none',
          label: 'None',
          current: link === null,
          run: () => setLink(panel, null),
        },
        ...(kind === 'chart' ? shareInterval(panel) : []),
      ],
    },
  ];
}

export type MenuSurface = 'header' | 'context';

function ownEntries(panel: IDockviewPanel): TabEntry[] {
  const def = tileDefinition(panelKind(panel));
  const words = def?.settings?.summary?.(tileParams<Record<string, unknown>>(panel.api)) ?? null;
  return [
    ...(def?.settings
      ? [
          {
            type: 'item' as const,
            id: 'settings',
            label: words ? `Settings… ${words}` : 'Settings…',
            run: () => openTileSettings(panel.id),
          },
        ]
      : []),
    ...(def?.menu?.(panel) ?? []),
  ];
}

function joined(...parts: TabEntry[][]): TabEntry[] {
  return parts
    .filter((p) => p.length > 0)
    .flatMap((p, i) => (i === 0 ? p : [{ type: 'sep' as const, id: `sep-${String(i)}` }, ...p]));
}

export function tabEntries(
  api: DockviewApi,
  panel: IDockviewPanel,
  surface: MenuSurface = 'context',
  folded: ReadonlySet<Fold> = new Set(),
): TabEntry[] {
  const shows = (fold: Fold) => surface === 'context' || folded.has(fold);
  const kind = panelKind(panel);
  const def = tileDefinition(kind);
  const place = placeOf(panel.group);
  const own = ownEntries(panel);
  const link = def?.linkable ? linkEntries(panel, kind) : [];
  const close: TabEntry[] = shows('close')
    ? [{ type: 'item', id: 'close', label: 'Close', run: () => void closeTile(panel.id) }]
    : [];
  const ctx = contextOf(api);
  if (ctx?.popout) {
    const window: TabEntry[] = [
      ...(ctx.windowPanel === panel.id
        ? [{ type: 'item' as const, id: 'dock-back', label: 'Dock back', run: () => requestDockBack(panel.id) }]
        : []),
      ...(canFullscreen()
        ? [{ type: 'item' as const, id: 'fullscreen', label: 'Full screen', run: toggleFullscreen }]
        : []),
    ];
    return joined(own, link, window, close);
  }
  const edge = isEdgePos(place) ? place : null;
  const arrange: TabEntry[] = [
    {
      type: 'sub',
      id: 'move',
      label: 'Move to',
      items: AREAS.map(({ area, label }) => ({
        type: 'item' as const,
        id: `move-${area}`,
        label,
        current: place === area,
        disabled: place === area,
        run: () => moveTile(panel.id, area),
      })),
    },
    place === 'floating'
      ? { type: 'item', id: 'dock', label: 'Dock', run: () => moveTile(panel.id, def?.home ?? 'centre') }
      : { type: 'item', id: 'float', label: 'Float', run: () => floatTile(panel.id) },
    ...(edge
      ? [
          {
            type: 'item' as const,
            id: 'collapse',
            label: `Collapse the ${EDGE_WORDS[edge]}`,
            shortcut: COLLAPSE_KEYS[edge],
            run: () => toggleEdge(edge, 'pointer'),
          },
        ]
      : []),
  ];
  const window: TabEntry[] = [
    ...(place === 'centre' && shows('split')
      ? [
          {
            type: 'item' as const,
            id: 'split',
            label: 'Split chart',
            shortcut: SPLIT_CHART_KEY,
            run: () => void splitChart(panel.group),
          },
        ]
      : []),
    ...(shows('popout')
      ? [{ type: 'item' as const, id: 'popout', label: 'Pop out', run: () => void popOutTile(panel.id) }]
      : []),
    ...(shows('maximise')
      ? [
          {
            type: 'item' as const,
            id: 'maximize',
            label: isMaximised(panel.id) ? 'Restore' : 'Maximise',
            shortcut: 'mod+shift+enter',
            run: () => toggleMaximise(panel.id),
          },
        ]
      : []),
  ];
  return joined(own, [...arrange, ...window], link, close);
}

export function keepMovedFocus(e: Event): void {
  const active = document.activeElement;
  if (active && active !== document.body && !active.closest('.t-menu, [role="menu"]')) e.preventDefault();
}
