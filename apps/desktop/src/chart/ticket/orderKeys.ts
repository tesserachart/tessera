import type { Side } from '@tessera/protocol';
import { limitLockWords } from '../../accounts/limits.ts';
import { ORDER_KEYS, type OrderKeyAction } from '../../shell/orderHotkeys.ts';
import { gridPress, gridWord, type GridOrder } from '../../shell/ticket.ts';
import { cancelWorking, flatten, reverse, submitOrder, type ActionResult } from '../../shell/tradeActions.ts';
import { startPlacement } from '../../state/placement.ts';
import { beginPlacement } from '../placement.ts';
import { cancelSelection, tradeRows, workingCount } from './tradeRows.ts';
import {
  armBase,
  entryBlock,
  quickOrder,
  reverseBracket,
  reverseOf,
  reverseWhat,
  touchOf,
  type TicketSend,
} from './send.ts';
import { chartMathOf } from './useTicketModel.ts';

export type KeyReport = (r: ActionResult, retry?: () => void) => void;

function labelOf(action: OrderKeyAction): string {
  return ORDER_KEYS.find((d) => d.action === action)?.label ?? action;
}

function bare(why: string): string {
  return why.trim().replace(/\.$/, '');
}

const ENTRIES: Partial<Record<OrderKeyAction, [Side, GridOrder]>> = {
  buyMarket: ['buy', 'market'],
  buyBid: ['buy', 'touch'],
  sellMarket: ['sell', 'market'],
  sellAsk: ['sell', 'touch'],
};

function entryOfKey(action: OrderKeyAction): [Side, GridOrder] | null {
  return ENTRIES[action] ?? null;
}

export function keyOfButton(side: Side, o: GridOrder): OrderKeyAction | null {
  for (const [action, e] of Object.entries(ENTRIES) as [OrderKeyAction, [Side, GridOrder]][])
    if (e[0] === side && e[1] === o) return action;
  return null;
}

export function runOrderKey(action: OrderKeyAction, t: TicketSend | { why: string }, report: KeyReport): void {
  if ('why' in t) {
    report({ tone: 'err', text: `${labelOf(action)}: ${bare(t.why)}. Nothing sent.` });
    return;
  }
  const entry = entryOfKey(action);
  if (entry) {
    sendEntry(t, entry[0], entry[1], report);
    return;
  }
  const accountId = t.account.account.id;
  const dp = t.math.decimals;
  const live = t.brackets.filter((b) => b.kind !== 'draft');
  const position = live.find((b) => b.kind === 'position') ?? null;
  const rows = tradeRows(live, chartMathOf(t.math, dp), { position: false, mode: t.mode });
  switch (action) {
    case 'flatten': {
      if (!position && workingCount(rows) === 0) {
        report({ tone: 'info', text: `Nothing to flatten on ${t.symbol}` });
        return;
      }
      const go = () =>
        void flatten(accountId, position?.instrument ?? t.instrument, t.symbol).then((r) => report(r, go));
      go();
      return;
    }
    case 'cancelAll': {
      const selection = cancelSelection(rows);
      if (selection.orders.length === 0) {
        report({
          tone: 'info',
          text:
            selection.kept > 0
              ? `Nothing to cancel on ${t.symbol}; the position’s stop and target stay`
              : `No working ${t.symbol} orders`,
        });
        return;
      }
      const go = () => void cancelWorking(accountId, t.instrument, t.symbol, selection).then((r) => report(r, go));
      go();
      return;
    }
    case 'reverse': {
      const view = reverseOf(position);
      if (view.why !== null || !position) {
        report({ tone: 'info', text: `Reverse: no ${t.symbol} position` });
        return;
      }
      const what = reverseWhat(view, t.symbol);
      const lock = limitLockWords(t.account);
      if (lock) {
        report({ tone: 'err', text: `${what}: ${bare(lock)}. Nothing sent.` });
        return;
      }
      const bracket = reverseBracket(t, view);
      void reverse(t.account.account.environment, accountId, position.instrument, bracket, what, dp).then((r) =>
        report(r),
      );
      return;
    }
    default:
      return;
  }
}

function sendEntry(t: TicketSend, side: Side, o: GridOrder, report: KeyReport): void {
  const why = entryBlock(t, side, o);
  if (why) {
    report({ tone: 'err', text: `${gridWord(side, o)}: ${bare(why)}. Nothing sent.` });
    return;
  }
  if (gridPress(o, t.setup.sizing === 'risk') === 'arm') {
    startPlacement(beginPlacement(armBase(t, side, o), o === 'touch' ? touchOf(t.quote, side) : null));
    return;
  }
  const q = quickOrder(t, side, o === 'touch' ? 'touch' : 'market');
  if ('error' in q) {
    report({ tone: 'err', text: q.error });
    return;
  }
  void submitOrder(t.account.account.environment, q.input, q.what, t.math.decimals).then((r) => report(r));
}
