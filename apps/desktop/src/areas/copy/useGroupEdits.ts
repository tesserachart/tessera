import type { CopyFollower, CopyGroup } from '@tessera/protocol';
import { createOverlay, useOverlay } from '../../app/overlay.ts';
import { copyCall } from '../../accounts/copy.ts';
import { say, unsay } from './store.ts';

const copyEdits = createOverlay();

export interface GroupEdits {
  followers: CopyFollower[];
  enabled: boolean;
  name: string;
  setName: (name: string) => void;
  rename: () => void;
  turn: (on: boolean) => void;
  update: (next: CopyFollower[]) => void;
}

export function useGroupEdits(group: CopyGroup): GroupEdits {
  const k = (part: string) => `${group.id}/${part}`;
  const edits = useOverlay(copyEdits, {
    [k('followers')]: group.followers,
    [k('name')]: group.name,
    [k('enabled')]: group.enabled,
  });
  const shown = <T>(part: string, server: T): T => (k(part) in edits ? (edits[k(part)] as T) : server);
  const followers = shown('followers', group.followers);
  const enabled = shown('enabled', group.enabled);
  const name = shown('name', group.name);
  const send = (part: string, value: unknown, call: () => ReturnType<typeof copyCall>): void => {
    copyEdits
      .write(k(part), value, async () => {
        const r = await call();
        if (r.ok) {
          if (r.out.said.length > 0) say(group.id, 'info', r.out.said.join(' '));
          else unsay(group.id);
        } else {
          say(group.id, 'err', r.why);
          throw new Error(r.why);
        }
      })
      .catch(() => undefined);
  };
  return {
    followers,
    enabled,
    name,
    setName: (n) => copyEdits.edit(k('name'), n),
    rename: () => {
      const n = name.trim();
      if (n === group.name || n === '') {
        copyEdits.edit(k('name'), group.name);
        return;
      }
      send('name', n, () => copyCall('copy.update', { groupId: group.id, name: n }));
    },
    turn: (on) => send('enabled', on, () => copyCall(on ? 'copy.enable' : 'copy.disable', { groupId: group.id })),
    update: (next) => send('followers', next, () => copyCall('copy.update', { groupId: group.id, followers: next })),
  };
}
