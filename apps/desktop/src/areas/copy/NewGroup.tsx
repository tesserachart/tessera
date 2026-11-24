import type { ConnectionInfo, CopyGroup } from '@tessera/protocol';
import { Button, Check, Select, TextInput } from '@tessera/ui';
import { useState } from 'react';
import {
  candidates,
  copyCall,
  defaultGroupName,
  leaderCandidates,
  withAdded,
  type CopyAccount,
} from '../../accounts/copy.ts';
import { Refused } from '../../workspace/tiles/parts.tsx';
import { selectCopyGroup, setCreating } from './store.ts';

export function NewGroup({
  groups,
  accounts,
  connections,
}: {
  groups: readonly CopyGroup[];
  accounts: readonly CopyAccount[];
  connections: readonly ConnectionInfo[] | undefined;
}) {
  const leaders = leaderCandidates(groups, accounts, connections);
  const [chosen, setLeader] = useState<string | null>(null);
  const leader = chosen ?? leaders.find((c) => c.why === null)?.id ?? null;
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const leaderName = leaders.find((c) => c.id === leader)?.name ?? '';
  const shownName = name ?? (leader ? defaultGroupName(groups, leader, leaderName) : '');
  const offer = leader ? candidates(groups, { id: '', leaderId: leader, followers: [] }, accounts, connections) : [];
  const followers = offer.filter((c) => c.why === null && picked.has(c.id)).map((c) => c.id);
  const create = () => {
    if (!leader) return;
    setBusy(true);
    setFailed(null);
    void copyCall('copy.create', {
      name: shownName.trim(),
      leaderId: leader,
      followers: withAdded([], followers),
      enabled: false,
    }).then((r) => {
      setBusy(false);
      if (r.ok) selectCopyGroup(r.out.group.id);
      else setFailed(r.why);
    });
  };
  return (
    <section className="cp-new" aria-label="New group">
      <div className="cp-new-row">
        <span className="cp-label">Leader</span>
        <Select
          size="s"
          className="cp-new-leader"
          label="Leader"
          placeholder="Choose the leader"
          value={leader ?? undefined}
          options={leaders.map((c) => ({
            value: c.id,
            label: c.name,
            hint: c.why ?? undefined,
            disabled: c.why !== null,
          }))}
          onValueChange={(v) => {
            setLeader(v);
            setPicked(new Set());
          }}
        />
      </div>
      {offer.length > 0 ? (
        <div className="cp-new-row is-top">
          <span className="cp-label">Followers</span>
          <ul className="cp-new-list" aria-label="Followers">
            {offer.map((c) => (
              <li key={c.id}>
                <Check
                  checked={c.why === null && picked.has(c.id)}
                  disabled={c.why !== null}
                  onChange={(on) => {
                    const next = new Set(picked);
                    if (on) next.add(c.id);
                    else next.delete(c.id);
                    setPicked(next);
                  }}
                >
                  {c.name}
                </Check>
                {c.why ? <span className="why">{c.why}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="cp-new-row">
        <span className="cp-label">Name</span>
        <TextInput
          size="s"
          className="cp-new-name"
          aria-label="Group name"
          value={shownName}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="cp-new-foot">
        <Button size="s" variant="primary" disabled={busy || !leader || shownName.trim() === ''} onClick={create}>
          Create
        </Button>
        <Button size="s" variant="quiet" onClick={() => setCreating(false)}>
          Cancel
        </Button>
        {failed ? <Refused text={failed} /> : null}
      </div>
    </section>
  );
}
