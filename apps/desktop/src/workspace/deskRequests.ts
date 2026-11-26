import type { JsonValue } from '@tessera/protocol';
import { newChartSetup } from '../chart/templates/model.ts';
import { templatesStore } from '../chart/templates/store.ts';
import { DEFAULT_INSTRUMENT, newWorkspaceId, preferredInstrument } from '../frame/workspaces.ts';
import { readSetting } from '../state/runtimeSettings.ts';
import { LAYOUT_PRESETS, STORY_IDS, type LayoutPreset, type StoryId } from '../state/layouts.ts';
import { setWorkspace } from '../state/ui.ts';
import { showArea } from '../areas/store.ts';
import {
  activeChartTarget,
  applyLayoutPreset,
  resetWorkspaceLayout,
  setSyncInterval,
  workspaceContext,
} from './controller.ts';
import { addChart } from './addChart.ts';
import { leaveWorkspace } from './document.ts';
import { redoDrawings, undoDrawings } from '../chart/drawings/actions.ts';
import { requestViewport } from '../chart/viewportRequests.ts';
import { requestPanel } from '../state/panelRequests.ts';
import { EDGES } from './dock/edges.ts';
import {
  floatTile,
  closeTile,
  isFocusMode,
  moveTile,
  openTile,
  panelKind,
  revealTile,
  toggleEdge,
  toggleFocusMode,
} from './dock/open.ts';
import { isMaximised, toggleMaximise } from './dock/maximise.ts';
import { setTileParams } from './dock/tileSettings.ts';
import { storyLayout, storyName, storyPreset } from './presets.ts';
import type { DeskRequestHandlers, TileTarget } from './tileRequests.ts';
import { singletonPanelId } from './tiles/registry.ts';
import { read } from '../app/store.ts';
import { runTool } from '../app/tools.ts';

const TILE_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  dom: [
    'rowTicks',
    'volumeColumn',
    'autoCentre',
    'orders',
    'traded',
    'pullStack',
    'pnl',
    'refills',
    'queue',
    'link',
    'instrument',
  ],
  tape: ['minSize', 'highlight', 'side', 'speed', 'aggregate', 'millis', 'link', 'instrument'],
  positions: ['account'],
};

export function deskRequestHandlers(now: () => number): DeskRequestHandlers {
  return {
    open: (kind, params) => {
      if (kind === 'chart')
        return void addChart({
          instrument: params.instrument,
          placement: params.placement === 'tab' ? 'tab' : 'split',
          beside: params.beside ?? null,
          activate: false,
        });
      if (kind === 'markets') return showArea('markets');
      const { settings, ...pin } = params;
      const id = openTile(kind, { params: pin });
      const panel = id ? workspaceContext()?.api.getPanel(id) : undefined;
      const fields = TILE_SETTINGS[kind];
      if (!panel || !fields || !settings || typeof settings !== 'object' || Array.isArray(settings)) return;
      const patch = Object.fromEntries(Object.entries(settings).filter(([k]) => fields.includes(k)));
      if (Object.keys(patch).length > 0) setTileParams<Record<string, JsonValue>>(panel.api, patch);
    },
    close: (target) => {
      const id = panelFor(target);
      if (id && workspaceContext()?.api.getPanel(id)) closeTile(id);
    },
    focus: (target) => {
      const api = workspaceContext()?.api;
      const id = panelFor(target);
      const panel = id ? api?.getPanel(id) : undefined;
      const kind = panel ? panelKind(panel) : target.kind;
      if (kind === 'markets') return showArea('markets');
      if (kind) revealTile(kind, id ? { panelId: id } : {});
    },
    move: (target, to) => {
      const api = workspaceContext()?.api;
      const found = panelFor(target);
      const id = found && api?.getPanel(found) ? found : target.kind ? revealTile(target.kind) : null;
      if (!id) return;
      if (to === 'floating') floatTile(id);
      else if (to !== 'popout') moveTile(id, to);
    },
    view: (view) => {
      const api = workspaceContext()?.api;
      for (const pos of EDGES) {
        const want = view[pos];
        if (want !== undefined && api?.getEdgeGroup(pos)?.isCollapsed() === want) toggleEdge(pos, 'pointer');
      }
      if (view.shareInterval !== undefined) void setSyncInterval(view.shareInterval);
      if (view.focus !== undefined && view.focus !== isFocusMode()) toggleFocusMode();
    },
    maximize: (target, restore) => {
      const id = panelFor(target);
      const panel = id ? workspaceContext()?.api.getPanel(id) : undefined;
      if (id && panel && isMaximised(id) === restore) toggleMaximise(id);
    },
    viewport: (tileId, view) => {
      const ctx = workspaceContext();
      if (ctx) requestViewport({ layoutId: ctx.layoutId, tileId }, view);
    },
    drawings: (tileId, action) => {
      const ctx = workspaceContext();
      if (!ctx) return;
      const ref = { layoutId: ctx.layoutId, tileId };
      if (action === 'undo') undoDrawings(ref);
      else redoDrawings(ref);
    },
    trade: (tileId, patch) => {
      const ctx = workspaceContext();
      if (ctx) requestPanel(ctx.layoutId, tileId, patch);
    },
    preset: (preset) => {
      if (preset === 'reset') resetWorkspaceLayout();
      else if ((LAYOUT_PRESETS as readonly string[]).includes(preset)) applyLayoutPreset(preset as LayoutPreset);
      else if ((STORY_IDS as readonly string[]).includes(preset)) {
        if (workspaceContext())
          void leaveWorkspace()
            .then(async (left) => {
              if (!left) return;
              setWorkspace(await workspaceFromStory(now, preset as StoryId));
              await left();
            })
            .catch((err: unknown) => console.warn(`[workspace] story ${preset} not made`, err));
      }
    },
    settings: (tileId, settings) => {
      const panel = workspaceContext()?.api.getPanel(tileId);
      const fields = panel ? TILE_SETTINGS[panelKind(panel)] : undefined;
      if (!panel || !fields) return;
      const patch = Object.fromEntries(Object.entries(settings).filter(([k]) => fields.includes(k)));
      if (Object.keys(patch).length > 0) setTileParams<Record<string, JsonValue>>(panel.api, patch);
    },
  };
}

function panelFor(target: TileTarget): string | null {
  if (target.tileId) return target.tileId;
  const api = workspaceContext()?.api;
  const kind = target.kind;
  if (!api || !kind) return null;
  if (kind === 'chart') return activeChartTarget()?.tileId ?? null;
  const first = api.panels.find((p) => panelKind(p) === kind)?.id ?? null;
  return first ?? singletonPanelId(kind);
}

async function workspaceFromStory(now: () => number, id: StoryId): Promise<string> {
  const story = storyPreset(id);
  const instrument = preferredInstrument({ chosen: readSetting(DEFAULT_INSTRUMENT), active: activeChartTarget() });
  const names = (await runTool('layout.list', {}).catch(() => null))?.layouts.map((l) => l.name) ?? [];
  const layoutId = newWorkspaceId(now());
  const tpl = read(templatesStore);
  const fresh = storyLayout(story, {
    layoutId,
    name: storyName(story, names),
    nowNs: now() * 1e6,
    instrument,
    setup: newChartSetup(tpl, tpl.loaded),
  });
  await runTool('layout.save', {
    layoutId,
    name: fresh.name,
    dock: fresh.dock,
    charts: fresh.charts,
    ...(fresh.activeChartId ? { activeChartId: fresh.activeChartId } : {}),
  });
  return layoutId;
}
