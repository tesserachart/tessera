import type { Approval, Attachment, Delivery, QueuedMessage, SessionMode, Suggestion } from '@tessera/protocol';
import { useLoadPending } from '@tessera/ui';
import { readerOf, sendBlock, sendable, type Reader } from '../../analyst/attachments.ts';
import { clearSentFiles, composerFiles, composerToasts, typedSince } from '../../analyst/composerFiles.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Transcript } from '../../app/agentTranscript.ts';
import { useHasTool, useTool } from '../../app/tools.ts';
import { useClock } from '../../app/clock.ts';
import { analystActivity, isWorking, type Activity } from '../../analyst/activity.ts';
import {
  ask,
  editQueued,
  removeQueued,
  resumeQueue,
  setSessionMode,
  setSessionModel,
  stopAnalyst,
} from '../../analyst/actions.ts';
import { FOLLOW_UP, dispatchMode } from '../../analyst/dispatch.ts';
import { beginEdit, endWithoutSave, stillQueued } from '../../analyst/queueEdit.ts';
import {
  useAnalyst,
  useCurrentSession,
  useCurrentTranscript,
  useExpired,
  usePending,
  newConversation,
} from '../../analyst/analystStore.ts';
import { DEFAULT_MODE } from '../../analyst/modes.ts';
import { NO_PROVIDER, pickApproval } from '../../shell/analyst.ts';
import { focusComposer } from '../../shell/composer.ts';
import { useSetting } from '../../state/runtimeSettings.ts';
import { uiStore, setComposerDraft } from '../../state/ui.ts';
import type { LogNotice } from '../../shell/AgentTranscript.tsx';
import { resolvePick, type ModelPick, type ProviderView } from './models.ts';
import { useProviders } from './providers.ts';
import { setNextMode, setPick, setQueuedEdit, useAgentsUi } from './store.ts';
import { read } from '../../app/store.ts';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const NO_QUEUE: readonly QueuedMessage[] = [];

const LEFT_QUEUE = {
  kept: 'That message left the queue before your edit was saved. Your edit is still here.',
  discarded: 'That message left the queue before your edit was saved.',
} as const;

export interface QueueView {
  items: readonly QueuedMessage[];
  held: boolean;
  editing: string | null;
  edit: (id: string) => void;
  cancelEdit: () => void;
  remove: (id: string) => void;
  resume: () => void;
}

export interface Chat {
  session: ReturnType<typeof useCurrentSession>;
  transcript: Transcript | null;
  providers: ProviderView[];
  pick: ModelPick | null;
  activity: Activity;
  working: boolean;
  waiting: readonly Approval[];
  expired: readonly Approval[];
  settled: boolean;
  replaying: boolean;
  sending: boolean;
  notices: readonly LogNotice[];
  unsent: boolean;
  reader: Reader | null;
  send: (text?: string, clear?: boolean, again?: readonly Attachment[]) => Promise<void>;
  submit: (alternate: boolean) => void;
  followUpMode: Delivery;
  queue: QueueView;
  stop: () => void;
  choose: (pick: ModelPick) => void;
  mode: SessionMode;
  canSetMode: boolean;
  setMode: (mode: SessionMode) => void;
  retry: (() => void) | undefined;
  followUp: (s: Suggestion) => void;
}

