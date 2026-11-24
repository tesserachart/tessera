import { analystActivity, isWorking } from '../analyst/activity.ts';
import { newSession, stopFromCommand } from '../analyst/actions.ts';
import { readyModels, selectCurrent, selectTranscript, analystStore, setSheet } from '../analyst/analystStore.ts';
import { CHART_TIMEFRAMES } from '../market/instruments.ts';
import {
  ANALYST_KEY,
  FOCUS_KEY,
  MARKETS_KEY,
  NEW_SESSION_KEY,
  SETTINGS_KEY,
  SAVE_WORKSPACE_KEY,
  STOP_KEY,
  TRADE_KEY,
  CLOSE_TAB_KEY,
  NEW_TAB_KEY,
  SPLIT_CHART_KEY,
} from '../shell/keys.ts';
import { newChartTab, splitChart } from '../workspace/addChart.ts';
import { orderToCheck } from '../analyst/orderCheck.ts';
import { openAppMenu } from '../frame/appMenuStore.ts';
import { tradeKey } from '../workspace/tiles/trade.ts';
import { alertCommands } from '../alerts/commands.ts';
import { drawingCommands } from '../chart/drawings/commands.ts';
import { orderFlowCommands } from '../chart/orderflowCommands.ts';
import { domCommands } from '../orderflow/dom/commands.ts';
import { registerOrderKeys, ticketCommands } from '../chart/ticket/commands.ts';
import { ORDER_HOTKEYS_KEY, orderHotkeysOf } from '../shell/orderHotkeys.ts';
import { setRuntimeSetting, runtimeSettingsStore } from '../state/runtimeSettings.ts';
import { tapeCommands } from '../orderflow/tape/commands.ts';
import { ADD_INDICATOR_KEY, openAdd } from '../chart/settings/store.ts';
import {
  closePalette,
  openPalette,
  openSymbolSearch,
  setComposerDraft,
  setDensity,
  setUpDown,
  uiStore,
} from '../state/ui.ts';
import { stopAllCopying, copyStore } from '../accounts/copy.ts';
import { openCopyGroup } from '../areas/copy/store.ts';
import { CATEGORIES } from '../areas/settings/model.ts';
import { openSettings, toggleSettings } from '../areas/settings/store.ts';
import { addConnection, openConnections, openExchanges } from '../accounts/navigate.ts';
import {
  activeChartTarget,
  resetWorkspaceLayout,
  setChartTimeframe,
  workspaceContext,
} from '../workspace/controller.ts';
import { isComposerFocused } from '../shell/composer.ts';
import {
  closeActiveTab,
  cycleGroup,
  cycleTab,
  closeTile,
  isTileVisible,
  revealTile,
  toggleEdge,
  toggleFocusMode,
} from '../workspace/dock/open.ts';
import { toggleMaximise } from '../workspace/dock/maximise.ts';
import { popOutTile } from '../workspace/dock/popouts.ts';
import { chooseFromLibrary, libraryKinds, showTitle, whereNow } from '../workspace/dock/library.ts';
import { singletonPanelId, type TileDefinition } from '../workspace/tiles/registry.ts';
import { AREAS, type AreaDef } from '../areas/registry.ts';
import { showArea, showPreviousArea, areaStore } from '../areas/store.ts';
import type { Command, CommandRegistry } from './registry.ts';
import { read } from '../app/store.ts';
import { FEEDBACK_KEY } from '../feedback/model.ts';
import { openFeedback } from '../feedback/store.ts';
import { isUnsaved, revertWorkspace, saveWorkspace } from '../workspace/document.ts';

export function areaCommand(a: AreaDef): Command {
  return {
    id: `area.${a.id}`,
    title: `Go to ${a.label}`,
    group: 'View',
    keywords: a.keywords,
    shortcut: a.shortcut,
    allowInInput: true,
    ...(a.id === 'settings' ? { hidden: true } : {}),
    run: () => showArea(a.id),
  };
}

