import { type Layout } from '@tessera/protocol';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from 'dockview-react';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { LoadCover } from '@tessera/ui';
import { InSight, SightSwitch } from '../app/inSight.ts';
import { runTool, toolCode, useHasTool, useToolValue, useTools } from '../app/tools.ts';
import { useServer } from '../app/runtimeContext.ts';
import { useClock } from '../app/clock.ts';
import { watchPanelOpens } from '../app/telemetry.ts';
import { useTopicEffect } from '../app/useTopic.ts';
import { SymbolSearch } from '../chart/ChartTools.tsx';
import { newChartSetup } from '../chart/templates/model.ts';
import { templatesStore } from '../chart/templates/store.ts';
import {
  DEFAULT_VIEW,
  DOCK_VERSION,
  dockTreeOf,
  layoutCreated,
  layoutsStore,
  putLayout,
  setActiveChart,
  setLayoutCharts,
  setStageView,
  takeSeededLayout,
} from '../state/layouts.ts';
import { useUi, setWorkspace } from '../state/ui.ts';
import { setActiveChartRef, setBlockedLayout, workspaceStore, type ActiveChartRef } from '../state/workspace.ts';
import { useWorkspaceTradeSync } from '../state/workspaceTrade.ts';
import {
  activateChart,
  activeChartTarget,
  attachWorkspace,
  mountWorkspace,
  noteDockInStep,
  popped,
  saveLayout,
  type WorkspaceContext,
} from './controller.ts';
import { installActiveChartFollow } from './dock/activeChart.ts';
import { DeskEmpty } from './dock/DeskEmpty.tsx';
import { installDragSweep } from './dock/header/dragSweep.ts';
import { NoTab, PanelHeader } from './dock/header/PanelHeader.tsx';
import { LayoutKnownContext } from './dock/layoutKnown.ts';
import { installMoveOpensEdge } from './dock/edgeArrive.ts';
import { DND_EDGES, installEdgeDrop } from './dock/edgeDrop.ts';
import { installRailDrop } from './dock/railDrop.ts';
import { installEdgeRest } from './dock/edgeRest.ts';
import { installHeaderBand } from './dock/headerBand.ts';
import { installCollapsibleEdges } from './dock/collapse.ts';
import { EDGE_STRIP, ensureEdges, installEdgeChrome, syncEdgeChrome } from './dock/edges.ts';
import { normalizeChartLinks } from './dock/links.ts';
import { installMaximiseEsc, installMaximiseSync, reapplyMaximised } from './dock/maximise.ts';
import { installMinimums } from './dock/minimums.ts';
import { EDGE_MOTION_END } from './dock/motion.ts';
import { installCollapseRecorder, isFocusMode, quietly, resetFocusMode, toggleFocusMode } from './dock/open.ts';
import { installPanelDrop, resumePopouts } from './dock/popouts.ts';
import { installResponsive } from './dock/responsiveDock.ts';
import { tesseraDockTheme } from './dockTheme.ts';
import { storyCollapsed, storyPreset } from './presets.ts';
import { preferredInstrument } from '../frame/workspaces.ts';
import { buildDockFromLayout, dockShape, isLoadableDock, newWorkspaceLayout, reconcileDock } from './layouts.ts';
import { adoptUnknownTiles, restoreUnknownTiles, tileComponents, tileMinWidth, tileRoom } from './tiles/index.ts';
import { deskRequestHandlers } from './deskRequests.ts';
import { noteDocument } from './document.ts';
import { keepExisting, keepShown, type Kept } from './kept.ts';
import { takeDeskRequests } from './tileRequests.ts';
import { read } from '../app/store.ts';

const TILES = tileComponents();

const SAVE_DEBOUNCE_MS = 800;

const REVERTED = 'workspace.revert';

const DOCK_THEME = { ...tesseraDockTheme, edgeGroupCollapsedSize: EDGE_STRIP };

type DockJson = Parameters<DockviewApi['fromJSON']>[0];

function storedTree(layout: Layout): unknown {
  if (!isLoadableDock(layout.dock)) return null;
  const view = read(layoutsStore).views[layout.id] ?? DEFAULT_VIEW;
  return view.v >= DOCK_VERSION ? dockTreeOf(layout.dock) : null;
}

