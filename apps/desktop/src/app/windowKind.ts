import { resolveTileKind } from '../workspace/tiles/registry.ts';

export function windowTileKind(kind: string): string {
  return resolveTileKind(kind === 'agent' ? 'analyst' : kind);
}
