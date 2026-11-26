import type { TileSpec } from '@tessera/bridge';
import { useDocumentEnv } from '@tessera/ui';
import type { JsonValue } from '@tessera/protocol';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
} from 'dockview-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertsData } from '../alerts/AlertsData.tsx';
import { applyApprovals, resetApprovals } from '../analyst/analystStore.ts';
import { registerBuiltinWindowCommands } from '../commands/windowCommands.ts';
import { commands } from '../commands/registry.ts';
import { useKeybindings } from '../commands/useKeybindings.ts';
import { listenForSharedLinks } from '../share/open.ts';
import { ShareDialog } from '../share/ShareDialog.tsx';
import { SharedLinkDialog } from '../share/SharedLinkDialog.tsx';
import { RithmicMarks } from '../shell/RithmicMarks.tsx';
import { ShellDataProvider } from '../shell/ShellData.tsx';
import { useShellData } from '../shell/shellData.ts';
import { useDropBoot } from '../shell/boot.ts';
import { setDragRegion } from '../shell/titleBar.ts';
import { WindowControls } from '../shell/WindowControls.tsx';
import { putLayout, layoutsStore } from '../state/layouts.ts';
import { useWindowSettings } from '../state/settingsSync.ts';
import { useWorkspaceTradeSync } from '../state/workspaceTrade.ts';
import { activateChart, attachWorkspace } from '../workspace/controller.ts';
import { putOnDesk } from '../workspace/deskPlace.ts';
import { installActiveChartFollow } from '../workspace/dock/activeChart.ts';
import { DeskToasts } from '../workspace/dock/DeskToasts.tsx';
import { installDragSweep } from '../workspace/dock/header/dragSweep.ts';
import { NoTab, PanelHeader } from '../workspace/dock/header/PanelHeader.tsx';
import { tileDefinition } from '../workspace/tiles/registry.ts';
import { windowTileKind } from './windowKind.ts';
import { AnalystData } from '../analyst/AnalystData.tsx';
import { POPOUT_CHANNEL, type PopoutMessage } from '../workspace/dock/popouts.ts';
import { tileParams } from '../workspace/dock/tileSettings.ts';
import { tesseraDockTheme } from '../workspace/dockTheme.ts';
import { tileComponents } from '../workspace/tiles/index.ts';
import { refreshTools, useHasTool, useTool, useTools, valueOf } from './tools.ts';
import { useTopicEffect } from './useTopic.ts';
import { read } from './store.ts';

const TILES = tileComponents();

function WindowEnv() {
  const { env } = useShellData();
  useDocumentEnv(env);
  return null;
}

function useRightmostGroup(api: IDockviewHeaderActionsProps['containerApi']): string | null {
  const subscribe = useCallback(
    (changed: () => void) => {
      const subs = [api.onDidAddPanel(changed), api.onDidRemovePanel(changed), api.onDidMovePanel(changed)];
      return () => {
        for (const s of subs) s.dispose();
      };
    },
    [api],
  );
  return useSyncExternalStore(subscribe, () => {
    const groups = api.groups.filter((g) => g.panels.length > 0);
    return (api.getPanel('trade')?.group ?? groups[groups.length - 1])?.id ?? null;
  });
}

function WindowHeader(props: IDockviewHeaderActionsProps) {
  const last = useRightmostGroup(props.containerApi);
  return <PanelHeader {...props} end={props.group.id === last ? <WindowControls /> : null} />;
}

const WINDOW_KEYS = new Set(['layoutId', 'tileId', 'panelId']);

function ownParams(params: Record<string, unknown> | undefined): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(params ?? {}).filter(([k]) => !WINDOW_KEYS.has(k))) as Record<
    string,
    JsonValue
  >;
}