function adoptActiveChart(ctx: WorkspaceContext): void {
  const target = activeChartTarget(ctx);
  if (target) activateChart(target.layoutId, target.tileId);
}

/**
 * dockview places the panels it keeps in its overlay from their on-screen boxes: a box read while a transform still
 * runs leaves that panel shifted and shrunk until the next layout.
 */
const BOX_MOTION = /^(width|height|left|top|transform|margin|padding)/;

function installRemeasureAfterMotion(api: DockviewApi, root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  let frame = 0;
  const measure = () => {
    frame = 0;
    // the whole dock's size, edges included (what dockview lays out from); `api.width` is the centre grid's alone
    const shell = root.querySelector<HTMLElement>('.dv-shell');
    if (shell && shell.clientWidth > 0) api.layout(shell.clientWidth, shell.clientHeight, true);
  };
  const settle = (e: Event) => {
    const target = e.target;
    if (!(target instanceof Node)) return;
    const inside =
      root.contains(target) &&
      (e.type === EDGE_MOTION_END || (e instanceof TransitionEvent && BOX_MOTION.test(e.propertyName)));
    if (!target.contains(root) && !inside) return;
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const kinds = ['animationend', 'animationcancel', 'transitionend', 'transitioncancel', EDGE_MOTION_END] as const;
  for (const k of kinds) doc.addEventListener(k, settle, true);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    for (const k of kinds) doc.removeEventListener(k, settle, true);
  };
}

const SWITCH_COVER_MS = 6000;

