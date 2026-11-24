import type { ToolMap } from '@tessera/protocol';

type ToolName = keyof ToolMap;

export type CommandReach = { tools: readonly ToolName[] } | { ephemeral: string } | { user: string };

export const COMMAND_TOOLS: Readonly<Record<string, CommandReach>> = {
  'agent.stop': { user: 'the user’s stop key: an agent never stops a session (agent.interrupt is the user’s)' },
  'agent.newSession': {
    user: 'an agent never starts a session: each turn is its own loop-guard budget (agent.start_session is the user’s)',
  },
  'agent.focusComposer': { ephemeral: 'puts the keyboard in the analyst’s own input' },
  'agent.focusComposer.slash': { ephemeral: 'puts the keyboard in the analyst’s own input' },
  'palette.open': { ephemeral: 'opens the palette; every line of it has its own entry here' },

  'chart.changeSymbol': { tools: ['chart.set_symbol', 'market.search_instruments'] },
  'chart.newTab': { tools: ['workspace.open_tile', 'market.search_instruments'] },
  'chart.split': { tools: ['workspace.open_tile'] },
  'chart.addIndicator': { tools: ['chart.add_layer', 'chart.list_layer_kinds'] },
  'chart.timeframe.*': { tools: ['chart.set_timeframe'] },
  'chart.orderflow.*': { tools: ['chart.add_layer', 'chart.update_layer'] },
  'chart.draw.*': { tools: ['chart.add_drawing'] },
  'chart.drawings.undo': { tools: ['chart.undo_drawing'] },
  'chart.drawings.redo': { tools: ['chart.redo_drawing'] },
  'chart.drawings.removeAll': { tools: ['chart.remove_drawing'] },

  'view.trade': { tools: ['workspace.focus_tile', 'workspace.open_tile', 'workspace.close_tile'] },
  'view.analyst': { tools: ['workspace.focus_tile', 'workspace.open_tile', 'workspace.close_tile'] },
  'view.markets': { tools: ['ui.show_area'] },
  'tile.show.*': { tools: ['workspace.focus_tile', 'workspace.open_tile'] },
  'connections.open': { tools: ['ui.show_area', 'connections.list'] },
  'connections.add': { tools: ['ui.show_area'] },
  'connections.exchanges': { tools: ['ui.show_area', 'settings.get'] },
  'view.edge.*': { tools: ['workspace.set_view'] },
  'view.focus': { tools: ['workspace.set_view'] },
  'view.maximize': { tools: ['workspace.maximize_tile'] },
  'view.closeTab': { tools: ['workspace.close_tile'] },
  'view.nextTab': { ephemeral: 'moves the keyboard between tabs; workspace.focus_tile shows a tile' },
  'view.previousTab': { ephemeral: 'moves the keyboard between tabs; workspace.focus_tile shows a tile' },
  'view.nextGroup': { ephemeral: 'moves the keyboard between panels; workspace.focus_tile shows a tile' },
  'view.previousGroup': { ephemeral: 'moves the keyboard between panels; workspace.focus_tile shows a tile' },
  'view.popout.*': { user: 'a window opens only on the user’s own click (the browser and the OS refuse others)' },
  'workspace.switch': { tools: ['ui.show_workspace', 'layout.list'] },
  'workspace.save': { tools: ['workspace.save'] },
  'workspace.revert': { tools: ['workspace.revert'] },
  'workspace.arrange': { tools: ['workspace.apply_preset', 'chart.set_link', 'workspace.set_view'] },
  'workspace.resetLayout': { tools: ['workspace.apply_preset'] },

  'trade.breakeven': { tools: ['orders.breakeven'] },
  'chart.breakeven': { tools: ['orders.breakeven'] },
  'trade.orderHotkeys.settings': { tools: ['ui.show_area', 'settings.get'] },
  'copy.groups': { tools: ['ui.show_area', 'copy.list'] },
  'copy.stopAll': { tools: ['copy.list', 'copy.disable'] },
  'trade.orderHotkeys.off': { tools: ['settings.set'] },
  'chart.order.buyMarket': { tools: ['orders.submit'] },
  'chart.order.buyBid': { tools: ['orders.submit'] },
  'chart.order.sellMarket': { tools: ['orders.submit'] },
  'chart.order.sellAsk': { tools: ['orders.submit'] },
  'chart.order.reverse': { tools: ['orders.reverse'] },
  'chart.order.flatten': { tools: ['orders.flatten'] },
  'chart.order.cancelAll': { tools: ['orders.cancel_all'] },

  'dom.settings': { tools: ['workspace.set_tile_settings'] },
  'dom.centre': { ephemeral: 'scrolls the ladder to the last price' },
  'dom.rowUp': { ephemeral: 'scrolls the ladder' },
  'dom.rowDown': { ephemeral: 'scrolls the ladder' },
  'dom.pageUp': { ephemeral: 'scrolls the ladder' },
  'dom.pageDown': { ephemeral: 'scrolls the ladder' },
  'dom.escape': { ephemeral: 'ends the user’s own drag or press on the ladder' },
  'dom.cancelAll': { tools: ['orders.cancel_all'] },
  'dom.flatten': { tools: ['orders.flatten'] },
  'dom.breakeven': { tools: ['orders.breakeven'] },
  'dom.order.buyMarket': { tools: ['orders.submit'] },
  'dom.order.buyBid': { tools: ['orders.submit'] },
  'dom.order.sellMarket': { tools: ['orders.submit'] },
  'dom.order.sellAsk': { tools: ['orders.submit'] },
  'dom.order.reverse': { tools: ['orders.reverse'] },
  'dom.order.flatten': { tools: ['orders.flatten'] },
  'dom.order.cancelAll': { tools: ['orders.cancel_all'] },
  'tape.settings': { tools: ['workspace.set_tile_settings'] },
  'tape.pause': { ephemeral: 'holds the list still while the user reads it' },
  'tape.newest': { ephemeral: 'scrolls the list to the newest prints' },
  'tape.resume': { ephemeral: 'scrolls the list to the newest prints' },

  'alerts.new': { tools: ['alerts.create', 'market.get_quote'] },
  'sounds.toggleMute': {
    user: 'the trader’s sounds are theirs alone: a fill or a stop they trade by ear never goes quiet behind their back',
  },

  'area.*': { tools: ['ui.show_area'] },
  'feedback.open': { tools: ['feedback.context', 'feedback.send', 'feedback.write_up'] },
  'settings.open': { tools: ['ui.show_area'] },
  'settings.open.*': { tools: ['ui.show_area'] },
  'appearance.toggleUpDown': { tools: ['settings.set'] },
  'appearance.density.*': { tools: ['settings.set'] },
};

export function reachOf(id: string): CommandReach | null {
  const own = COMMAND_TOOLS[id];
  if (own) return own;
  let best: { len: number; reach: CommandReach } | null = null;
  for (const [key, reach] of Object.entries(COMMAND_TOOLS)) {
    if (!key.endsWith('.*')) continue;
    const prefix = key.slice(0, -1);
    if (id.startsWith(prefix) && (!best || prefix.length > best.len)) best = { len: prefix.length, reach };
  }
  return best?.reach ?? null;
}
