import type { IconName } from '@tessera/ui';

export function toolIcon(tool: string): IconName {
  const ns = tool.split('.')[0] ?? '';
  if (ns === 'chart') return 'chart';
  if (ns === 'indicators') return 'indicators';
  if (ns === 'market' || ns === 'orders' || ns === 'portfolio' || ns === 'broker') return 'ticket';
  if (ns === 'levels' || ns === 'intel' || ns === 'concepts') return 'levels';
  if (ns === 'drawings') return 'trend-line';
  if (ns === 'settings') return 'settings';
  if (ns === 'appearance') return 'appearance';
  if (ns === 'workspace' || ns === 'layout' || ns === 'areas') return 'desk';
  if (ns === 'research' || ns === 'strategy') return 'research';
  if (ns === 'journal') return 'journal';
  if (ns === 'connections') return 'accounts';
  return 'command';
}
