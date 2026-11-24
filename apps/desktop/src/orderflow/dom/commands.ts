import type { Command } from '../../commands/registry.ts';
import { BREAKEVEN_KEY } from '../../shell/keys.ts';
import { workspaceContext } from '../../workspace/controller.ts';
import { openTileSettings } from '../../workspace/dock/tileSettingsUi.ts';
import { focusedTileKeys, tileKeys } from '../tileKeys.ts';

function domPanelId(): string | null {
  const api = workspaceContext()?.api;
  if (!api) return null;
  const el = document.activeElement?.closest('.dom-tile') ?? null;
  const panels = api.panels.filter((p) => p.api.component === 'dom');
  return (panels.find((p) => el && p.view.content.element.contains(el)) ?? panels[0])?.id ?? null;
}

export function domCommands(): Command[] {
  const inWorkspace = () => workspaceContext() !== null;
  const focused = () => focusedTileKeys('dom') !== null;
  const scroll = (id: string, title: string, shortcut: string, run: () => void): Command => ({
    id,
    title,
    group: 'DOM',
    shortcut,
    zone: 'dom',
    hidden: true,
    when: focused,
    run,
  });
  return [
    {
      id: 'dom.settings',
      title: 'DOM settings…',
      group: 'DOM',
      keywords: ['ladder', 'row size', 'volume column', 'auto-centre'],
      when: () => inWorkspace() && domPanelId() !== null,
      run: () => {
        const id = domPanelId();
        if (id) openTileSettings(id);
      },
    },
    {
      id: 'dom.centre',
      title: 'Centre the ladder on the last price',
      group: 'DOM',
      keywords: ['dom', 'recentre', 'auto-centre'],
      shortcut: 'space',
      zone: 'dom',
      when: () => tileKeys('dom') !== null,
      run: () => tileKeys('dom')?.centre(),
    },
    scroll('dom.rowUp', 'Ladder up a row', 'arrowup', () => focusedTileKeys('dom')?.scroll(1)),
    scroll('dom.rowDown', 'Ladder down a row', 'arrowdown', () => focusedTileKeys('dom')?.scroll(-1)),
    scroll('dom.pageUp', 'Ladder up a page', 'pageup', () => focusedTileKeys('dom')?.page(1)),
    scroll('dom.pageDown', 'Ladder down a page', 'pagedown', () => focusedTileKeys('dom')?.page(-1)),
    {
      id: 'dom.escape',
      title: 'End the drag or press on the ladder',
      group: 'DOM',
      shortcut: 'escape',
      zone: 'dom',
      hidden: true,
      when: () => focusedTileKeys('dom')?.holding() ?? false,
      run: () => focusedTileKeys('dom')?.escape(),
    },
    {
      id: 'dom.cancelAll',
      title: 'Cancel all orders on the ladder’s instrument',
      group: 'DOM',
      keywords: ['dom', 'cancel', 'exit'],
      shortcut: 'mod+shift+backspace',
      zone: 'dom',
      hidden: true,
      when: () => focusedTileKeys('dom')?.sends() ?? false,
      run: () => focusedTileKeys('dom')?.cancelAll(),
    },
    {
      id: 'dom.flatten',
      title: 'Flatten the ladder’s instrument',
      group: 'DOM',
      keywords: ['dom', 'close position', 'exit'],
      shortcut: 'mod+shift+f',
      zone: 'dom',
      hidden: true,
      when: () => focusedTileKeys('dom')?.sends() ?? false,
      run: () => focusedTileKeys('dom')?.flatten(),
    },
    {
      id: 'dom.breakeven',
      title: 'Breakeven: the ladder’s position’s stop to its entry',
      group: 'DOM',
      keywords: ['dom', 'breakeven', 'stop', 'exit'],
      shortcut: BREAKEVEN_KEY,
      zone: 'dom',
      hidden: true,
      when: () => focusedTileKeys('dom')?.sends() ?? false,
      run: () => focusedTileKeys('dom')?.breakeven(),
    },
  ];
}
