import type { CopyFollowerSync, CopyGroup, CopyGroupSync, CopyReport } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  activityWords,
  confirmSurface,
  followerRows,
  groupLine,
  holdingWords,
  holdingsWords,
  lastView,
  leaderWords,
  needsResync,
  outOfSyncWords,
  reportWhy,
  resyncing,
  syncOf,
  syncView,
} from '../src/accounts/copyView.ts';

function follower(accountId: string, over: Partial<CopyFollowerSync> = {}): CopyFollowerSync {
  return {
    accountId,
    account: accountId.toUpperCase(),
    state: 'in_sync',
    why: null,
    holdings: [],
    since: null,
    last: null,
    ...over,
  };
}

const group: CopyGroup = {
  id: 'cg1',
  name: 'Evals',
  leaderId: 'lead',
  followers: [
    { accountId: 'e1', multiplier: 1 },
    { accountId: 'e2', multiplier: 0.5, micro: true },
    { accountId: 'e3', multiplier: 1, paused: true },
  ],
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const sync: CopyGroupSync = {
  groupId: 'cg1',
  leaderId: 'lead',
  leader: 'Lead',
  leaderHoldings: [{ instrument: 'NQZ6.CME', qty: 2 }],
  followers: [
    follower('e1', {
      holdings: [{ leaderInstrument: 'NQZ6.CME', instrument: 'NQZ6.CME', leaderQty: 2, targetQty: 2, qty: 2 }],
    }),
    follower('e2', {
      state: 'out_of_sync',
      why: 'holds Long 3 MNQZ6, should hold Long 1',
      holdings: [{ leaderInstrument: 'NQZ6.CME', instrument: 'MNQZ6.CME', leaderQty: 2, targetQty: 1, qty: 3 }],
      since: 1,
    }),
    follower('e3', {
      state: 'out_of_sync',
      why: 'holds nothing, should hold Long 2 NQZ6',
      holdings: [{ leaderInstrument: 'NQZ6.CME', instrument: 'NQZ6.CME', leaderQty: 2, targetQty: 2, qty: 0 }],
    }),
  ],
  outOfSync: 2,
  recent: [],
};

describe('holdings in words', () => {
  it('says a position as the ticket does, and Flat for none', () => {
    expect(holdingWords(2, 'NQZ6.CME')).toBe('Long 2 NQ Z6');
    expect(holdingWords(-1, 'MESZ6.CME')).toBe('Short 1 MES Z6');
    expect(holdingWords(0, 'NQZ6.CME')).toBe('Flat');
    expect(holdingsWords([])).toBe('Flat');
    expect(
      holdingsWords([
        { instrument: 'NQZ6.CME', qty: 2 },
        { instrument: 'ESZ6.CME', qty: 0 },
        { instrument: 'CLF7.NYMEX', qty: -1 },
      ]),
    ).toBe('Long 2 NQ Z6, Short 1 CL F7');
  });

  it('says the leader’s positions, and nothing before the runtime has said them', () => {
    expect(leaderWords(sync)).toBe('Long 2 NQ Z6');
    expect(leaderWords(null)).toBe('');
  });
});

describe('a follower’s sync', () => {
  it('is quiet in sync and while copies settle, the runtime’s reason when out, and never assumed', () => {
    expect(syncView({ state: 'in_sync', why: null }, false)).toEqual({
      text: 'In sync',
      dot: null,
      strong: false,
      rule: false,
    });
    expect(syncView({ state: 'settling', why: 'holds Flat' }, false)).toEqual({
      text: 'Copying…',
      dot: null,
      strong: false,
      rule: false,
    });
    expect(syncView({ state: 'out_of_sync', why: 'holds Long 3 MNQZ6, should hold Long 2' }, false)).toEqual({
      text: 'holds Long 3 MNQZ6, should hold Long 2',
      dot: 'down',
      strong: true,
      rule: true,
    });
    expect(syncView({ state: 'unknown', why: 'positions could not be read: not connected' }, false)).toEqual({
      text: 'Unknown: positions could not be read: not connected',
      dot: 'degraded',
      strong: true,
      rule: false,
    });
    expect(syncView({ state: 'out_of_sync', why: 'holds Long 1 NQZ6, the leader is flat' }, true)).toEqual({
      text: 'Paused: holds Long 1 NQZ6, the leader is flat',
      dot: 'down',
      strong: true,
      rule: true,
    });
    expect(syncView({ state: 'in_sync', why: null }, true).text).toBe('Paused');
    expect(syncView({ state: 'unknown', why: 'not connected' }, true).text).toBe('Unknown: not connected');
    expect(syncView(null, false).text).toBe('');
  });

  it('shows a last copy only when it was skipped or went unanswered', () => {
    const last = { what: 'Buy 2 NQZ6', text: 'Daily loss limit reached', at: 5 };
    expect(lastView({ ...last, outcome: 'skipped' })).toEqual({
      text: 'Buy 2 NQZ6: Daily loss limit reached',
      dot: 'down',
      at: 5,
    });
    expect(lastView({ ...last, outcome: 'unknown', text: 'no answer' })).toEqual({
      text: 'Buy 2 NQZ6: no answer',
      dot: 'degraded',
      at: 5,
    });
    expect(lastView({ ...last, outcome: 'copied' })).toBeNull();
    expect(lastView({ ...last, outcome: 'nothing' })).toBeNull();
    expect(lastView(null)).toBeNull();
  });
});

describe('the followers table', () => {
  const rows = followerRows(group.followers, sync, (id) => `name ${id}`);

  it('joins each follower’s settings with its sync by account', () => {
    expect(rows.map((r) => [r.name, r.micro, r.paused, r.holds, r.shouldHold, r.resync, r.flatten])).toEqual([
      ['E1', false, false, 'Long 2 NQ Z6', 'Long 2 NQ Z6', false, true],
      ['E2', true, false, 'Long 3 MNQ Z6', 'Long 1 MNQ Z6', true, true],
      ['E3', false, true, 'Flat', 'Long 2 NQ Z6', true, false],
    ]);
    expect(rows[1]?.sync.rule).toBe(true);
    expect(rows[2]?.sync.text).toBe(`Paused: ${String(sync.followers[2]?.why)}`);
    expect(rows[2]?.sync.rule).toBe(true);
  });

  it('claims no holdings it could not read, and offers Flatten there', () => {
    const unread = { ...sync, followers: [follower('e1', { state: 'unknown', why: 'not connected' })] };
    const [row] = followerRows([{ accountId: 'e1', multiplier: 1 }], unread, (id) => id);
    expect(row).toMatchObject({ holds: '', shouldHold: '', flatten: true, resync: false });
    const [none] = followerRows([{ accountId: 'e9', multiplier: 1 }], null, (id) => `name ${id}`);
    expect(none).toMatchObject({ name: 'name e9', holds: '', shouldHold: '', flatten: true });
  });

  it('shows a skipped copy on its follower’s row', () => {
    const missed = {
      ...sync,
      followers: [
        follower('e1', { last: { what: 'Sell 1 NQZ6', outcome: 'skipped', text: 'Order entry is off', at: 9 } }),
      ],
    };
    expect(followerRows([{ accountId: 'e1', multiplier: 1 }], missed, (id) => id)[0]?.last?.text).toBe(
      'Sell 1 NQZ6: Order entry is off',
    );
  });

  it('offers the group’s Resync only for a follower out of sync and copying', () => {
    expect(needsResync(group, sync)).toBe(true);
    expect(resyncing(group, sync)).toEqual(['e2']);
    const pausedOnly = { ...sync, followers: sync.followers.filter((f) => f.accountId === 'e3') };
    expect(needsResync(group, pausedOnly)).toBe(false);
    expect(needsResync(group, null)).toBe(false);
  });
});

describe('the group list', () => {
  it('says the leader and how many follow, and how many are out of sync only when some are', () => {
    expect(groupLine(group, 'Lead')).toBe('Lead → 3 followers');
    expect(groupLine({ ...group, followers: [group.followers[0]!] }, 'Lead')).toBe('Lead → 1 follower');
    expect(outOfSyncWords(sync)).toBe('2 out of sync');
    expect(outOfSyncWords({ ...sync, outOfSync: 0 })).toBeNull();
    expect(outOfSyncWords(null)).toBeNull();
    expect(syncOf({ groups: [sync], checkedAt: 0 }, 'cg1')).toBe(sync);
    expect(syncOf(null, 'cg1')).toBeNull();
  });

  it('says how far each recent copy reached', () => {
    const a = { what: 'Buy 2 NQZ6', at: 0, copied: 2, of: 2, detail: null };
    expect(activityWords(a)).toBe('Buy 2 NQZ6: copied to 2 of 2');
    expect(activityWords({ ...a, copied: 1, detail: 'Paper 3 skipped: Daily loss limit reached.' })).toBe(
      'Buy 2 NQZ6: copied to 1 of 2 · Paper 3 skipped: Daily loss limit reached.',
    );
    expect(activityWords({ ...a, of: 0, copied: 0 })).toBe('Buy 2 NQZ6');
  });
});

describe('a resync or flatten', () => {
  it('names each follower it skipped or could not reach', () => {
    const report: CopyReport = {
      groupId: 'cg1',
      groupName: 'Evals',
      leaderId: 'lead',
      results: [
        { accountId: 'e1', account: 'Eval 1', outcome: 'copied', text: 'Buy 1 NQZ6 market · filled', orders: [] },
        { accountId: 'e2', account: 'Eval 2', outcome: 'skipped', text: 'Daily loss limit reached', orders: [] },
        { accountId: 'e3', account: 'Eval 3', outcome: 'unknown', text: 'No answer', orders: [] },
      ],
    };
    expect(reportWhy(report)).toBe('Eval 2: Daily loss limit reached; Eval 3: No answer');
    expect(reportWhy({ ...report, results: report.results.slice(0, 1) })).toBeNull();
  });

  it('confirms as the Trade panel would on the strictest account it reaches', () => {
    expect(confirmSurface(['paper'])).toEqual({ armed: true, holdConfirmed: false });
    expect(confirmSurface(['paper', 'eval'])).toEqual({ armed: true, holdConfirmed: true });
    expect(confirmSurface([])).toEqual({ armed: true, holdConfirmed: false });
  });
});
