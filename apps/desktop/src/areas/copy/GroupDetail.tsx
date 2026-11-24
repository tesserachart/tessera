import {
  normalizeEpochMs,
  type ConnectionInfo,
  type CopyGroup,
  type CopyGroupSync,
  type CopyActivity,
  type Environment,
} from '@tessera/protocol';
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  ScrollArea,
  Select,
  Switch,
  TextInput,
  formatClock,
} from '@tessera/ui';
import { useState } from 'react';
import {
  candidates,
  copyCall,
  useCopySync,
  withAdded,
  withCopying,
  withMicro,
  withSizing,
  without,
  type CopyAccount,
} from '../../accounts/copy.ts';
import {
  activityWords,
  flattenCopy,
  followerRows,
  leaderWords,
  needsResync,
  reportWhy,
  resync,
  resyncing,
  syncOf,
  type CopyActResult,
} from '../../accounts/copyView.ts';
import { displayZone } from '../../state/timeZone.ts';
import { deskToasts } from '../../workspace/dock/deskToasts.ts';
import { Refused } from '../../workspace/tiles/parts.tsx';
import { FollowersTable } from './FollowersTable.tsx';
import { say, unsay, useCopyUi, type CopySaid } from './store.ts';
import { useGroupEdits, type GroupEdits } from './useGroupEdits.ts';

const ALL = '*';

interface GroupDetailProps {
  group: CopyGroup;
  groups: readonly CopyGroup[];
  accounts: readonly CopyAccount[];
  connections: readonly ConnectionInfo[] | undefined;
}

export function GroupDetail(props: GroupDetailProps) {
  const edits = useGroupEdits(props.group);
  const sync = syncOf(useCopySync(), props.group.id);
  const said = useCopyUi((s) => (s.said?.groupId === props.group.id ? s.said : null));
  return <GroupView {...props} edits={edits} sync={sync} said={said} />;
}

export function GroupView({
  group,
  groups,
  accounts,
  connections,
  edits: e,
  sync,
  said,
}: GroupDetailProps & {
  edits: GroupEdits;
  sync: CopyGroupSync | null;
  said: CopySaid | null;
}) {
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? id;
  const environments = (ids: readonly string[]): Environment[] =>
    ids.flatMap((id) => {
      const env = accounts.find((a) => a.id === id)?.environment;
      return env ? [env] : [];
    });
  const shown = { ...group, followers: e.followers, enabled: e.enabled };
  const rows = followerRows(e.followers, sync, nameOf);
  const run = (call: Promise<CopyActResult>) => {
    setBusy(true);
    unsay(group.id);
    void call.then((r) => {
      setBusy(false);
      if (r.kind === 'failed') say(group.id, 'err', r.why);
      else if (r.kind === 'drafted') say(group.id, 'info', 'Drafted: approve it on the card.');
      else {
        const why = reportWhy(r.report);
        if (why) say(group.id, 'err', why);
      }
    });
  };
  const remove = () => {
    void copyCall('copy.delete', { groupId: group.id }).then((r) => {
      if (!r.ok) say(group.id, 'err', r.why);
      else if (r.out.said.length > 0)
        deskToasts.push({ tone: 'info', title: `Deleted ${r.out.name}`, detail: r.out.said.join(' ') });
    });
  };
  const offer = candidates(groups, shown, accounts, connections);
  const able = offer.filter((c) => c.why === null);
  const options = [
    ...(able.length > 1 ? [{ value: ALL, label: `Every account that can follow (${String(able.length)})` }] : []),
    ...offer.map((c) => ({ value: c.id, label: c.name, hint: c.why ?? undefined, disabled: c.why !== null })),
  ];
  return (
    <section className="cp-group" aria-label={group.name}>
      <header className="cp-head">
        <TextInput
          size="s"
          className="cp-name"
          aria-label="Group name"
          value={e.name}
          maxLength={60}
          onChange={(ev) => e.setName(ev.target.value)}
          onBlur={e.rename}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') ev.currentTarget.blur();
            if (ev.key === 'Escape') e.setName(group.name);
          }}
        />
        <Switch checked={e.enabled} onCheckedChange={e.turn} label={`Copy ${group.name}`}>
          {e.enabled ? 'Copying on' : 'Copying off'}
        </Switch>
        <span className="cp-fill" />
        {needsResync(shown, sync) ? (
          <Button
            size="s"
            variant="primary"
            disabled={busy}
            onClick={() => run(resync({ groupId: group.id }, environments(resyncing(shown, sync))))}
          >
            Resync
          </Button>
        ) : null}
        <Button size="s" disabled={busy} onClick={() => run(flattenCopy({ groupId: group.id }))}>
          Flatten all
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={`More for ${group.name}`} icon="more" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem destructive onSelect={remove}>
              Delete {group.name}
            </MenuItem>
          </MenuContent>
        </Menu>
      </header>
      {said ? <p className="cp-said">{said.tone === 'err' ? <Refused text={said.text} /> : said.text}</p> : null}
      {e.enabled ? null : (
        <p className="cp-off">
          <span>Off: trades on {sync?.leader ?? nameOf(group.leaderId)} are not copied.</span>
          <Button size="s" variant="primary" disabled={busy} onClick={() => e.turn(true)}>
            Start copying
          </Button>
        </p>
      )}
      <ScrollArea className="cp-body">
        <p className="cp-leader">
          <span className="nm">{sync?.leader ?? nameOf(group.leaderId)}</span>
          <span className="h">{leaderWords(sync)}</span>
        </p>
        {rows.length > 0 ? (
          <FollowersTable
            label={`${group.name} followers`}
            rows={rows}
            busy={busy}
            groupOn={e.enabled}
            actions={{
              onSizing: (id, s) => e.update(withSizing(e.followers, id, s)),
              onMicro: (id, micro) => e.update(withMicro(e.followers, id, micro)),
              onCopying: (id, on) => e.update(withCopying(e.followers, id, on)),
              onResync: (id) => run(resync({ groupId: group.id, accountId: id }, environments([id]))),
              onFlatten: (id) => run(flattenCopy({ groupId: group.id, accountId: id })),
              onRemove: (id) => e.update(without(e.followers, id)),
            }}
          />
        ) : null}
        {offer.length > 0 ? (
          <Select
            size="s"
            className="cp-add"
            label="Add an account"
            placeholder="Add an account"
            value=""
            options={options}
            onValueChange={(v) => e.update(withAdded(e.followers, v === ALL ? able.map((c) => c.id) : [v]))}
          />
        ) : null}
        <RecentCopies recent={sync?.recent ?? []} />
      </ScrollArea>
    </section>
  );
}

function RecentCopies({ recent }: { recent: readonly CopyActivity[] }) {
  return (
    <section className="cp-recent" aria-label="Recent copies">
      <h3 className="cp-sub">Recent copies</h3>
      {recent.length === 0 ? (
        <p className="cp-none">Nothing copied yet this session.</p>
      ) : (
        <ol className="cp-recent-list">
          {recent.map((a, i) => (
            <li key={`${String(a.at)}-${String(i)}`} className="cp-copy" data-missed={a.detail ? '' : undefined}>
              <span className="w">{activityWords(a)}</span>
              <span className="at">{formatClock(normalizeEpochMs(a.at), displayZone())}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