export function useChat(): Chat {
  const clock = useClock();
  const session = useCurrentSession();
  const transcript = useCurrentTranscript();
  const pending = usePending();
  const settled = useAnalyst((s) => s.approvals !== null);
  const sessionsKnown = useAnalyst((s) => s.sessions !== null);
  const { views: providers, list: listed } = useProviders();
  const canList = useHasTool('agent.list_providers');
  const lastPick = useAgentsUi((s) => s.pick);
  const pick = resolvePick(providers, session, lastPick);
  const activity = analystActivity(transcript, session);
  const working = isWorking(activity);
  const waiting = useMemo(() => pickApproval(pending, session), [pending, session]);
  const ended = useExpired();
  const expired = useMemo(() => pickApproval(ended, session), [ended, session]);
  const [sending, setSending] = useState(false);
  const [notices, setNotices] = useState<LogNotice[]>([]);
  const [unsent, setUnsent] = useState(false);
  const sessionId = session?.id ?? null;
  const probe = useTool('agent.get_transcript', sessionId === null ? null : { sessionId, limit: 1 });
  const replaying =
    sessionId !== null &&
    (transcript?.items.length ?? 0) === 0 &&
    (probe.isPending || (probe.data?.entries.length ?? 0) > 0);
  useLoadPending(!sessionsKnown);
  useLoadPending(!settled);
  useLoadPending(replaying);
  useEffect(() => setNotices([]), [sessionId]);
  const defaultMode = useSetting(DEFAULT_MODE);
  const nextMode = useAgentsUi((s) => s.nextMode);
  const canSetMode = useHasTool('agent.set_mode');
  const mode: SessionMode = session?.mode ?? nextMode ?? defaultMode;

  const note = useCallback(
    (text: string) => {
      const at = clock.now();
      setNotices((n) => [...n.slice(-4), { key: `notice-${String(at)}-${String(n.length)}`, at, text }]);
    },
    [clock],
  );

  const reader = readerOf(providers, session?.provider ?? pick?.provider ?? null);
  const followUpMode = useSetting(FOLLOW_UP);
  const items = session?.queue ?? NO_QUEUE;
  const held = session?.queueHeld ?? false;
  const edit = useAgentsUi((s) => s.editing);
  const draftNow = () => read(uiStore).composerDraft;
  const endEdit = useCallback((draft: string) => {
    setQueuedEdit(null);
    setComposerDraft(draft);
  }, []);
  useEffect(() => {
    if (!edit || stillQueued(edit, sessionId, items)) return;
    const { draft, end } = endWithoutSave(edit, read(uiStore).composerDraft);
    endEdit(draft);
    if (end !== 'clean') composerToasts.push({ tone: 'info', title: LEFT_QUEUE[end], key: 'queued-edit' });
  }, [edit, sessionId, items, endEdit]);

  const send = async (text = draftNow().trim(), clear = true, again?: readonly Attachment[], delivery?: Delivery) => {
    const typed = draftNow();
    const files = clear ? composerFiles() : [];
    const attachments = again ?? sendable(files);
    if ((!text && attachments.length === 0) || sending) return;
    if (!session && !pick) {
      if (providers.length > 0 || (canList && listed === undefined)) setUnsent(true);
      else note(NO_PROVIDER);
      return;
    }
    const block = clear ? sendBlock(files, reader) : null;
    if (block) {
      composerToasts.push({ tone: 'info', title: block, key: 'send-block' });
      return;
    }
    setSending(true);
    try {
      const out = await ask({ session, text, pick, mode: nextMode, attachments, delivery });
      if (out.notice) composerToasts.push({ tone: 'info', title: out.notice, key: 'steer-queued' });
      if (!session) setNextMode(null);
      if (clear) {
        setComposerDraft(typedSince(typed, draftNow()));
        clearSentFiles(files);
      }
    } catch (err) {
      note(errorText(err));
    } finally {
      setSending(false);
    }
  };
  const update = async () => {
    const text = draftNow().trim();
    if (!edit || !text || sending) return;
    setSending(true);
    try {
      await editQueued(edit.sessionId, edit.queuedId, text);
      endEdit(edit.setAside);
    } catch (err) {
      note(errorText(err));
    } finally {
      setSending(false);
    }
  };
  const submit = (alternate: boolean) => {
    if (edit) {
      void update();
      return;
    }
    const dispatch = dispatchMode({ running: working, followUp: followUpMode, alternate });
    void send(undefined, true, undefined, dispatch === 'start' ? undefined : dispatch);
  };
  const queue: QueueView = {
    items,
    held,
    editing: edit?.queuedId ?? null,
    edit: (id) => {
      const item = items.find((q) => q.id === id);
      if (!session || !item) return;
      setQueuedEdit(beginEdit(edit, session.id, item, draftNow()));
      setComposerDraft(item.text);
      focusComposer();
    },
    cancelEdit: () => {
      if (edit) endEdit(edit.setAside);
      focusComposer();
    },
    remove: (id) => {
      if (!session) return;
      if (edit?.queuedId === id) endEdit(edit.setAside);
      void removeQueued(session.id, id).catch((err: unknown) => note(errorText(err)));
    },
    resume: () => {
      if (session) void resumeQueue(session.id).catch((err: unknown) => note(errorText(err)));
    },
  };
  const stop = () => void stopAnalyst().catch((err: unknown) => note(errorText(err)));
  const choose = (next: ModelPick) => {
    setPick(next);
    if (!session) return;
    if (next.provider !== session.provider) {
      newConversation();
      focusComposer();
      return;
    }
    void setSessionModel(session.id, next.model, next.effort).catch((err: unknown) => note(errorText(err)));
  };
  const setMode = (next: SessionMode) => {
    if (!session) {
      setNextMode(next);
      return;
    }
    void setSessionMode(session.id, next).catch((err: unknown) => note(errorText(err)));
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  const lastQuestion = transcript?.items.findLast((i) => i.kind === 'user' && !i.steer);
  const again = !working && lastQuestion?.kind === 'user' ? lastQuestion : null;
  const retry = useMemo(
    () => (again === null ? undefined : () => void sendRef.current(again.text, false, again.attachments)),
    [again],
  );
  const followUp = useCallback((s: Suggestion) => {
    setComposerDraft(s.label);
    focusComposer();
  }, []);
  return {
    session,
    transcript,
    providers,
    pick,
    activity,
    working,
    waiting,
    expired,
    settled,
    replaying,
    sending,
    notices,
    unsent: unsent && !session && !pick,
    reader,
    send,
    submit,
    followUpMode,
    queue,
    stop,
    choose,
    mode,
    canSetMode,
    setMode,
    retry,
    followUp,
  };
}
