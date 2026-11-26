import { attempt, refreshTools, type ToolInput } from '../../app/tools.ts';

export const PULL_READS = ['market.list_pulls', 'market.saved_trades', 'runtime.data_info'];

export const EVERY_PULL = { days: 'all', limit: 1000 } as const;

type PullTool = 'market.pull_trades' | 'market.cancel_pull' | 'market.resume_pull' | 'market.release_pull';

export async function act<N extends PullTool>(name: N, input: ToolInput<N>): Promise<string | null> {
  const r = await attempt(name, input);
  void refreshTools(...PULL_READS, 'market.estimate_pull');
  return r.ok ? null : r.why;
}
