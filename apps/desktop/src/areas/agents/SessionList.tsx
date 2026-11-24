import type { AgentSessionSummary } from '@tessera/protocol';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Count,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  ScrollArea,
  Tooltip,
  cx,
} from '@tessera/ui';
import { useState } from 'react';
import { useNow } from '../../app/runtimeContext.ts';
import {
  useAnalyst,
  usePending,
  useCurrentSession,
  analystStore,
  newConversation,
  selectSession,
} from '../../analyst/analystStore.ts';
import { waitingIn } from '../../analyst/activity.ts';
import { relTime } from '../../shell/sessions.ts';
import { groupSessions } from './sessions.ts';
import { read } from '../../app/store.ts';
import { deleteSession, renameSession } from '../../analyst/actions.ts';

function RenameField({ session, onDone }: { session: AgentSessionSummary; onDone: () => void }) {
  const [title, setTitle] = useState(session.title);
  const commit = () => {
    const next = title.trim();
    onDone();
    if (next && next !== session.title) void renameSession(session.id, next);
  };
  return (
    <input
      className="ag-rename"
      aria-label="Session title"
      value={title}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
    />
  );
}

function DeleteAsk({ session, onDone }: { session: AgentSessionSummary; onDone: () => void }) {
  return (
    <div className="ag-ask" role="group" aria-label="Delete this session?">
      <span className="tx">Delete this session and its conversation?</span>
      <span className="act">
        <Button
          size="s"
          variant="destructive"
          autoFocus
          onClick={() => {
            onDone();
            if (read(analystStore).selected === session.id) newConversation();
            void deleteSession(session.id);
          }}
        >
          Delete
        </Button>
        <Button size="s" variant="quiet" onClick={onDone}>
          Keep
        </Button>
      </span>
    </div>
  );
}

function SessionRow({
  session,
  current,
  now,
  waiting,
}: {
  session: AgentSessionSummary;
  current: boolean;
  now: number;
  waiting: number;
}) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'delete'>('idle');
  if (mode === 'rename')
    return (
      <li className="ag-srow is-editing">
        <RenameField session={session} onDone={() => setMode('idle')} />
      </li>
    );
  if (mode === 'delete')
    return (
      <li className="ag-srow is-asking">
        <DeleteAsk session={session} onDone={() => setMode('idle')} />
      </li>
    );
  const running = session.status === 'running';
  const items = (
    Item: typeof MenuItem | typeof ContextMenuItem,
    Sep: typeof MenuSeparator | typeof ContextMenuSeparator,
  ) => (
    <>
      <Item onSelect={() => setMode('rename')}>Rename</Item>
      <Sep />
      <Item onSelect={() => setMode('delete')}>Delete…</Item>
    </>
  );
  return (
    <li className={cx('ag-srow', current && 'is-on')}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className="ag-sbtn"
            aria-current={current ? 'true' : undefined}
            onClick={() => selectSession(session.id)}
            onDoubleClick={() => setMode('rename')}
          >
            <span className="tt">{session.title}</span>
            {waiting > 0 ? (
              <Count n={waiting} label={`${String(waiting)} waiting`} />
            ) : running ? (
              <i className="ag-run" role="img" aria-label="Working" />
            ) : (
              <time className="tm">{relTime(session.updatedAt, now)}</time>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>{items(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
      </ContextMenu>
      <Menu>
        <Tooltip content="Session">
          <MenuTrigger asChild>
            <button type="button" className="ag-smore" aria-label={`${session.title}: more`}>
              <Icon name="more" />
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent align="end">{items(MenuItem, MenuSeparator)}</MenuContent>
      </Menu>
    </li>
  );
}

export function SessionList() {
  const sessions = useAnalyst((s) => s.sessions);
  const current = useCurrentSession();
  const pending = usePending();
  const now = useNow();
  const groups = groupSessions(sessions ?? [], now);
  if (sessions !== null && sessions.length === 0) return <p className="ag-side-none">No sessions yet</p>;
  return (
    <ScrollArea className="ag-side-list">
      {groups.map((g) => (
        <section key={g.label} className="ag-sgroup" aria-label={g.label}>
          <h3>{g.label}</h3>
          <ul>
            {g.sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                current={s.id === current?.id}
                now={now}
                waiting={waitingIn(pending, s.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </ScrollArea>
  );
}
