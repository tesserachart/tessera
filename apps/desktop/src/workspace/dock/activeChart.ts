import type { DockviewApi } from 'dockview-react';
import { activateChart } from '../controller.ts';

export function installActiveChartFollow(
  api: Pick<DockviewApi, 'onDidActivePanelChange'>,
  layoutId: string,
  loadingLayout: () => boolean = () => false,
): () => void {
  const sub = api.onDidActivePanelChange(({ panel }) => {
    if (!panel || loadingLayout() || panel.view.contentComponent !== 'chart') return;
    activateChart(layoutId, panel.id);
  });
  return () => sub.dispose();
}
