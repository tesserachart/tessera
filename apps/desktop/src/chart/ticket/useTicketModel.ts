import type { Order, Side } from '@tessera/protocol';
import { formatPrice, formatMoney } from '@tessera/ui';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { limitLine, limitLockWords } from '../../accounts/limits.ts';
import type { ContractSpec } from '@tessera/protocol';
import { useAccountContract } from '../../market/contracts.ts';
import { familyOf, mirrors, rootFor, siblingOf, type ExecuteAs } from '../../market/families.ts';
import { displaySymbol, useInstrumentSpec } from '../../market/instruments.ts';
import { useQuote } from '../../market/quotes.ts';
import { pricesDown, pricesStale, streamStale, useFeeds } from '../../shell/freshness.ts';
import {
  bracketSideErrors,
  instrumentRoot,
  ocoBracket,
  planOco,
  planOk,
  tickMoney,
  type ContractMath,
} from '../../shell/oco.ts';
import { useConnectionList, useRuntimeEntry, takesOrderType } from '../../shell/orderEntry.ts';
import {
  MARKET_WAITS,
  gridKind,
  gridPress,
  gridTip,
  marketReference,
  opensContracts,
  type GridOrder,
} from '../../shell/ticket.ts';
import {
  breakeven,
  cancelOrders,
  cancelWorking,
  flatten,
  heldOrderIntents,
  isOrderHeld,
  mergeBrackets,
  orderIntentKey,
  reverse,
  submitOrder,
  watchOrderLate,
  type ActionResult,
} from '../../shell/tradeActions.ts';
import { refusedLine } from '../../shell/noticeWords.ts';
import { mathOf, ocoMarket, useOco } from '../../shell/tradeContext.ts';
import { usePlacement, placementStore, endPlacement, startPlacement } from '../../state/placement.ts';
import { clearRefusal, useRefusal } from '../../state/refusals.ts';
import { useSetting } from '../../state/runtimeSettings.ts';
import { patchTicket, useTicketSetup } from '../../state/tickets.ts';
import {
  POSITION_BRACKET,
  groupBrackets,
  mergeOffer,
  protectionPairs,
  type BracketMode,
  type ChartMath,
} from '../brackets.ts';
import { breakevenOf, breakevenOffset, breakevenTip } from '../breakeven.ts';
import { noteOnChart } from '../chartNotice.ts';
import { armedUnsentOn, beginPlacement, placementFor } from '../placement.ts';
import { usePlacementKeys } from '../placementRun.ts';
import { bindTicketKeys } from './commands.ts';
import { cancelSelection, positionReadout, tradeRows, workingCount } from './tradeRows.ts';
import { armBase, quickOrder, reverseBracket, reverseOf, reverseTip, reverseWhat, type TicketSend } from './send.ts';
import type { TicketTrade } from './useTicketTrade.ts';
import { read } from '../../app/store.ts';

export interface TicketChart {
  layoutId: string;
  tileId: string;
  instrument: string;
}

export interface TicketChoice {
  as: ExecuteAs;
  root: string;
  instrument: string | null;
  spec: ContractSpec | null;
}

