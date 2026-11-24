import { refreshTools, runToolResult } from '../../app/tools.ts';

export const PULL_READS = ['market.list_pulls', 'market.saved_trades', 'runtime.data_info'];

export const EVERY_PULL = { days: 'all', limit: 1000 } as const;

type PullTool = 'market.pull_trades' | 'market.cancel_pull' | 'market.resume_pull' | 'market.release_pull';

export async function act<N extends PullTool>(
  name: N,
  input: Parameters<typeof runToolResult<N>>[1],
): Promise<string | null> {
  try {
    const r = await runToolResult(name, input);
    return r.ok ? null : (r.error?.message ?? 'It did not go through.');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    void refreshTools(...PULL_READS, 'market.estimate_pull');
  }
}
