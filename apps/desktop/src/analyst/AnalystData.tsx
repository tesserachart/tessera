import { useEffect, useRef } from 'react';
import { useFaviconDraft } from '../app/favicon.ts';
import { notify } from '../app/host.ts';
import { useClock } from '../app/clock.ts';
import { useTopicEffect } from '../app/useTopic.ts';
import { workspaceContext } from '../workspace/controller.ts';
import { poppedPanel } from '../workspace/dock/popouts.ts';
import { notifyBody } from './activity.ts';
import {
  useAnalyst,
  useCurrentSession,
  applySessions,
  setProviders,
  applyApprovals,
  resetApprovals,
  applyEnvelope,
  beginTranscript,
  markSeen,
} from './analystStore.ts';
import { analystInView, useAnalystInView } from './focus.ts';

function analystPoppedOut(): boolean {
  const ctx = workspaceContext();
  return !!ctx && !ctx.popout && poppedPanel(ctx.layoutId, 'analyst') !== null;
}

export function AnalystData({ standalone = false }: { standalone?: boolean }) {
  const clock = useClock();
  useTopicEffect('agent.sessions', {}, (ev) => applySessions(ev));
  useTopicEffect('health', {}, (h) => setProviders(h.providers));
  const notified = useRef(new Set<string>());
  useTopicEffect(
    'approvals',
    {},
    (ev) => {
      applyApprovals(ev);
      if (ev.type !== 'requested' || ev.approval.status !== 'pending') return;
      const a = ev.approval;
      if (notified.current.has(a.id) || document.hasFocus() || (!standalone && analystPoppedOut())) return;
      notified.current.add(a.id);
      void notify({ title: 'Analyst needs you', body: notifyBody(a) }).catch(() => undefined);
    },
    { onResubscribed: () => resetApprovals() },
  );
  const sessionId = useCurrentSession()?.id ?? null;
  useTopicEffect(
    'agent.session',
    sessionId === null ? null : { sessionId },
    (env) => {
      if (env.sessionId !== sessionId) return;
      applyEnvelope(env, standalone || analystInView(), clock.now());
    },
    { onActive: () => sessionId !== null && beginTranscript(sessionId) },
  );
  const visible = useAnalystInView() || standalone;
  const unread = useAnalyst((st) => st.unread);
  useEffect(() => {
    if (visible && unread) markSeen();
  }, [visible, unread]);
  useFaviconDraft(useAnalyst((st) => (st.approvals ?? []).some((a) => a.risk === 'financial')));
  return null;
}
