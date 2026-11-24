import { useState } from 'react';
import { createOverlay } from '../app/overlay.ts';
import { useClock } from '../app/clock.ts';
import { failureText, refreshTools, runTool, type ToolInput, type ToolOutput } from '../app/tools.ts';
import { screenWords } from '../shell/deskWords.ts';

type LoginTool =
  | 'connections.add_rithmic'
  | 'connections.test_rithmic'
  | 'connections.reconnect'
  | 'connections.remove'
  | 'connections.set_order_entry'
  | 'intel.discard_source_draft'
  | 'connections.add_level_source'
  | 'connections.test_level_source'
  | 'connections.replace_rithmic'
  | 'connections.test_credential'
  | 'connections.set_enabled';

export const switchEdits = createOverlay();

export function orThrow<R extends { ok: boolean }>(r: R): R {
  if (!r.ok) throw new Error('refused');
  return r;
}

const LOGIN_TIMEOUT_MS = 65_000;

export const CONNECTION_READS = [
  'connections.list',
  'intel.list_sources',
  'connections.list_credentials',
  'intel.list_source_drafts',
] as const;

export function useConnectionCall() {
  const clock = useClock();
  const [since, setSince] = useState<number | null>(null);
  const run = async <N extends LoginTool>(
    name: N,
    input: ToolInput<N>,
  ): Promise<{ ok: true; out: ToolOutput<N> } | { ok: false; why: string }> => {
    setSince(clock.now());
    try {
      return { ok: true, out: await runTool(name, input, { timeoutMs: LOGIN_TIMEOUT_MS }) };
    } catch (e) {
      return { ok: false, why: screenWords(failureText(e), 'That did not go through. Try again.') };
    } finally {
      setSince(null);
      void refreshTools(...CONNECTION_READS);
    }
  };
  return { since, run };
}
