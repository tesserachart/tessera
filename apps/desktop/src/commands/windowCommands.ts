import { drawingCommands } from '../chart/drawings/commands.ts';
import { shareChartCommand } from '../share/commands.ts';
import { TRADE_KEY } from '../shell/keys.ts';
import { activeChartTarget } from '../workspace/controller.ts';
import { tradeKey } from '../workspace/tiles/trade.ts';
import type { CommandRegistry } from './registry.ts';

export function registerBuiltinWindowCommands(registry: CommandRegistry): () => void {
  return registry.registerAll([
    {
      id: 'view.trade',
      title: 'Trade: show, focus or hide',
      group: 'View',
      shortcut: TRADE_KEY,
      allowInInput: true,
      when: () => activeChartTarget() !== null,
      run: tradeKey,
    },
    shareChartCommand(),
    ...drawingCommands(),
  ]);
}
