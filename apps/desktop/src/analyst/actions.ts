import type { AgentSendOutput, AgentSessionSummary, Attachment, Delivery, SessionMode } from '@tessera/protocol';
import { selectCurrent, selectSession, analystStore, newConversation, editSession } from './analystStore.ts';
import { read } from '../app/store.ts';
import { runTool, type ToolInput } from '../app/tools.ts';
import { sayFailed } from '../workspace/dock/deskToasts.ts';

export async function startSession(provider: string): Promise<string> {
  const out = await runTool('agent.start_session', { preset: 'Trader', provider });
  selectSession(out.session.id);
  return out.session.id;
}

export function renameSession(sessionId: string, title: string): Promise<void> {
  return editSession(sessionId, 'title', title, () => runTool('agent.rename_session', { sessionId, title })).catch(
    (err: unknown) => sayFailed('The session could not be renamed', err),
  );
}

export function deleteSession(sessionId: string): Promise<void> {
  return runTool('agent.delete_session', { sessionId }).then(
    () => undefined,
    (err: unknown) => sayFailed('The session could not be deleted', err),
  );
}

export async function stopAnalyst(): Promise<boolean> {
  const session = selectCurrent(read(analystStore));
  if (!session) return false;
  const out = await runTool('agent.interrupt', { sessionId: session.id });
  return out.interrupted;
}

export function stopFromCommand(): void {
  void stopAnalyst().catch((err: unknown) => sayFailed('The analyst could not be stopped', err));
}

export function newSession(readyProviders: readonly string[]): Promise<string | null> {
  if (readyProviders.length === 0) return Promise.resolve(null);
  newConversation();
  return Promise.resolve('new');
}

export interface TurnPick {
  provider: string;
  model: string | null;
  effort: string | null;
}

export async function ask(opts: {
  session: AgentSessionSummary | null;
  text: string;
  pick: TurnPick | null;
  mode?: SessionMode | null;
  attachments?: readonly Attachment[];
  delivery?: Delivery;
}): Promise<AgentSendOutput> {
  const send = (sessionId: string): ToolInput<'agent.send'> => {
    const input: ToolInput<'agent.send'> = { sessionId, text: opts.text };
    if (opts.attachments?.length) input.attachments = [...opts.attachments];
    if (opts.delivery) input.delivery = opts.delivery;
    return input;
  };
  if (opts.session) return runTool('agent.send', send(opts.session.id));
  if (!opts.pick) throw new Error('No model is on yet. Turn one on, then ask again.');
  const input: ToolInput<'agent.start_session'> = { preset: 'Trader', provider: opts.pick.provider };
  if (opts.pick.model) input.model = opts.pick.model;
  if (opts.pick.effort) input.effort = opts.pick.effort;
  if (opts.mode) input.mode = opts.mode;
  const out = await runTool('agent.start_session', input);
  selectSession(out.session.id);
  return runTool('agent.send', send(out.session.id));
}

export async function editQueued(sessionId: string, queuedId: string, text: string): Promise<void> {
  await runTool('agent.edit_queued', { sessionId, queuedId, text });
}

export async function removeQueued(sessionId: string, queuedId: string): Promise<void> {
  await runTool('agent.remove_queued', { sessionId, queuedId });
}

export async function resumeQueue(sessionId: string): Promise<void> {
  await runTool('agent.resume_queue', { sessionId });
}

export async function setSessionModel(sessionId: string, model: string | null, effort: string | null): Promise<void> {
  const input: ToolInput<'agent.set_model'> = { sessionId };
  if (model) input.model = model;
  if (effort) input.effort = effort;
  await editSession(sessionId, 'model', { model, effort }, () => runTool('agent.set_model', input));
}

export async function setSessionMode(sessionId: string, mode: SessionMode): Promise<void> {
  await editSession(sessionId, 'mode', mode, () => runTool('agent.set_mode', { sessionId, mode }));
}
