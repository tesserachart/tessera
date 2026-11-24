import type { CopyGroup } from '@tessera/protocol';
import type { CopyAccount } from '../../accounts/copy.ts';
import type { GroupEdits } from './useGroupEdits.ts';

export const SAMPLE_ACCOUNTS: readonly CopyAccount[] = [
  { id: 'sample-lead', displayName: 'Evaluation 50K · 01', connectionId: 'sample', environment: 'eval' },
  { id: 'sample-f1', displayName: 'Evaluation 50K · 02', connectionId: 'sample', environment: 'eval' },
  { id: 'sample-f2', displayName: 'Evaluation 50K · 03', connectionId: 'sample', environment: 'eval' },
  { id: 'sample-f3', displayName: 'Funded 100K · 01', connectionId: 'sample', environment: 'funded' },
];

export const SAMPLE_GROUPS: readonly CopyGroup[] = [
  {
    id: 'sample-evals',
    name: 'Evaluation accounts',
    leaderId: 'sample-lead',
    followers: [
      { accountId: 'sample-f1', multiplier: 1 },
      { accountId: 'sample-f2', multiplier: 1 },
      { accountId: 'sample-f3', multiplier: 2 },
    ],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'sample-funded',
    name: 'Funded mirror',
    leaderId: 'sample-f3',
    followers: [{ accountId: 'sample-f1', multiplier: 1 }],
    enabled: false,
    createdAt: 0,
    updatedAt: 0,
  },
];

const ignore = () => undefined;

export function sampleEdits(group: CopyGroup): GroupEdits {
  return {
    followers: group.followers,
    enabled: group.enabled,
    name: group.name,
    setName: ignore,
    rename: ignore,
    turn: ignore,
    update: ignore,
  };
}

export function sampleName(id: string): string {
  return SAMPLE_ACCOUNTS.find((a) => a.id === id)?.displayName ?? id;
}
