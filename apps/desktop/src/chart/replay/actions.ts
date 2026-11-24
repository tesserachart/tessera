import type { ReplayState } from '@tessera/protocol';
import { queryClient } from '../../app/queries.ts';
import { makeStore, patch, read } from '../../app/store.ts';
import { runTool, toolKey } from '../../app/tools.ts';
import { replayedContract } from '../../market/instruments.ts';
import { showOnChart } from '../../workspace/controller.ts';
import type { DayChoice } from './model.ts';

export interface ChartTarget {
  readonly layoutId: string;
  readonly tileId: string;
}

interface ReplayDesk {
  readonly picker: ChartTarget | null;
  readonly live: Readonly<Record<string, string>>;
}

export const replayDesk = makeStore<ReplayDesk>({ picker: null, live: {} });

export const openReplayPicker = (picker: ChartTarget) => patch(replayDesk, { picker });
export const closeReplayPicker = () => patch(replayDesk, { picker: null });

export function liveOf(instrument: string, state: ReplayState | null = null): string {
  return read(replayDesk).live[instrument] ?? state?.contract ?? replayedContract(instrument) ?? instrument;
}

function known(state: ReplayState, live: string): void {
  queryClient.setQueryData(toolKey('market.get_replays', { instrument: state.instrument }), { replays: [state] });
  patch(replayDesk, (d) => ({ live: { ...d.live, [state.instrument]: live } }));
}

function closeQuietly(instrument: string): void {
  runTool('market.close_replay', { instrument }).catch(() => undefined);
}

export async function startReplay(target: ChartTarget, day: DayChoice, charted: string): Promise<void> {
  const state = await runTool('market.open_replay', {
    instrument: day.instrument,
    source: day.source,
    tradeDate: day.tradeDate,
  });
  const replaced = replayedContract(charted) === null ? null : charted;
  known(state, replaced === null ? charted : liveOf(replaced));
  await showOnChart(state.instrument, target);
  if (replaced !== null) closeQuietly(replaced);
}

export async function controlReplay(state: ReplayState, change: { playing?: boolean; speed?: number }): Promise<void> {
  known(
    await runTool('market.control_replay', { instrument: state.instrument, ...change }),
    liveOf(state.instrument, state),
  );
}

export async function jumpReplay(target: ChartTarget, state: ReplayState, at: number): Promise<void> {
  const next = await runTool('market.control_replay', { instrument: state.instrument, at });
  known(next, liveOf(state.instrument, state));
  await showOnChart(next.instrument, target);
}

export async function backToLive(target: ChartTarget, instrument: string, state: ReplayState | null): Promise<void> {
  await showOnChart(liveOf(instrument, state), target);
  closeQuietly(instrument);
}
