import { failureText, useTool, valueOf } from '../app/tools.ts';
import { useHasUserConnectionTools } from './useConnections.ts';

export interface RithmicDirectory {
  systems: string[];
  gateways: string[];
  problem: string | null;
  loading: boolean;
}

const KEEP_MS = 10 * 60_000;

export function useRithmicDirectory(system: string): RithmicDirectory {
  const has = useHasUserConnectionTools();
  const named = system.trim();
  const keep = { keepFor: KEEP_MS };
  const all = useTool('connections.rithmic_directory', has ? {} : null, keep);
  const of = useTool('connections.rithmic_directory', has && named ? { system: named } : null, keep);
  const failed = (r: typeof all) => (r.isError ? failureText(r.error) : null);
  const listed = valueOf(all);
  const ofSystem = valueOf(of);
  return {
    systems: listed?.systems ?? [],
    gateways: named ? (ofSystem?.gateways ?? []) : [],
    problem: listed?.problem ?? failed(all) ?? (named ? (ofSystem?.problem ?? failed(of)) : null),
    loading: all.isPending || (!!named && of.isPending),
  };
}