function WorkspaceDock({
  layoutId,
  isDefault,
  shown,
  cover,
}: {
  layoutId: string;
  isDefault: boolean;
  shown: boolean;
  cover: boolean;
}) {
  const clock = useClock();
  const [requests] = useState(() => deskRequestHandlers(() => clock.now()));
  const tools = useTools();
  const toolsKnown = tools !== null;
  const apiRef = useRef<DockviewApi | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const applying = useRef(false);
  const dockPending = useRef(false);
  const dockSaveBlocked = useRef(false);
  const stopPopouts = useRef<((closeWindows: boolean) => void) | null>(null);
  const ctxRef = useRef<WorkspaceContext | null>(null);
  const shownRef = useRef(shown);
  const [sight] = useState(() => new SightSwitch(shown));
  const keptActive = useRef<ActiveChartRef | null>(null);
  useLayoutEffect(() => {
    if (shown) {
      const ctx = ctxRef.current;
      const had = keptActive.current;
      keptActive.current = null;
      if (had && read(layoutsStore).layouts[layoutId]?.charts[had.tileId] && ctx?.api.getPanel(had.tileId)) {
        setActiveChartRef(had);
        setActiveChart(layoutId, had.tileId);
      } else if (ctx && loaded.current) adoptActiveChart(ctx);
      sight.set(true);
    } else {
      sight.set(false);
      const active = read(workspaceStore).activeChart;
      if (active?.layoutId === layoutId) {
        keptActive.current = active;
        setActiveChartRef(null);
      }
    }
  }, [sight, shown, layoutId]);
  const setBlocked = (id: string | null) => {
    if (shownRef.current) setBlockedLayout(id);
  };
  const [ready, setReady] = useState(false);
  const [layoutKnown, setLayoutKnown] = useState(false);
  const [created, setCreated] = useState(() => layoutCreated(layoutId) === null);
  useEffect(() => {
    if (created) return;
    let on = true;
    void (layoutCreated(layoutId) ?? Promise.resolve()).then(() => {
      if (on) setCreated(true);
    });
    return () => {
      on = false;
    };
  }, [created, layoutId]);

  const apply = (fn: () => void) => {
    applying.current = true;
    try {
      quietly(fn);
    } finally {
      applying.current = false;
    }
  };

  const settle = (api: DockviewApi, layout: Layout) => {
    const view = read(layoutsStore).views[layout.id] ?? DEFAULT_VIEW;
    reconcileDock(api, layout, popped(layout.id));
    ensureEdges(api, { collapsed: view.collapsed });
    syncEdgeChrome(api);
  };

  const loadDock = (api: DockviewApi, layout: Layout): 'stored' | 'built' | 'failed' => {
    putLayout(layout);
    let result: 'stored' | 'built' | 'failed' = 'built';
    apply(() => {
      const tree = storedTree(layout);
      if (tree) {
        const { dock, unknown } = adoptUnknownTiles(tree);
        if (unknown.length > 0) {
          console.warn(
            `[workspace] ${layout.id} holds tiles this build does not know (${unknown.join(', ')}); kept as placeholders`,
          );
        }
        try {
          api.fromJSON(dock as DockJson);
          settle(api, read(layoutsStore).layouts[layout.id] ?? layout);
          reapplyMaximised(api, layout.id);
          result = 'stored';
          return;
        } catch (err) {
          console.warn(
            `[workspace] stored dock of ${layout.id} could not be loaded; showing the default without saving it`,
            err,
          );
          result = 'failed';
        }
      }
      const storyId = read(layoutsStore).views[layout.id]?.story ?? null;
      const story = storyId ? storyPreset(storyId) : null;
      const collapsed = story ? storyCollapsed(story) : {};
      const kept = result === 'failed' ? popped(layout.id) : new Set<string>();
      buildDockFromLayout(api, layout, { collapsed, popped: kept, story });
      if (result !== 'failed') {
        setStageView(layout.id, { ...DEFAULT_VIEW, v: DOCK_VERSION, collapsed, story: storyId });
        const linked = normalizeChartLinks(layout.charts);
        if (linked) setLayoutCharts(layout.id, linked);
      }
    });
    return result;
  };

  const arrive = useEffectEvent(() => {
    const ctx = ctxRef.current;
    if (!ctx || !loaded.current) return;
    setBlockedLayout(dockSaveBlocked.current ? layoutId : null);
    adoptActiveChart(ctx);
    stopPopouts.current?.(false);
    stopPopouts.current = resumePopouts(layoutId);
    const layout = read(layoutsStore).layouts[layoutId];
    if (layout && !dockSaveBlocked.current && takeDeskRequests(layout, requests)) void saveLayout(ctx);
  });

  const leave = useEffectEvent(() => {
    if (isFocusMode()) toggleFocusMode();
    stopPopouts.current?.(true);
    stopPopouts.current = null;
    if (read(workspaceStore).activeChart?.layoutId === layoutId) setActiveChartRef(null);
    setBlockedLayout(null);
  });

  const load = useEffectEvent(async (api: DockviewApi) => {
    loaded.current = false;
    if (shownRef.current) resetFocusMode();
    let layout: Layout | null = takeSeededLayout(layoutId);
    if (!layout && tools?.has('layout.get')) {
      try {
        layout = await runTool('layout.get', { layoutId });
      } catch (err) {
        if (toolCode(err) !== 'not_found') {
          console.warn(`[workspace] layout.get ${layoutId} failed; using a local layout`, err);
        } else if (!isDefault) {
          if (apiRef.current === api) setWorkspace(null);
          return;
        }
      }
    }
    if (apiRef.current !== api) return;
    if (layout) noteDocument(layout);
    const tpl = read(templatesStore);
    const fresh =
      layout ??
      newWorkspaceLayout(layoutId, clock.now() * 1e6, {
        instrument: preferredInstrument(),
        setup: newChartSetup(tpl, tpl.loaded),
      });
    const result = loadDock(api, fresh);
    if (result === 'stored') noteDockInStep(fresh.id, dockTreeOf(fresh.dock));
    dockSaveBlocked.current = result === 'failed';
    setBlocked(result === 'failed' ? fresh.id : null);
    loaded.current = true;
    setLayoutKnown(true);
    if (shownRef.current) arrive();
    if (result === 'built') void saveLayout(ctxRef.current);
  });

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    setReady(true);
  }, []);

  const dock = useMemo(
    () => (
      <DockviewReact
        className="dock-host"
        components={TILES}
        defaultTabComponent={NoTab}
        rightHeaderActionsComponent={PanelHeader}
        disableTabsOverflowList
        watermarkComponent={DeskEmpty}
        dndEdges={DND_EDGES}
        defaultRenderer="always"
        floatingGroupDragHandle="tabbar"
        onReady={onReady}
        theme={DOCK_THEME}
      />
    ),
    [onReady],
  );

  useEffect(() => {
    const api = apiRef.current;
    const root = hostRef.current;
    const centre = root?.querySelector<HTMLElement>('.dock-host');
    if (!ready || !api || !root || !centre) return;
    const loadingLayout = () => applying.current || !loaded.current;
    const offs = [
      installEdgeChrome(api, tileRoom),
      installMinimums(api, tileMinWidth),
      installCollapsibleEdges(api, root),
      installCollapseRecorder(api, layoutId),
      installActiveChartFollow(api, layoutId, loadingLayout),
      installEdgeDrop(api, centre),
      installRailDrop(api),
      installPanelDrop(api, layoutId),
      installMoveOpensEdge(api, loadingLayout),
      installResponsive(api, root, tileRoom),
      installEdgeRest(api, layoutId, loadingLayout),
      installHeaderBand(api, root),
      installDragSweep(root.ownerDocument),
      installRemeasureAfterMotion(api, root),
      installMaximiseSync(api, layoutId),
      watchPanelOpens(api, loadingLayout),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [ready, layoutId]);

  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api || !tools) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctx: WorkspaceContext = {
      api,
      layoutId,
      tools: new Set(tools.keys()),
      flush: () => {
        if (!timer) return Promise.resolve();
        clearTimeout(timer);
        timer = null;
        return saveLayout(ctx).finally(() => {
          if (!timer) dockPending.current = false;
        });
      },
      reload: () => void load(api),
      canSaveDock: () => !dockSaveBlocked.current,
      allowDockSaves: () => {
        dockSaveBlocked.current = false;
        setBlocked(null);
      },
      tileWindows: true,
    };
    ctxRef.current = ctx;
    const unmount = mountWorkspace(ctx);
    const detach = shownRef.current ? attachWorkspace(ctx) : () => undefined;
    void load(api);
    const sub = api.onDidLayoutChange(() => {
      if (!loaded.current || applying.current || dockSaveBlocked.current) return;
      if (timer) clearTimeout(timer);
      dockPending.current = true;
      timer = setTimeout(() => {
        timer = null;
        void saveLayout(ctx).finally(() => {
          if (!timer) dockPending.current = false;
        });
      }, SAVE_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      dockPending.current = false;
      if (shownRef.current) leave();
      ctxRef.current = null;
      sub.dispose();
      detach();
      unmount();
    };
  }, [ready, layoutId, tools]);

  useEffect(() => {
    shownRef.current = shown;
    const ctx = ctxRef.current;
    if (!shown || !ctx) return;
    const detach = attachWorkspace(ctx);
    const offEsc = installMaximiseEsc(document);
    arrive();
    return () => {
      offEsc();
      if (ctxRef.current === ctx) leave();
      detach();
    };
  }, [shown, ready, tools]);

  useTopicEffect('layout', created && toolsKnown && tools.has('layout.get') ? { layoutId } : null, (ev) => {
    const api = apiRef.current;
    if (!api || !loaded.current || ev.layoutId !== layoutId) return;
    noteDocument(ev.layout);
    const before = read(layoutsStore).layouts[layoutId];
    const knownOnlyFromChartTool = read(layoutsStore).chartToolRevision[layoutId] === ev.revision;
    if (before && (ev.revision < before.revision || (ev.revision === before.revision && !knownOnlyFromChartTool)))
      return;
    const reverted = ev.reason === REVERTED;
    const windowsBack = reverted && shownRef.current;
    if (windowsBack) {
      stopPopouts.current?.(true);
      stopPopouts.current = null;
    }
    putLayout(ev.layout);
    const tree = storedTree(ev.layout);
    const dockChanged =
      !!tree &&
      (reverted || (!dockPending.current && dockShape(tree) !== dockShape(restoreUnknownTiles(api.toJSON()))));
    apply(() => {
      if (tree && dockChanged) {
        try {
          api.fromJSON(adoptUnknownTiles(tree).dock as DockJson, { reuseExistingPanels: true });
          noteDockInStep(layoutId, dockTreeOf(ev.layout.dock));
          dockSaveBlocked.current = false;
          setBlocked(null);
        } catch (err) {
          console.warn(
            `[workspace] dock from ${ev.layout.id} revision ${String(ev.revision)} could not be loaded`,
            err,
          );
        }
      }
      if (tree && !dockChanged && !dockPending.current) noteDockInStep(layoutId, dockTreeOf(ev.layout.dock));
      settle(api, read(layoutsStore).layouts[layoutId] ?? ev.layout);
      if (reverted) reapplyMaximised(api, layoutId);
    });
    if (windowsBack) stopPopouts.current = resumePopouts(layoutId);
    const asked = shownRef.current && takeDeskRequests(ev.layout, requests);
    if (asked) void saveLayout(ctxRef.current);
  });

  return (
    <div className="dock-root" ref={hostRef} data-kept={shown ? undefined : ''} inert={!shown}>
      <InSight.Provider value={sight}>
        <LayoutKnownContext.Provider value={layoutKnown}>
          <LoadCover label="Loading the workspace" active={cover} held={!layoutKnown} waitMs={SWITCH_COVER_MS}>
            {dock}
          </LoadCover>
          <SymbolSearch at="desk" active />
        </LayoutKnownContext.Provider>
      </InSight.Provider>
    </div>
  );
}

