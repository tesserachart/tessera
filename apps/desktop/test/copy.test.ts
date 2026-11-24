import type { Approval, ConnectionInfo, CopyGroup, TradingAccount } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  candidates,
  copiesTip,
  copyWord,
  defaultGroupName,
  followed,
  groupOn,
  groupsLedBy,
  leaderCandidates,
  pickGroup,
  sizingWords,
  withAdded,
  withCopying,
  withMicro,
  withSizing,
  without,
  copyStore,
} from '../src/accounts/copy.ts';
import { copiesOf, describeApproval } from '../src/shell/approval.ts';
import { sendSurface } from '../src/shell/ticket.ts';
import { patch } from '../src/app/store.ts';
import { connectionInfo, providerHealth } from './support/providers.ts';

function group(id: string, leaderId: string, followers: string[], enabled = true): CopyGroup {
  return {
    id,
    name: `Group ${id}`,
    leaderId,
    followers: followers.map((accountId) => ({ accountId, multiplier: 1 })),
    enabled,
    createdAt: 0,
    updatedAt: 0,
  };
}

function account(
  id: string,
  connectionId = 'tessera-paper',
): Pick<TradingAccount, 'id' | 'displayName' | 'connectionId' | 'environment'> {
  return { id, displayName: id.toUpperCase(), connectionId, environment: 'eval' };
}

describe('copy groups', () => {
  const groups = [group('cg1', 'lead', ['e1', 'e2']), group('cg2', 'lead', ['e3'], false), group('cg3', 'x', ['e4'])];

  it('finds the group on that an account leads, and the leader it follows', () => {
    expect(groupOn(groups, 'lead')?.id).toBe('cg1');
    expect(groupOn(groups, 'e1')).toBeNull();
    expect(groupsLedBy(groups, 'lead').map((g) => g.id)).toEqual(['cg1', 'cg2']);
    expect(followed(groups, 'e2')?.group.id).toBe('cg1');
    expect(followed(groups, 'e3')).toBeNull();
  });

  it('says each follower’s size as the runtime does', () => {
    expect(sizingWords({ accountId: 'a', multiplier: 0.5 })).toBe('0.5×');
    expect(sizingWords({ accountId: 'a', multiplier: 1, fixedQty: 2 })).toBe('fixed 2');
    const g = { ...group('cg1', 'lead', []), followers: [{ accountId: 'e1', multiplier: 2 }] };
    expect(copiesTip(g, (id) => id.toUpperCase())).toBe('E1 · 2×');
  });

  it('offers every other account, each with why it cannot follow', () => {
    const connections = [
      connectionInfo(providerHealth({ providerId: 'rithmic-apex', displayName: 'Apex · Rithmic' }), {
        broker: {
          readOnly: false,
          orderTypes: ['market'],
          environments: ['eval'],
        } as unknown as ConnectionInfo['broker'],
        accountOrderEntry: ['on'],
      }),
    ];
    const accounts = [
      account('lead'),
      account('e1'),
      account('x'),
      account('e4'),
      account('free'),
      account('on', 'rithmic-apex'),
      account('off', 'rithmic-apex'),
    ];
    const offer = candidates(groups, groups[0]!, accounts, connections);
    expect(offer.map((c) => [c.id, c.why])).toEqual([
      ['x', 'Leads Group cg3'],
      ['e4', 'Follows X'],
      ['free', null],
      ['on', null],
      ['off', 'Order entry is off for this Apex account; turn it on to send it orders.'],
    ]);
  });

  it('changes a follower’s size, adds each account once and removes one', () => {
    const f = [
      { accountId: 'e1', multiplier: 1 },
      { accountId: 'e2', multiplier: 1 },
    ];
    expect(withSizing(f, 'e2', { times: 0.5 })[1]).toEqual({ accountId: 'e2', multiplier: 0.5 });
    expect(withSizing(f, 'e2', { fixed: 3 })[1]).toEqual({ accountId: 'e2', multiplier: 1, fixedQty: 3 });
    expect(withSizing([{ accountId: 'e1', multiplier: 1, fixedQty: 3 }], 'e1', { times: 2 })).toEqual([
      { accountId: 'e1', multiplier: 2 },
    ]);
    expect(withAdded(f, ['e2', 'e3', 'e3']).map((x) => x.accountId)).toEqual(['e1', 'e2', 'e3']);
    expect(without(f, 'e1')).toEqual([{ accountId: 'e2', multiplier: 1 }]);
  });

  it('keeps a follower’s contract and pause through a size change, and sends neither while off', () => {
    const f = [{ accountId: 'e1', multiplier: 1, fixedQty: 2, micro: true, paused: true }];
    expect(withSizing(f, 'e1', { times: 0.5 })).toEqual([
      { accountId: 'e1', multiplier: 0.5, micro: true, paused: true },
    ]);
    expect(withMicro(f, 'e1', false)).toEqual([{ accountId: 'e1', multiplier: 1, fixedQty: 2, paused: true }]);
    expect(withCopying(f, 'e1', true)).toEqual([{ accountId: 'e1', multiplier: 1, fixedQty: 2, micro: true }]);
    expect(withCopying([{ accountId: 'e1', multiplier: 1 }], 'e1', false)).toEqual([
      { accountId: 'e1', multiplier: 1, paused: true },
    ]);
  });

  it('says on an account’s row the group it leads or the leader it follows, while on', () => {
    const nameOf = (id: string) => id.toUpperCase();
    expect(copyWord(groups, 'lead', nameOf)).toEqual({ text: 'Leads Group cg1', groupId: 'cg1' });
    expect(copyWord(groups, 'e4', nameOf)).toEqual({ text: 'Follows X', groupId: 'cg3' });
    expect(copyWord(groups, 'e3', nameOf)).toBeNull();
  });

  it('offers as leader every account, each with why it cannot lead', () => {
    const offer = leaderCandidates(groups, [account('lead'), account('e1'), account('free')], []);
    expect(offer.map((c) => [c.id, c.why])).toEqual([
      ['lead', null],
      ['e1', 'Follows LEAD'],
      ['free', null],
    ]);
  });

  it('names a new group after its leader, numbered past the first', () => {
    expect(defaultGroupName(groups, 'free', 'Free')).toBe('Copy Free');
    expect(defaultGroupName(groups, 'lead', 'Lead')).toBe('Copy Lead 3');
  });

  it('shows the group asked for, else the first', () => {
    expect(pickGroup(groups, 'cg2')?.id).toBe('cg2');
    expect(pickGroup(groups, 'gone')?.id).toBe('cg1');
    expect(pickGroup([], null)).toBeNull();
  });
});

