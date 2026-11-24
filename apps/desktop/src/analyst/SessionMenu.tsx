import type { AgentSessionSummary } from '@tessera/protocol';
import { Count, Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from '@tessera/ui';
import { useState } from 'react';
import { useHasTool } from '../app/tools.ts';
import { useNow } from '../app/runtimeContext.ts';
import { groupSessions, relTime } from '../shell/sessions.ts';
import { NEW_SESSION_KEY } from '../shell/keys.ts';
import { setProviderEnabled, useProviders } from '../areas/agents/providers.ts';
import { isWorking, waitingIn } from './activity.ts';
import { newSession } from './actions.ts';
import { useAnalyst, useCurrentSession, selectSession, setSheet } from './analystStore.ts';
import { newChatPlan } from './newChat.ts';
import { useAnalystStatus } from './status.ts';

function sessionWord(s: AgentSessionSummary, now: number): string {
  if (s.status === 'needs_you') return 'needs you';
  if (s.status === 'running') return 'running';
  return relTime(s.updatedAt, now);
}

function SessionRows({ sessions, current }: { sessions: readonly AgentSessionSummary[]; current: string }) {
  const now = useNow();
  const approvals = useAnalyst((s) => s.approvals) ?? [];
  return (
    <>
      {groupSessions(sessions).map((g, i) => (
        <div key={g.id} role="group" aria-label={g.label}>
          {i > 0 ? <MenuSeparator /> : null}
          <MenuLabel>{g.label}</MenuLabel>
          {g.sessions.map((s) => (
            <MenuItem
              key={s.id}
              current={s.id === current}
              hint={
                <span className="an-sess-hint">
                  {sessionWord(s, now)}
                  <Count n={waitingIn(approvals, s.id)} />
                </span>
              }
              onSelect={() => selectSession(s.id)}
            >
              <span className="an-sess-title">{s.title}</span>
            </MenuItem>
          ))}
        </div>
      ))}
    </>
  );
}

export function SessionMenu() {
  const session = useCurrentSession();
  const sessions = useAnalyst((s) => s.sessions) ?? [];
  const { views } = useProviders();
  const hasStart = useHasTool('agent.start_session');
  const plan = newChatPlan(views, hasStart, sessions[0]?.provider ?? null);
  const busy = isWorking(useAnalystStatus().activity);
  const [turningOn, setTurningOn] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  if (!session && sessions.length === 0) return null;
  const title = session?.title ?? '';
  const named = title.trim() !== '' && title.trim().toLowerCase() !== 'analyst';
  const ready = views.filter((p) => p.ready).map((p) => p.id);
  const reason = plan.kind === 'blocked' ? plan.reason : null;
  const turnOn = plan.kind === 'blocked' && plan.fix?.kind === 'turn-on' ? plan.fix.provider : null;
  const startNew = () => void newSession(ready).catch(() => undefined);
  const switchOn = (id: string) => {
    setTurningOn(id);
    setWhy(null);
    void setProviderEnabled(id, true).then((err) => {
      setTurningOn(null);
      setWhy(err);
    });
  };
  return (
    <>
      {session && plan.kind === 'start' ? (
        <Tooltip content="New chat" shortcut={NEW_SESSION_KEY}>
          <button
            type="button"
            className="dock-act"
            aria-label="New chat"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={startNew}
          >
            <Icon name="edit" />
          </button>
        </Tooltip>
      ) : null}
      <Menu>
        <Tooltip content={named ? title : 'Sessions'}>
          <MenuTrigger asChild>
            <button
              type="button"
              className="an-session"
              aria-label={session ? `Session: ${title}` : 'Sessions'}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="tt">{named && !busy ? title : 'Sessions'}</span>
              <Icon name="chevron-down" />
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent align="end" style={{ width: 300 }}>
          <SessionRows sessions={sessions} current={session?.id ?? ''} />
          <MenuSeparator />
          <MenuItem
            disabled={plan.kind !== 'start'}
            why={reason ?? undefined}
            shortcut={NEW_SESSION_KEY}
            onSelect={startNew}
          >
            New chat
          </MenuItem>
          {turnOn ? (
            <MenuItem
              disabled={turningOn !== null}
              onSelect={(e) => {
                e.preventDefault();
                switchOn(turnOn.id);
              }}
            >
              {turningOn === turnOn.id ? 'Turning on…' : `Turn on ${turnOn.name}`}
            </MenuItem>
          ) : null}
          {plan.kind === 'blocked' && plan.fix?.kind === 'settings' ? (
            <MenuItem onSelect={() => setSheet(true)}>Model settings…</MenuItem>
          ) : null}
          {why ? (
            <p className="an-sess-why err" role="alert">
              {why}
            </p>
          ) : null}
        </MenuContent>
      </Menu>
    </>
  );
}
