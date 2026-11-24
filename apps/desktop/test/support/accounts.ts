import type { AccountUpdate, Money, TradingAccount } from '@tessera/protocol';

const usd = (amount: number): Money => ({ amount, currency: 'USD' });

export function paperAccount(id: string, displayName = 'Paper'): TradingAccount {
  return {
    id,
    displayName,
    environment: 'paper',
    brokerId: 'tessera-paper',
    connectionId: 'paper',
    programId: null,
    ruleSetId: null,
    currency: 'USD',
    restrictions: { noCopyTrading: false, blockedInstruments: [], loosenNextSession: false },
    groupId: null,
    externalRefMasked: null,
  };
}

export function accountUpdate(account: TradingAccount, openPnl = 0): AccountUpdate {
  return {
    account,
    summary: {
      accountId: account.id,
      balance: usd(100_000),
      netLiq: usd(100_000 + openPnl),
      dayPnl: usd(openPnl),
      realizedToday: usd(0),
      feesToday: usd(0),
      unrealizedToday: usd(openPnl),
      openPnl: usd(openPnl),
      buyingPower: usd(0),
      asOf: 0,
    },
    risk: null,
  };
}
