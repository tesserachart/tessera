import type { IDockviewPanelProps } from 'dockview-react';
import { IndicatorsPanel } from '../../areas/indicators/IndicatorsPanel.tsx';
import { registerTile } from './registry.ts';

export function IndicatorsTile(_props: IDockviewPanelProps) {
  return (
    <div className="tile indicators-tile" data-view="indicators">
      <IndicatorsPanel />
    </div>
  );
}

registerTile({
  kind: 'indicators',
  private: true,
  title: 'Indicators',
  component: IndicatorsTile,
  icon: 'indicators',
  home: 'centre',
  singleton: true,
  order: 4,
  keywords: ['studies', 'custom indicator', 'javascript', 'script', 'levels', 'templates', 'fx'],
});
