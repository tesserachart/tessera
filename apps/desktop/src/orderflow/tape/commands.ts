import type { Command } from '../../commands/registry.ts';
import { workspaceContext } from '../../workspace/controller.ts';
import { openTileSettings } from '../../workspace/dock/tileSettingsUi.ts';
import { focusedTileKeys, tileKeys } from '../tileKeys.ts';

function tapePanelId(): string | null {
  const api = workspaceContext()?.api;
  if (!api) return null;
  const el = document.activeElement?.closest('.tape-tile') ?? null;
  const panels = api.panels.filter((p) => p.api.component === 'tape');
  return (panels.find((p) => el && p.view.content.element.contains(el)) ?? panels[0])?.id ?? null;
}

export function tapeCommands(): Command[] {
  const inWorkspace = () => workspaceContext() !== null;
  return [
    {
      id: 'tape.settings',
      title: 'Time & sales settings…',
      group: 'Time & sales',
      keywords: ['t&s', 'tape', 'filter', 'min size', 'highlight', 'speed', 'slow', 'aggregate', 'milliseconds'],
      when: () => inWorkspace() && tapePanelId() !== null,
      run: () => {
        const id = tapePanelId();
        if (id) openTileSettings(id);
      },
    },
    {
      id: 'tape.pause',
      title: 'Pause or resume time & sales',
      group: 'Time & sales',
      keywords: ['t&s', 'tape', 'hold', 'freeze'],
      shortcut: 'space',
      zone: 'tape',
      when: () => tileKeys('tape') !== null,
      run: () => tileKeys('tape')?.toggle(),
    },
    {
      id: 'tape.newest',
      title: 'Time & sales: the newest prints',
      group: 'Time & sales',
      keywords: ['t&s', 'tape', 'resume', 'top', 'latest'],
      shortcut: 'home',
      zone: 'tape',
      when: () => tileKeys('tape') !== null,
      run: () => tileKeys('tape')?.newest(),
    },
    {
      id: 'tape.resume',
      title: 'Resume time & sales',
      group: 'Time & sales',
      shortcut: 'escape',
      zone: 'tape',
      hidden: true,
      when: () => focusedTileKeys('tape')?.paused() ?? false,
      run: () => focusedTileKeys('tape')?.newest(),
    },
  ];
}
