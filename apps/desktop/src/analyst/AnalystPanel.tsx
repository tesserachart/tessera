import type { Approval } from '@tessera/protocol';
import { Loaded } from '@tessera/ui';
import { normalizeEpochMs } from '@tessera/protocol';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useHasTool } from '../app/tools.ts';
import { AgentComposer } from '../areas/agents/AgentComposer.tsx';
import { ConnectAi } from '../areas/agents/ConnectAi.tsx';
import { Conversation, type ConversationHandle } from '../areas/agents/Conversation.tsx';
import { useChat } from '../areas/agents/useChat.ts';
import { agentProvider, emptyAction } from '../shell/analyst.ts';
import { AnalystSample } from './AnalystSample.tsx';
import { useAnalyst } from './analystStore.ts';
import { attachFiles } from './composerFiles.ts';
import { focusApprovalCard } from './focus.ts';
import { InlineCard } from './InlineCard.tsx';
import { JumpBar, type Place } from './JumpBar.tsx';
import { Brief, ChartOpening } from './Opening.tsx';
import { useChartSight } from './sight.ts';
import { SettingsSheet } from './SettingsSheet.tsx';
import { useFileDrop } from './useFileDrop.ts';

export function AnalystBody({ head }: { head?: ReactNode }) {
  const chat = useChat();
  const { session, transcript, working } = chat;
  const drop = useFileDrop((files) => void attachFiles(files, chat.reader));
  const sessions = useAnalyst((s) => s.sessions);
  const health = useAnalyst((s) => s.providers);
  const provider = agentProvider(health, session);
  const canStart = useHasTool('agent.start_session');
  const empty = emptyAction(health, session, canStart);
  const sight = useChartSight();
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const conversation = useRef<ConversationHandle>(null);
  const [out, setOut] = useState<ReadonlyMap<string, Place>>(new Map());

  const items = transcript?.items.length ?? 0;
  const titleOf = useCallback(
    (id: string | null) => (sessions ?? []).find((s) => s.id === id)?.title ?? null,
    [sessions],
  );
  const renderApproval = useCallback(
    (a: Approval) => <InlineCard approval={a} sessionTitle={titleOf(a.sessionId)} />,
    [titleOf],
  );

  const noModel = !session && items === 0 && empty?.kind === 'connect';
  const opening = !noModel && !working && provider?.status === 'ok' && items === 0;
  const last = session ? normalizeEpochMs(session.updatedAt) : null;
  const brief = useMemo(
    () => (working || provider?.status !== 'ok' ? null : <Brief symbol={sight.symbol} last={last} />),
    [working, provider?.status, sight.symbol, last],
  );
  return (
    <section
      className="an"
      aria-label="Analyst"
      data-focus-zone="agent"
      data-has-draft={chat.waiting.some((a) => a.kind === 'financial') || undefined}
      {...drop.handlers}
    >
      {head}
      <div className="an-body" ref={setBody}>
        <Conversation
          narrow
          handle={conversation}
          sessionId={session?.id ?? null}
          transcript={transcript}
          waiting={chat.waiting}
          expired={chat.expired}
          settled={chat.settled}
          working={working}
          activity={chat.activity}
          notices={chat.notices}
          renderApproval={renderApproval}
          onFollowUp={chat.followUp}
          onRetry={chat.retry}
          onOutOfView={setOut}
          tail={brief}
          empty={
            noModel ? (
              <ConnectAi waiting={chat.unsent} />
            ) : opening && !chat.replaying ? (
              <ChartOpening session={session} />
            ) : null
          }
        />
        <JumpBar
          waiting={chat.waiting}
          out={out}
          onJump={(a) => {
            conversation.current?.scrollToKey(`ap:${a.id}`);
            let tries = 0;
            const focus = () => {
              if (body && focusApprovalCard(body, a.id)) return;
              if (++tries < 10) requestAnimationFrame(focus);
            };
            requestAnimationFrame(focus);
          }}
        />
        <SettingsSheet container={body} />
      </div>
      {sight.sees && !opening ? (
        <p className="an-sees" title={sight.sees}>
          {sight.sees}
        </p>
      ) : null}
      <AgentComposer
        narrow
        providers={chat.providers}
        pick={chat.pick}
        sessionProvider={session?.provider ?? null}
        reader={chat.reader}
        dropping={drop.over}
        working={working}
        sending={chat.sending}
        onPick={chat.choose}
        mode={chat.mode}
        onMode={chat.canSetMode ? chat.setMode : undefined}
        followUp={chat.followUpMode}
        queue={chat.queue}
        onSend={chat.submit}
        onStop={chat.stop}
      />
    </section>
  );
}

export function AnalystPanel({ head }: { head?: ReactNode }) {
  return (
    <Loaded label="Loading the analyst" sample={<AnalystSample head={head} />}>
      <AnalystBody head={head} />
    </Loaded>
  );
}
