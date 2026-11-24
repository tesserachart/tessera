import type { IDockviewPanelProps } from 'dockview-react';
import { CopyPanel } from '../../areas/copy/CopyPanel.tsx';
import { registerTile } from './registry.ts';

export function CopyTile(_props: IDockviewPanelProps) {
  return (
    <div className="tile copy-tile" data-focus-zone="copy" data-view="copy">
      <CopyPanel />
    </div>
  );
}

registerTile({
  kind: 'copy',
  private: true,
  title: 'Trade copier',
  component: CopyTile,
  icon: 'copier',
  home: 'centre',
  singleton: true,
  order: 3,
});