describe('a click on a leader', () => {
  it('confirms for its followers as it would on their own accounts', () => {
    patch(copyStore, { groups: [group('cg1', 'lead', ['e1'])] });
    try {
      expect(sendSurface('paper', 'lead')).toEqual({ armed: true, holdConfirmed: true });
      expect(sendSurface('paper', 'e1')).toEqual({ armed: true, holdConfirmed: false });
      expect(sendSurface('paper')).toEqual({ armed: true, holdConfirmed: false });
    } finally {
      patch(copyStore, { groups: null });
    }
  });
});

describe('the approval of an order on a leader', () => {
  const preview = {
    request: {
      accountId: 'lead',
      instrument: 'NQZ6.CME',
      side: 'buy',
      qty: 2,
      orderType: 'market',
      limitPrice: null,
      stopPrice: null,
      tif: 'day',
      bracket: null,
      clientOrderId: null,
      reduceOnly: false,
    },
    environment: 'paper',
    restatement: 'BUY 2 NQZ6 MKT DAY and 3 accounts by copy',
    referencePrice: null,
    estPrice: null,
    estValue: null,
    estFees: null,
    riskToStop: null,
    buyingPowerAfter: null,
    positionAfter: 2,
    checks: [],
    createdAt: 0,
    copies: {
      groupId: 'cg1',
      groupName: 'Evals',
      accounts: ['Eval 1', 'Eval 2', 'Eval 3'],
      words: 'and 3 accounts by copy',
    },
  };

  it('names the accounts it goes to by copy', () => {
    expect(copiesOf(preview)).toEqual({ words: 'and 3 accounts by copy', accounts: ['Eval 1', 'Eval 2', 'Eval 3'] });
    const view = describeApproval({ preview, kind: 'financial', tool: 'orders.submit' } as unknown as Approval);
    expect(view.copies?.words).toBe('and 3 accounts by copy');
    expect(view.order?.side).toBe('Buy');
  });

  it('names none on an account that leads no group on', () => {
    const { copies: _, ...plain } = preview;
    expect(copiesOf(plain)).toBeNull();
    expect(copiesOf(null)).toBeNull();
  });
});
