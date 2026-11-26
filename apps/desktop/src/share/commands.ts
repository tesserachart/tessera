import type { Command } from '../commands/registry.ts';
import { SHARE_KEY } from '../shell/keys.ts';
import { activeChartTarget } from '../workspace/controller.ts';
import { askForSharedLink } from './open.ts';
import { shareChart } from './store.ts';

const SHARE_CHART = 'chart.share';
const OPEN_SHARED_LINK = 'share.openLink';

export function shareChartCommand(): Command {
  return {
    id: SHARE_CHART,
    title: 'Share chart…',
    group: 'Chart',
    keywords: ['share', 'picture', 'screenshot', 'image', 'copy', 'link', 'export'],
    shortcut: SHARE_KEY,
    when: () => activeChartTarget() !== null,
    run: () => {
      const target = activeChartTarget();
      if (target) void shareChart(target);
    },
  };
}

export function openSharedLinkCommand(): Command {
  return {
    id: OPEN_SHARED_LINK,
    title: 'Open a shared link…',
    group: 'General',
    keywords: ['share', 'link', 'paste', 'import', 'indicator', 'template', 'workspace', 'add'],
    run: askForSharedLink,
  };
}
