export const TRADING_STATE_ATTR = 'data-trading-state';

export type Unquiet = () => void;

type Quiet = () => Unquiet;

const quieters = new Map<string, Quiet>();

export function quietWhileSharing(tileId: string, quiet: Quiet): () => void {
  quieters.set(tileId, quiet);
  return () => {
    if (quieters.get(tileId) === quiet) quieters.delete(tileId);
  };
}

export function quietChart(tileId: string): Unquiet {
  return quieters.get(tileId)?.() ?? (() => undefined);
}
