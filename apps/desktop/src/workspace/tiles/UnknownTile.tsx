import type { IDockviewPanelProps } from 'dockview-react';
import { registerTile, UNKNOWN_TILE, type UnknownTileParams } from './registry.ts';

export function UnknownTile({ params }: IDockviewPanelProps<UnknownTileParams>) {
  return (
    <div className="tile">
      <div className="tile-empty">
        This <b>{params.originalComponent}</b> tile needs a newer Tessera. Its place and settings are kept.
      </div>
    </div>
  );
}

registerTile({ kind: UNKNOWN_TILE, title: 'Unavailable tile', icon: 'update', component: UnknownTile });