export function useTicketInstrument(chart: TicketChart, accountId: string | null) {
  const { execute } = useTicketSetup(chart.tileId);
  const chartSpec = useInstrumentSpec(chart.instrument);
  const charted = chartSpec?.instrument ?? chart.instrument;
  const family = familyOf(chartSpec);
  const sibling = family ? siblingOf(family) : null;
  const picked = rootFor(execute, family);
  const differs = picked !== null;
  const own = useAccountContract(accountId, charted);
  const other = useAccountContract(accountId, charted, sibling?.root ?? null, sibling !== null);
  const traded = differs ? other : own;
  const instrument = traded.instrument ?? charted;
  const spec = traded.spec ?? (differs ? null : chartSpec);
  const ids = useMemo(
    () =>
      new Set(
        [instrument, differs ? null : chart.instrument, differs ? null : charted].filter((x): x is string => !!x),
      ),
    [instrument, differs, chart.instrument, charted],
  );
  const chartIds = useMemo(
    () => new Set([charted, chart.instrument].filter((x): x is string => !!x)),
    [charted, chart.instrument],
  );
  const chartedRoot = family?.root ?? chartSpec?.root ?? '';
  const choices = useMemo((): TicketChoice[] => {
    const out: TicketChoice[] = [
      { as: 'chart', root: chartedRoot, instrument: own.instrument ?? charted, spec: own.spec ?? chartSpec },
    ];
    if (sibling && (other.instrument !== null || differs))
      out.push({ as: sibling.as, root: sibling.root, instrument: other.instrument, spec: other.spec });
    return out;
  }, [chartedRoot, own.instrument, own.spec, charted, chartSpec, sibling, other.instrument, other.spec, differs]);
  const symbol = traded.instrument
    ? displaySymbol(traded.instrument)
    : differs
      ? sibling!.root
      : displaySymbol(charted);
  const unavailable: string | null =
    accountId === null
      ? null
      : (traded.refused ??
        (traded.pending
          ? `Asking the account's connection for ${symbol}`
          : differs && chartSpec && traded.spec && !mirrors(chartSpec, traded.spec)
            ? `${symbol} does not trade at ${displaySymbol(charted)}'s prices`
            : null));
  return {
    spec,
    instrument,
    ids,
    symbol,
    differs,
    as: differs ? execute : ('chart' as const),
    charted: { instrument: charted, ids: chartIds, symbol: displaySymbol(charted), spec: chartSpec },
    choices,
    unavailable,
  };
}

export type TicketInstrument = ReturnType<typeof useTicketInstrument>;

export function px(v: number | null | undefined, dp: number): string {
  return v === null || v === undefined ? '—' : formatPrice(v, dp);
}

export function chartMathOf(m: ContractMath | null, dp: number): ChartMath {
  return m && m.tick > 0
    ? { decimals: m.decimals, tick: m.tick, multiplier: m.tickValue / m.tick }
    : { decimals: dp, tick: m?.tick ?? 0.01, multiplier: null };
}

export function useBracketMode(): BracketMode {
  return useSetting(POSITION_BRACKET);
}

