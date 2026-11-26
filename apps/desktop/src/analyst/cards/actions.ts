import type { CardAction, ToolName } from '@tessera/protocol';
import { attempt } from '../../app/tools.ts';

export async function runCardAction(a: CardAction): Promise<string | null> {
  const r = await attempt(a.tool as ToolName, a.input as never);
  return r.ok ? null : r.why;
}