export function TileWindow({ tile }: { tile: Omit<TileSpec, 'width' | 'height'> }) {
  useDropBoot();
  const tools = useTools();
  const kind = windowTileKind(tile.kind);
  const def = tileDefinition(kind);
  const p = (tile.params ?? {}) as { layoutId?: string; tileId?: string; panelId?: string };
  const layoutId = p.layoutId ?? null;
  const panelId = p.panelId ?? p.tileId ?? null;
  const [own] = useState(() => ownParams(tile.params));
  const [api, setApi] = useState<DockviewApi | null>(null);
  const hasGet = useHasTool('layout.get');
  const q = useTool('layout.get', hasGet && !!layoutId ? { layoutId: layoutId } : null, { keepFor: 0 });
  const layout = valueOf(q);
  const state: 'loading' | 'ready' | 'gone' =
    !layoutId || !panelId || !def || q.isError
      ? 'gone'
      : !layout
        ? 'loading'
        : kind !== 'chart' || layout.charts[panelId]
          ? 'ready'
          : 'gone';
  useEffect(() => {
    if (layout) putLayout(layout);
  }, [layout]);
  const hostRef = useRef<HTMLDivElement>(null);
  useKeybindings(commands);
  useEffect(() => registerBuiltinWindowCommands(commands), []);
  useEffect(() => listenForSharedLinks('popout'), []);
  useWorkspaceTradeSync(state === 'ready' ? layoutId : null);
  useWindowSettings();

  useTopicEffect('layout', layoutId && state === 'ready' ? { layoutId } : null, (ev) => {
    if (ev.layoutId === layoutId) putLayout(ev.layout);
  });
  useTopicEffect('approvals', {}, (ev) => applyApprovals(ev), {
    onResubscribed: () => resetApprovals(),
  });

  useEffect(() => {
    if (!api || state !== 'ready' || !layoutId || !panelId || !tools || !def) return;
    const detach = attachWorkspace({
      api,
      layoutId,
      tools: new Set(tools.keys()),
      reload: () => void refreshTools('layout.get'),
      canSaveDock: () => false,
      allowDockSaves: () => undefined,
      tileWindows: true,
      popout: true,
      windowPanel: panelId,
    });
    const chart = kind === 'chart' ? read(layoutsStore).layouts[layoutId]?.charts[panelId] : undefined;
    if (!api.getPanel(panelId)) {
      putOnDesk(
        api,
        {
          id: panelId,
          component: kind,
          title: chart?.title ?? def.title,
          params: kind === 'chart' ? { layoutId, tileId: panelId } : own,
        },
        { at: 'active' },
      );
    }
    const panel = api.getPanel(panelId);
    const stopFollow = kind === 'chart' ? installActiveChartFollow(api, layoutId) : () => undefined;
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(POPOUT_CHANNEL);
    if (kind === 'chart') activateChart(layoutId, panelId);
    else {
      const first = read(layoutsStore).layouts[layoutId]?.activeChartId ?? null;
      if (first) activateChart(layoutId, first);
      if (channel) {
        channel.onmessage = (e: MessageEvent<PopoutMessage>) => {
          const m = e.data;
          if (m.type === 'active' && m.layoutId === layoutId && m.tileId) activateChart(layoutId, m.tileId);
        };
        const ask: PopoutMessage = { type: 'ask-active', layoutId };
        channel.postMessage(ask);
      }
    }
    const sub = panel?.api.onDidParametersChange(() => {
      const params = tileParams<Record<string, JsonValue>>(panel.api) as Record<string, JsonValue>;
      const msg: PopoutMessage = { type: 'params', layoutId, panelId, params };
      channel?.postMessage(msg);
    });
    const markVoids = () => {
      for (const el of hostRef.current?.querySelectorAll<HTMLElement>('.dv-void-container') ?? [])
        setDragRegion(el, true);
    };
    markVoids();
    const added = api.onDidAddGroup(() => requestAnimationFrame(markVoids));
    const stopSweep = installDragSweep(document);
    return () => {
      stopSweep();
      added.dispose();
      sub?.dispose();
      stopFollow();
      channel?.close();
      detach();
    };
  }, [api, state, layoutId, panelId, tools, kind, def, own]);

  const onReady = (e: DockviewReadyEvent) => setApi(e.api);
  return (
    <ShellDataProvider>
      <WindowEnv />
      <AlertsData />
      {kind === 'analyst' ? <AnalystData standalone /> : null}
      <div className="t-app tile-window">
        {state === 'gone' ? (
          <div className="tile-window-gone" data-tauri-drag-region>
            <p>{kind === 'chart' ? 'This chart is no longer in its workspace.' : 'This panel is no longer here.'}</p>
            <WindowControls />
          </div>
        ) : (
          <div className="dock-root" ref={hostRef}>
            <DockviewReact
              className="dock-host"
              components={TILES}
              defaultTabComponent={NoTab}
              rightHeaderActionsComponent={WindowHeader}
              disableTabsOverflowList
              onReady={onReady}
              theme={tesseraDockTheme}
              disableDnd
            />
          </div>
        )}
        <footer className="t-shell-footer" aria-label="Notices">
          <DeskToasts />
          <RithmicMarks opensNotices={false} />
        </footer>
        <ShareDialog />
        <SharedLinkDialog />
      </div>
    </ShellDataProvider>
  );
}