export function useTicketModel(chart: TicketChart, trade: TicketTrade, inst: TicketInstrument, disabled = false) {
  const { setup, update, positions, orders } = trade;
  const { spec, instrument, ids, symbol } = inst;
  const tradedQuote = useQuote(instrument);
  const chartQuote = useQuote(inst.charted.instrument);
  const quote = tradedQuote ?? chartQuote;
  const feeds = useFeeds();
  const stale = {
    position: streamStale(feeds),
    prices: pricesStale(feeds, quote?.source?.provider ?? null),
  };
  const accountId = update?.account.id ?? null;
  const root = instrument ? instrumentRoot(instrument, spec?.root ?? null) : null;
  const math = mathOf(spec ?? null, instrument);
  const dp = math?.decimals ?? 2;
  const { oco, set: setOco } = useOco(accountId, root);
  const risking = setup.sizing === 'risk';
  const qty = risking ? 1 : setup.qty;
  const market = ocoMarket(math, qty, update);
  const report = (r: ActionResult | null, retry?: () => void) => {
    if (r) noteOnChart(chart, r, { account: update?.account.displayName ?? null, retry });
  };
  const heldNow = useSyncExternalStore(heldOrderIntents().subscribe, () => heldOrderIntents().getSnapshot());
  const mine = useRef<string | null>(null);
  useEffect(
    () =>
      watchOrderLate((update) => {
        if (mine.current !== update.key) return;
        mine.current = null;
      }),
    [],
  );
  const connections = useConnectionList(accountId !== null);
  const runtime = useRuntimeEntry();
  const runtimeWhy = runtime.open ? null : runtime.why;

  const last = quote?.last ?? null;
  const bid = quote?.bid ?? null;
  const ask = quote?.ask ?? null;
  const priced = last !== null || bid !== null || ask !== null;
  const plan = market ? planOco(oco, market) : null;
  const buyAt = marketReference('buy', quote);
  const sideErrors = (side: Side) => {
    if (!market) return [];
    const at = marketReference(side, quote);
    return bracketSideErrors(side, at, ocoBracket(side, at, oco, market), dp);
  };
  const shownErrors = [...new Set([...sideErrors('buy'), ...sideErrors('sell')])];
  const lockedLine = limitLockWords(update);
  const planBlocks = plan !== null && oco.on && !planOk(plan);
  const blocked =
    disabled || runtimeWhy !== null || !instrument || inst.unavailable !== null || lockedLine !== null || planBlocks;
  const noQuote = inst.unavailable ?? (priced ? null : `No price for ${symbol} yet`);
  const entryWhy = disabled
    ? 'Connect an account to trade'
    : (runtimeWhy ?? inst.unavailable ?? lockedLine ?? (planBlocks ? 'Fix the bracket first' : null));
  const why = entryWhy ?? (priced ? null : `No price for ${symbol} yet`);

  const stopRisk = risking
    ? setup.risk
    : oco.on && oco.stop.on && plan?.stopTicks !== null && plan?.stopTicks !== undefined && market
      ? plan.stopTicks * tickMoney(market)
      : null;

  const placing = usePlacement((s) => s.placing);
  const placingHere = placementFor(placing, accountId, ids, chart);
  const brackets = useMemo(() => groupBrackets(orders, positions, [], ids), [orders, positions, ids]);
  const cm = useMemo(() => chartMathOf(math, dp), [math, dp]);
  const mode = useBracketMode();
  const rows = useMemo(() => tradeRows(brackets, cm, { position: false, mode }), [brackets, cm, mode]);
  const position = useMemo(() => positionReadout(brackets, cm), [brackets, cm]);
  const riskLine = limitLine(update, {
    stopRisk,
    qty: risking ? null : setup.qty,
    position: position.qty,
  });
  const working = workingCount(rows);
  usePlacementKeys(placingHere !== null, brackets, report);

  const [armedBy, setArmedBy] = useState<GridOrder | null>(null);
  const armedNow = placingHere !== null;
  useEffect(() => {
    if (!armedNow) setArmedBy(null);
  }, [armedNow]);

  const ticketKey = [
    accountId,
    instrument,
    setup.sizing,
    setup.qty,
    setup.risk,
    setup.stopLimitTicks,
    JSON.stringify(oco),
  ].join('|');
  const { layoutId, tileId } = chart;
  useEffect(
    () => () => {
      if (armedUnsentOn(read(placementStore).placing, { layoutId, tileId })) endPlacement();
    },
    [ticketKey, layoutId, tileId],
  );
  const refused = useRefusal(accountId, ids);
  const refusal = refused ? refusedLine(refused, update?.account.displayName ?? null) : null;
  useEffect(() => () => clearRefusal(accountId), [ticketKey, accountId, position.qty, working]);

  const touchAt = (side: Side) => (side === 'buy' ? bid : ask);

  const send: TicketSend | null =
    update && instrument && math
      ? {
          account: update,
          instrument,
          symbol,
          math,
          setup,
          oco,
          quote,
          brackets,
          mode,
          tile: { layoutId: chart.layoutId, tileId: chart.tileId },
        }
      : null;

  const arm = (side: Side, o: GridOrder, price: number | null = null) => {
    if (!send || blocked) return;
    setArmedBy(o);
    startPlacement(beginPlacement(armBase(send, side, o), price));
  };

  const sendNow = async (side: Side, o: 'market' | 'touch') => {
    if (!send || !market || blocked) return;
    if (o === 'touch' && touchAt(side) === null) return;
    const q = quickOrder(send, side, o);
    if ('error' in q) {
      report({ tone: 'err', text: q.error });
      return;
    }
    const intent = orderIntentKey('orders.submit', q.input);
    mine.current = intent;
    report(await submitOrder(send.account.account.environment, q.input, q.what, dp));
    if (!isOrderHeld(intent)) mine.current = null;
  };

  const armed = (side: Side, o: GridOrder): boolean =>
    placingHere !== null &&
    placingHere.side === side &&
    placingHere.kind === gridKind(o) &&
    (armedBy !== null ? armedBy === o : o !== 'touch');

  const press = (side: Side, o: GridOrder) => {
    if (armed(side, o)) {
      endPlacement();
      return;
    }
    if (gridPress(o, risking) === 'send') void sendNow(side, o === 'touch' ? 'touch' : 'market');
    else arm(side, o, o === 'touch' ? touchAt(side) : null);
  };

  const stopLimitOffered = takesOrderType(update?.account ?? null, connections, 'stop_limit');

  const entryHeld = (side: Side, o: 'market' | 'touch'): boolean => {
    if (!send || !market) return false;
    if (o === 'touch' && touchAt(side) === null) return false;
    const q = quickOrder(send, side, o);
    if ('error' in q) return false;
    return heldNow.has(orderIntentKey('orders.submit', q.input));
  };

  const marketWaits = (side: Side, o: GridOrder): boolean =>
    o === 'market' && pricesDown(feeds, quote?.source?.provider ?? null) && opensContracts(side, qty, position.qty);

  const off = (side: Side, o: GridOrder): boolean => {
    if (blocked || marketWaits(side, o)) return true;
    if (gridPress(o, risking) === 'send' && entryHeld(side, o === 'touch' ? 'touch' : 'market')) return true;
    if (o === 'touch') return touchAt(side) === null;
    if (o === 'stop_limit' && !stopLimitOffered) return true;
    return noQuote !== null;
  };

  const tip = (side: Side, o: GridOrder): string => {
    if (o === 'stop_limit' && !stopLimitOffered && !why)
      return `${update?.account.displayName ?? 'This account'} takes no stop limit orders`;
    return gridTip(side, o, {
      size: risking ? { risk: formatMoney(setup.risk) } : { qty: setup.qty },
      touch: touchAt(side) === null ? null : px(touchAt(side), dp),
      limitTicks: setup.stopLimitTicks,
      bracket: oco.on && ((oco.stop.on && !risking) || oco.target.on),
      why: o === 'touch' ? entryWhy : (why ?? (marketWaits(side, o) ? MARKET_WAITS : null)),
    });
  };

  const exitsOff = disabled || runtimeWhy !== null || !accountId || !instrument;
  const toCancel = cancelSelection(rows);
  const cancelOff = exitsOff || toCancel.orders.length === 0;
  const flatOff = exitsOff || (position.qty === 0 && working === 0);
  const kept = `the position’s stop and target stay (× one, or Flat)`;
  const cancelTip =
    runtimeWhy ??
    (toCancel.orders.length === 0
      ? toCancel.kept > 0
        ? `Nothing to cancel on ${symbol}: ${kept}`
        : `No working ${symbol} orders`
      : toCancel.kept > 0
        ? `Cancel the working ${toCancel.orders.length === 1 ? 'order' : 'orders'} on ${symbol}; ${kept}`
        : `Cancel ${toCancel.orders.length === 1 ? 'the working order' : 'every working order'} on ${symbol}`);
  const flatTip =
    runtimeWhy ??
    (flatOff
      ? `Flat on ${symbol}`
      : position.qty === 0
        ? `Cancel the working ${symbol} orders`
        : `Close the ${position.qty > 0 ? 'long' : 'short'} ${String(Math.abs(position.qty))} ${symbol} at market and cancel its orders`);
  const cancelHere = () => {
    if (cancelOff || !accountId || !instrument) return;
    void cancelWorking(accountId, instrument, symbol, toCancel).then((r) => report(r, cancelHere));
  };
  const flattenHere = () => {
    if (!flatOff && accountId && instrument)
      void flatten(accountId, position.instrument ?? instrument, symbol).then((r) => report(r, flattenHere));
  };
  const posBracket = brackets.find((b) => b.kind === 'position') ?? null;
  const beOffset = breakevenOffset(oco);
  const be = breakevenOf(posBracket, math?.tick ?? 0, beOffset);
  const [beBusy, setBeBusy] = useState(false);
  const beOff = exitsOff || be.why !== null || beBusy;
  const beTip = runtimeWhy ?? (exitsOff ? 'Breakeven' : breakevenTip(be, dp));
  const breakevenHere = () => {
    if (beOff || !accountId || !posBracket) return;
    setBeBusy(true);
    void breakeven(accountId, posBracket.instrument, symbol, beOffset, dp).then((r) => {
      setBeBusy(false);
      report(r, r.tone === 'err' ? breakevenHere : undefined);
    });
  };
  const beKeys = useRef({ breakevenHere, beOff });
  useEffect(() => {
    beKeys.current = { breakevenHere, beOff };
  });
  useEffect(
    () =>
      disabled
        ? undefined
        : bindTicketKeys({
            breakeven: () => beKeys.current.breakevenHere(),
            canBreakeven: () => !beKeys.current.beOff,
          }),
    [disabled],
  );
  const rev = reverseOf(posBracket);
  const [revBusy, setRevBusy] = useState(false);
  const revWhy = rev.why ?? inst.unavailable ?? lockedLine;
  const revOff = exitsOff || revWhy !== null || revBusy;
  const revTip =
    runtimeWhy ??
    (exitsOff ? 'Reverse' : (revWhy ?? reverseTip(rev, symbol, oco.on && (oco.stop.on || oco.target.on))));
  const reverseHere = () => {
    if (revOff || !send || !posBracket) return;
    const what = reverseWhat(rev, symbol);
    const bracket = reverseBracket(send, rev);
    setRevBusy(true);
    const { account } = send;
    void reverse(account.account.environment, account.account.id, posBracket.instrument, bracket, what, dp).then(
      (r) => {
        setRevBusy(false);
        report(r);
      },
    );
  };
  const cancelRows = (list: readonly Order[]) => void cancelOrders(list).then((r) => r.tone === 'err' && report(r));
  const toMerge = disabled ? null : mergeOffer(brackets, mode);
  const [merging, setMerging] = useState(false);
  const merge = toMerge
    ? {
        pairs: protectionPairs(toMerge).length,
        busy: merging,
        onMerge: () => {
          if (!accountId || merging) return;
          setMerging(true);
          void mergeBrackets(accountId, toMerge.instrument, symbol).then((r) => {
            setMerging(false);
            report(r);
          });
        },
      }
    : null;

  const stepQty = (n: number) => patchTicket(chart.tileId, { qty: Math.max(1, setup.qty + n) });
  const stepRisk = (n: number) => patchTicket(chart.tileId, { risk: Math.max(5, setup.risk + n * 25) });

  return {
    setup,
    update,
    accountId,
    runtimeWhy,
    symbol,
    dp,
    oco,
    setOco,
    risking,
    market,
    plan,
    bid,
    ask,
    stale,
    buyAt,
    shownErrors,
    lockedLine,
    refusal,
    riskLine,
    rows,
    merge,
    position,
    armed,
    press,
    off,
    tip,
    cancelOff,
    flatOff,
    beOff,
    revOff,
    cancelTip,
    flatTip,
    beTip,
    revTip,
    cancelHere,
    flattenHere,
    breakevenHere,
    reverseHere,
    cancelRows,
    stepQty,
    stepRisk,
  };
}

export type TicketModel = ReturnType<typeof useTicketModel>;
