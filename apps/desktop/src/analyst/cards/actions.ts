import type { CardAction, ToolName } from '@tessera/protocol';
import { failureText, runToolResult } from '../../app/tools.ts';

export async function runCardAction(a: CardAction): Promise<string | null> {
  try {
    const r = await runToolResult(a.tool as ToolName, a.input as never);
    return r.ok ? null : (r.error?.message ?? 'It did not go through.');
  } catch (e) {
    return failureText(e);
  }
}