function resetSplitAt(e: MouseEvent<HTMLElement>): void {
  const sash = (e.target as Element).closest('.dv-sash');
  if (!sash) return;
  const container = sash.closest('.dv-split-view-container');
  const views = container?.querySelector(':scope > .dv-view-container');
  if (!container || !views) return;
  const horizontal = container.classList.contains('dv-horizontal');
  const s = sash.getBoundingClientRect();
  const at = horizontal ? s.left + s.width / 2 : s.top + s.height / 2;
  const kids = [...views.children] as HTMLElement[];
  const i = kids.findIndex((v) => {
    const r = v.getBoundingClientRect();
    return Math.abs((horizontal ? r.right : r.bottom) - at) <= 4;
  });
  const a = kids[i];
  const b = kids[i + 1];
  if (!a || !b) return;
  const size = (v: HTMLElement) => (horizontal ? v.getBoundingClientRect().width : v.getBoundingClientRect().height);
  const target = (size(a) + size(b)) / 2;
  const delta = target - size(a);
  if (Math.abs(delta) < 1) return;
  const opts = { bubbles: true, clientX: horizontal ? at : s.left + 1, clientY: horizontal ? s.top + 1 : at };
  const to = {
    ...opts,
    clientX: horizontal ? at + delta : opts.clientX,
    clientY: horizontal ? opts.clientY : at + delta,
  };
  sash.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true, button: 0 }));
  document.dispatchEvent(new PointerEvent('pointermove', { ...to, pointerId: 1, isPrimary: true }));
  document.dispatchEvent(new PointerEvent('pointerup', { ...to, pointerId: 1, isPrimary: true }));
}

export function Workspace() {
  const picked = useUi((s) => s.workspace);
  const fallback = useServer()?.defaultLayoutId ?? 'default';
  const layoutId = picked ?? fallback;
  useWorkspaceTradeSync(layoutId);
  const canList = useHasTool('layout.list');
  const list = useToolValue('layout.list', canList ? {} : null);
  const [kept, setKept] = useState<Kept>(() => keepShown(null, layoutId));
  const [first] = useState(layoutId);
  let next = kept.recent[0] === layoutId ? kept : keepShown(kept, layoutId);
  if (list) next = keepExisting(next, (id) => list.layouts.some((l) => l.id === id));
  if (next !== kept) setKept(next);
  return (
    <main className="workspace" aria-label="Workspace" onDoubleClick={resetSplitAt}>
      {next.mounted.map((id) => (
        <WorkspaceDock
          key={id}
          layoutId={id}
          isDefault={id === fallback}
          shown={id === layoutId}
          cover={id !== first}
        />
      ))}
    </main>
  );
}
