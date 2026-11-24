import type { CopyGroup, CopySyncUpdate } from '@tessera/protocol';
import { Button, Loaded, ScrollArea, Switch, cx, useLoadPending } from '@tessera/ui';
import { pickGroup, useCopyGroups, useCopySync } from '../../accounts/copy.ts';
import { groupLine, outOfSyncWords, syncOf } from '../../accounts/copyView.ts';
import { useAccountList } from '../../app/portfolio.ts';
import { useConnectionList } from '../../shell/orderEntry.ts';
import { useShellData } from '../../shell/shellData.ts';
import type { ReactNode } from 'react';
import { GroupDetail, GroupView } from './GroupDetail.tsx';
import { NewGroup } from './NewGroup.tsx';
import { selectCopyGroup, setCreating, useCopyUi } from './store.ts';
import { SAMPLE_ACCOUNTS, SAMPLE_GROUPS, sampleEdits, sampleName } from './samples.ts';
import { useGroupEdits, type GroupEdits } from './useGroupEdits.ts';
import './copy.css';

function CopyBody() {
  const groups = useCopyGroups();
  const sync = useCopySync();
  const listed = useAccountList();
  useLoadPending(groups === null || (groups.length > 0 && sync === null) || listed === null);
  const selected = useCopyUi((s) => s.group);
  const creating = useCopyUi((s) => s.creating);
  const { accounts } = useShellData();
  const connections = useConnectionList();
  if (groups === null) return null;
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? id;
  const shown = pickGroup(groups, selected);
  if (groups.length === 0 && !creating) {
    return (
      <div className="cp-empty">
        <p>Copy one account’s orders to your others: a leader and its followers.</p>
        <Button size="s" variant="primary" onClick={() => setCreating(true)}>
          New group
        </Button>
      </div>
    );
  }
  return (
    <CopyLayout
      rows={groups.map((g) => (
        <GroupRow key={g.id} group={g} sync={sync} on={!creating && g.id === shown?.id} nameOf={nameOf} />
      ))}
      creating={creating}
      main={
        creating ? (
          <NewGroup groups={groups} accounts={accounts} connections={connections} />
        ) : shown ? (
          <GroupDetail key={shown.id} group={shown} groups={groups} accounts={accounts} connections={connections} />
        ) : null
      }
    />
  );
}

function CopyLayout({ rows, creating, main }: { rows: ReactNode; creating: boolean; main: ReactNode }) {
  return (
    <div className="cp">
      <nav className="cp-nav" aria-label="Copy groups">
        <ScrollArea className="cp-nav-scroll">{rows}</ScrollArea>
        <div className="cp-nav-foot">
          <Button size="s" variant="quiet" icon="plus" disabled={creating} onClick={() => setCreating(true)}>
            New group
          </Button>
        </div>
      </nav>
      <div className="cp-main">{main}</div>
    </div>
  );
}

function CopySample() {
  const first = SAMPLE_GROUPS[0]!;
  return (
    <CopyLayout
      rows={SAMPLE_GROUPS.map((g) => (
        <GroupRowView key={g.id} group={g} edits={sampleEdits(g)} sync={null} on={g === first} nameOf={sampleName} />
      ))}
      creating={false}
      main={
        <GroupView
          group={first}
          groups={SAMPLE_GROUPS}
          accounts={SAMPLE_ACCOUNTS}
          connections={[]}
          edits={sampleEdits(first)}
          sync={null}
          said={null}
        />
      }
    />
  );
}

export function CopyPanel() {
  return (
    <Loaded label="Loading the trade copier" sample={<CopySample />}>
      <CopyBody />
    </Loaded>
  );
}

interface GroupRowProps {
  group: CopyGroup;
  sync: CopySyncUpdate | null;
  on: boolean;
  nameOf: (id: string) => string;
}

function GroupRow(props: GroupRowProps) {
  return <GroupRowView {...props} edits={useGroupEdits(props.group)} />;
}

function GroupRowView({ group, sync, on, nameOf, edits: e }: GroupRowProps & { edits: GroupEdits }) {
  const s = syncOf(sync, group.id);
  const wrong = outOfSyncWords(s);
  return (
    <div className={cx('cp-nav-row', on && 'is-on')}>
      <button
        type="button"
        className="cp-nav-pick"
        aria-current={on ? 'true' : undefined}
        onClick={() => selectCopyGroup(group.id)}
      >
        <span className="ttl">{e.name}</span>
        <span className="sub">
          {groupLine({ ...group, followers: e.followers }, s?.leader ?? nameOf(group.leaderId))}
          {wrong ? <span className="off"> · {wrong}</span> : null}
          {e.enabled ? null : <span className="off"> · Off</span>}
        </span>
      </button>
      <Switch checked={e.enabled} onCheckedChange={e.turn} label={`Copy ${group.name}`} />
    </div>
  );
}