function panelCommand(d: TileDefinition, taken: ReadonlySet<string>): Command {
  const keyedLine = d.shortcut !== undefined && taken.has(d.shortcut);
  return {
    id: `tile.show.${d.kind}`,
    title: showTitle(d),
    group: 'View',
    keywords: [d.kind, 'tile', 'panel', ...d.keywords],
    ...(keyedLine ? { hidden: true } : {}),
    ...(d.shortcut && !keyedLine ? { shortcut: d.shortcut, allowInInput: true } : {}),
    hint: () => whereNow(d.kind),
    run: () => chooseFromLibrary(d.kind, null, 'key'),
  };
}

export interface BuiltinDeps {
  runtime?: boolean;
  focusComposer: () => void;
}

export function registerBuiltinCommands(registry: CommandRegistry, deps: BuiltinDeps): () => void {
  const ui = () => read(uiStore);
  const hasChart = () => activeChartTarget() !== null;
  const askAnalyst = () => {
    revealTile('analyst', { via: 'key' });
    deps.focusComposer();
  };
  const checkOrder = () => {
    const text = orderToCheck();
    if (text) setComposerDraft(text);
    askAnalyst();
  };
  let before: Element | null = null;
  const analystKey = () => {
    const id = singletonPanelId('analyst') ?? 'analyst';
    if (isTileVisible(id) && isComposerFocused()) {
      closeTile(id);
      const back = before;
      before = null;
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    before = document.activeElement;
    if (!isTileVisible(id)) revealTile('analyst', { via: 'key' });
    deps.focusComposer();
  };
  const analystWorks = () => {
    const st = read(analystStore);
    return isWorking(analystActivity(selectTranscript(st), selectCurrent(st)));
  };
  const analystKeys: Command[] = deps.runtime
    ? [
        {
          id: 'agent.stop',
          title: 'Stop the analyst',
          group: 'Analyst',
          keywords: ['interrupt', 'cancel', 'halt'],
          shortcut: STOP_KEY,
          allowInInput: true,
          when: analystWorks,
          run: stopFromCommand,
        },
        {
          id: 'agent.newSession',
          title: 'New analyst session',
          group: 'Analyst',
          keywords: ['chat', 'conversation', 'start'],
          shortcut: NEW_SESSION_KEY,
          allowInInput: true,
          run: async () => {
            const ready = readyModels(read(analystStore).providers);
            if (ready.length === 0) {
              revealTile('analyst', { via: 'key' });
              setSheet(true);
              return;
            }
            const id = await newSession(ready);
            if (id === null) return;
            revealTile('analyst', { via: 'key' });
            deps.focusComposer();
          },
        },
      ]
    : [];

  const list: Command[] = [
    ...analystKeys,
    {
      id: 'palette.open',
      title: 'Open command palette',
      group: 'General',
      shortcut: 'mod+k',
      allowInInput: true,
      hidden: true,
      run: () => {
        if (ui().paletteOpen) closePalette();
        else openPalette();
      },
    },
    {
      id: 'chart.changeSymbol',
      title: 'Change symbol…',
      group: 'Chart',
      keywords: ['instrument', 'ticker', 'search'],
      when: hasChart,
      run: () => {
        openSymbolSearch('');
      },
    },
    {
      id: 'view.trade',
      title: 'Trade: show, focus or hide',
      group: 'View',
      keywords: [
        'show trade',
        'ticket',
        'order entry',
        'buy',
        'sell',
        'execution',
        'trading panel',
        'right',
        'sidebar',
      ],
      shortcut: TRADE_KEY,
      allowInInput: true,
      run: tradeKey,
    },
    {
      id: 'workspace.save',
      title: 'Save workspace',
      group: 'Workspace',
      keywords: ['save layout', 'keep changes'],
      shortcut: SAVE_WORKSPACE_KEY,
      allowInInput: true,
      when: () => read(areaStore).area === 'desk' && workspaceContext() !== null,
      run: () => saveWorkspace().catch((err: unknown) => console.warn('[workspace] not saved', err)),
    },
    {
      id: 'workspace.revert',
      title: 'Revert workspace to saved',
      group: 'Workspace',
      keywords: ['discard changes', 'undo changes', 'last saved'],
      when: () => isUnsaved(workspaceContext()?.layoutId ?? null),
      run: () => revertWorkspace().catch((err: unknown) => console.warn('[workspace] not reverted', err)),
    },
    {
      id: 'workspace.switch',
      title: 'Switch workspace…',
      group: 'Workspace',
      keywords: ['layouts', 'workspaces', 'rename', 'duplicate', 'new workspace', 'default'],
      run: () => {
        requestAnimationFrame(() => openAppMenu('workspaces'));
      },
    },
    {
      id: 'workspace.arrange',
      title: 'Arrange charts…',
      group: 'Workspace',
      keywords: ['layout', 'grid', 'split', 'side by side', 'stacked', '2x2', 'link all charts', 'share interval'],
      run: () => {
        requestAnimationFrame(() => openAppMenu('arrange'));
      },
    },
    {
      id: 'chart.addIndicator',
      title: 'Add indicator…',
      group: 'Chart',
      keywords: ['study', 'studies', 'moving average', 'rsi', 'macd', 'bollinger', 'vwap', 'layers'],
      shortcut: ADD_INDICATOR_KEY,
      zone: 'chart',
      when: hasChart,
      run: () => {
        const target = activeChartTarget();
        if (target) openAdd(target);
      },
    },
    ...drawingCommands(),
    ...orderFlowCommands(),
    ...domCommands(),
    ...ticketCommands(),
    {
      id: 'trade.orderHotkeys.settings',
      title: 'Order hotkeys…',
      group: 'Trade',
      keywords: ['hotkeys', 'keyboard', 'keys', 'buy', 'sell', 'flatten', 'reverse', 'cancel all'],
      run: () => openSettings('trading.orderHotkeys'),
    },
    {
      id: 'trade.orderHotkeys.off',
      title: 'Turn order hotkeys off',
      group: 'Trade',
      keywords: ['hotkeys', 'keyboard', 'disable', 'stop'],
      when: () => !!deps.runtime && orderHotkeysOf(read(runtimeSettingsStore).values[ORDER_HOTKEYS_KEY]).enabled,
      run: async () => {
        if (deps.runtime) await setRuntimeSetting(ORDER_HOTKEYS_KEY, { enabled: false });
      },
    },
    ...tapeCommands(),
    ...(deps.runtime ? alertCommands() : []),
    ...CHART_TIMEFRAMES.map((tf): Command => ({
      id: `chart.timeframe.${tf}`,
      title: `Timeframe ${tf}`,
      group: 'Chart',
      keywords: ['interval', 'tf', tf],
      when: hasChart,
      run: async () => {
        await setChartTimeframe(tf);
      },
    })),
    {
      id: 'view.analyst',
      title: 'Analyst: show, focus or hide',
      group: 'View',
      keywords: ['show analyst', 'agent', 'ai', 'right', 'collapse', 'composer'],
      shortcut: ANALYST_KEY,
      allowInInput: true,
      run: analystKey,
    },
    {
      id: 'view.markets',
      title: 'Markets: show or go back',
      group: 'View',
      keywords: ['symbols', 'watchlist', 'search', 'futures', 'contracts', 'positions'],
      shortcut: MARKETS_KEY,
      allowInInput: true,
      hidden: true,
      run: () => {
        if (read(areaStore).area === 'markets') showPreviousArea();
        else showArea('markets');
      },
    },
    {
      id: 'view.edge.left',
      title: 'Left side: open or collapse',
      group: 'View',
      keywords: ['sidebar', 'edge'],
      shortcut: 'mod+b',
      allowInInput: true,
      run: () => toggleEdge('left', 'key'),
    },
    {
      id: 'view.edge.right',
      title: 'Right side: open or collapse',
      group: 'View',
      keywords: ['sidebar', 'analyst', 'edge'],
      shortcut: 'mod+alt+b',
      allowInInput: true,
      run: () => toggleEdge('right', 'key'),
    },
    {
      id: 'view.edge.bottom',
      title: 'Bottom: open or collapse',
      group: 'View',
      keywords: ['positions', 'accounts', 'panel', 'edge'],
      shortcut: 'mod+alt+p',
      allowInInput: true,
      run: () => toggleEdge('bottom', 'key'),
    },
    {
      id: 'view.focus',
      title: 'Focus mode',
      group: 'View',
      keywords: ['hide', 'chart only', 'collapse all'],
      shortcut: FOCUS_KEY,
      allowInInput: true,
      run: () => toggleFocusMode(),
    },
    {
      id: 'view.maximize',
      title: 'Maximise or restore the panel',
      group: 'View',
      keywords: ['zoom', 'full', 'maximize', 'fill the desk'],
      shortcut: 'mod+shift+enter',
      when: () => !!workspaceContext()?.api.activePanel,
      run: () => {
        const id = workspaceContext()?.api.activePanel?.id;
        if (id) toggleMaximise(id);
      },
    },
    {
      id: 'view.nextTab',
      title: 'Next tab',
      group: 'View',
      keywords: ['switch tab', 'cycle'],
      shortcut: 'ctrl+tab',
      allowInInput: true,
      run: () => cycleTab(1),
    },
    {
      id: 'view.previousTab',
      title: 'Previous tab',
      group: 'View',
      keywords: ['switch tab', 'cycle'],
      shortcut: 'ctrl+shift+tab',
      allowInInput: true,
      run: () => cycleTab(-1),
    },
    {
      id: 'view.nextGroup',
      title: 'Next panel',
      group: 'View',
      keywords: ['focus', 'group', 'pane', 'cycle'],
      shortcut: 'f6',
      allowInInput: true,
      run: () => cycleGroup(1),
    },
    {
      id: 'view.previousGroup',
      title: 'Previous panel',
      group: 'View',
      keywords: ['focus', 'group', 'pane', 'cycle'],
      shortcut: 'shift+f6',
      allowInInput: true,
      run: () => cycleGroup(-1),
    },
    {
      id: 'chart.newTab',
      title: 'New chart tab…',
      group: 'Chart',
      keywords: ['tab', 'add chart', 'open chart', 'new chart', 'symbol'],
      shortcut: NEW_TAB_KEY,
      when: hasChart,
      run: () => newChartTab(),
    },
    {
      id: 'chart.split',
      title: 'Split chart',
      group: 'Chart',
      keywords: ['split', 'side by side', 'multi chart', 'multiple charts', 'second chart', 'add chart', 'new chart'],
      shortcut: SPLIT_CHART_KEY,
      when: hasChart,
      run: () => void splitChart(),
    },
    {
      id: 'view.closeTab',
      title: 'Close or hide the tab',
      group: 'View',
      keywords: ['close', 'hide', 'tab', 'panel'],
      shortcut: CLOSE_TAB_KEY,
      run: () => void closeActiveTab(),
    },
    {
      id: 'view.popout.analyst',
      title: 'Pop out the analyst',
      group: 'View',
      keywords: ['window', 'monitor', 'tear out', 'detach', 'agent'],
      when: () => workspaceContext()?.api.getPanel(singletonPanelId('analyst') ?? 'analyst') !== undefined,
      run: () => void popOutTile(singletonPanelId('analyst') ?? 'analyst'),
    },
    {
      id: 'view.popout.chart',
      title: 'Pop out the chart',
      group: 'View',
      keywords: ['window', 'monitor', 'tear out', 'detach', 'second screen'],
      when: () => (workspaceContext()?.api.panels.filter((p) => p.api.component === 'chart').length ?? 0) > 1,
      run: () => {
        const id = activeChartTarget()?.tileId;
        if (id) void popOutTile(id);
      },
    },
    {
      id: 'agent.focusComposer',
      title: 'Ask the analyst',
      group: 'Analyst',
      shortcut: 'mod+i',
      allowInInput: true,
      run: checkOrder,
    },
    {
      id: 'agent.focusComposer.slash',
      title: 'Ask the analyst',
      group: 'Analyst',
      shortcut: '/',
      hidden: true,
      when: () => read(areaStore).area !== 'settings',
      run: askAnalyst,
    },
    {
      id: 'connections.open',
      title: 'Connections',
      group: 'General',
      keywords: ['rithmic', 'login', 'data feed', 'feed settings', 'prop firm', 'broker', 'reconnect'],
      run: () => openConnections(),
    },
    {
      id: 'connections.add',
      title: 'Add connection',
      group: 'General',
      keywords: ['rithmic', 'login', 'prop firm', 'evaluation', 'funded', 'new feed', 'broker'],
      run: () => addConnection(),
    },
    {
      id: 'connections.exchanges',
      title: 'Data and orders by exchange',
      group: 'General',
      keywords: ['data from', 'execute with', 'exchange', 'feed', 'route', 'subscribe list', 'cme', 'comex', 'account'],
      run: () => openExchanges(),
    },
    {
      id: 'copy.groups',
      title: 'Copy groups',
      group: 'Trade',
      keywords: ['copier', 'trade copier', 'mirror', 'followers', 'leader', 'evals', 'accounts', 'sync'],
      run: () => {
        const groups = read(copyStore).groups ?? [];
        openCopyGroup((groups.find((g) => g.enabled) ?? groups[0])?.id ?? null);
      },
    },
    {
      id: 'copy.stopAll',
      title: 'Stop all copying',
      group: 'Trade',
      keywords: ['copier', 'copy', 'off', 'disable', 'followers', 'mirror'],
      when: () => !!deps.runtime && (read(copyStore).groups ?? []).some((g) => g.enabled),
      run: async () => {
        if (deps.runtime) await stopAllCopying(read(copyStore).groups);
      },
    },
    {
      id: 'feedback.open',
      title: 'Send feedback…',
      group: 'Help',
      keywords: ['feedback', 'bug', 'report a problem', 'idea', 'issue', 'suggestion', 'tester'],
      shortcut: FEEDBACK_KEY,
      allowInInput: true,
      when: () => !!deps.runtime,
      run: openFeedback,
    },
    {
      id: 'settings.open',
      title: 'Open Settings',
      group: 'Settings',
      keywords: ['preferences', 'options'],
      shortcut: SETTINGS_KEY,
      allowInInput: true,
      run: toggleSettings,
    },
    ...CATEGORIES.map((c): Command => ({
      id: `settings.open.${c.id}`,
      title: `Settings: ${c.label}`,
      group: 'Settings',
      keywords: [...c.keywords, c.about],
      run: () => openSettings(c.id),
    })),
    {
      id: 'workspace.resetLayout',
      title: 'Reset this workspace to default',
      group: 'Workspace',
      keywords: ['reset layout', 'default workspace', 'trade analyst', 'panels'],
      run: () => {
        resetWorkspaceLayout();
      },
    },
    {
      id: 'appearance.toggleUpDown',
      title: 'Switch up/down colours (Tessera, Jade · coral)',
      group: 'Appearance',
      run: () => setUpDown(ui().updown === 'tessera' ? 'jade-coral' : 'tessera'),
    },
    {
      id: 'appearance.density.compact',
      title: 'Row density: compact 24',
      group: 'Appearance',
      run: () => setDensity('compact'),
    },
    {
      id: 'appearance.density.default',
      title: 'Row density: default 28',
      group: 'Appearance',
      run: () => setDensity('default'),
    },
    {
      id: 'appearance.density.comfortable',
      title: 'Row density: comfortable 32',
      group: 'Appearance',
      run: () => setDensity('comfortable'),
    },
  ];
  const areas = AREAS.filter((a) => !a.accounts).map(areaCommand);
  const taken = new Set([...list, ...areas].flatMap((c) => (c.shortcut ? [c.shortcut] : [])));
  list.push(
    ...libraryKinds()
      .filter((d) => d.kind !== 'chart')
      .map((d) => panelCommand(d, taken)),
    ...areas,
  );
  const off = registry.registerAll(list);
  const offOrderKeys = registerOrderKeys(registry);
  return () => {
    offOrderKeys();
    off();
  };
}
