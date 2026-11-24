import type { Bracket as OrderBracket, Environment, Order, OrderInput, Side } from '@tessera/protocol';
import { detectPlatform, formatPrice, formatShortcut, type Platform, formatMoney } from '@tessera/ui';
import {
  bracketSideErrors,
  expectedFill,
  hasLegs,
  legAt,
  legsFrom,
  moneyTicks,
  tickLegs,
  withLegPrice,
  type ContractMath,
} from '../shell/oco.ts';
import { KIND_WORD, STOP_LIMIT_TICKS, orderInput, stopLimitPrice, toTick, type EntryKind } from '../shell/ticket.ts';
import { effectiveLeg, legTagId, type Bracket, type Leg, type LegRole } from './brackets.ts';

type PlaceStage = 'send' | 'entry' | 'stop' | 'target';

export interface PlaceQuote {
  bid: number | null;
  ask: number | null;
  last: number | null;
}

export interface Placement {
  accountId: string;
  environment: Environment;
  instrument: string;
  symbol: string;
  side: Side;
  qty: number;
  kind: EntryKind;
  tick: number;
  decimals: number;
  stage: PlaceStage;
  entry: number | null;
  orderId: string | null;
  stop: number | null;
  error: string | null;
  busy: boolean;
  mode: 'qty' | 'risk';
  risk: number;
  tickValue: number;
  stopTicks: number | null;
  targetTicks: number | null;
  targetMoney?: number | null;
  limitTicks?: number;
  joinStop?: number | null;
  tileId?: string;
  layoutId?: string;
}

export interface PlaceTile {
  layoutId: string;
  tileId: string;
}

export function placementFor(
  placing: Placement | null,
  accountId: string | null,
  ids: ReadonlySet<string>,
  at: PlaceTile | null,
): Placement | null {
  if (placing?.accountId !== accountId || !ids.has(placing.instrument)) return null;
  if (placing.tileId === undefined) return placing;
  return at !== null && placing.tileId === at.tileId && placing.layoutId === at.layoutId ? placing : null;
}

export function armedUnsentOn(p: Placement | null, at: PlaceTile): boolean {
  return !!p && !p.busy && p.orderId === null && p.tileId === at.tileId && p.layoutId === at.layoutId;
}

export type PlaceBase = Omit<Placement, 'stage' | 'entry' | 'orderId' | 'stop' | 'error' | 'busy'>;

export function ticketPlaceBase(o: {
  accountId: string;
  environment: Environment;
  contract: { instrument: string; symbol: string; math: ContractMath };
  side: Side;
  kind: EntryKind;
  ticket: { qty: number; sizing: 'qty' | 'risk'; risk: number };
  stopTicks: number | null;
  targetTicks: number | null;
  targetMoney?: number | null;
  limitTicks?: number;
  joinStop?: number | null;
  tile: PlaceTile;
}): PlaceBase {
  const { contract, ticket } = o;
  return {
    accountId: o.accountId,
    environment: o.environment,
    instrument: contract.instrument,
    symbol: contract.symbol,
    side: o.side,
    qty: ticket.qty,
    kind: o.kind,
    tick: contract.math.tick,
    decimals: contract.math.decimals,
    mode: ticket.sizing,
    risk: ticket.risk,
    tickValue: contract.math.tickValue,
    stopTicks: o.stopTicks,
    targetTicks: o.targetTicks,
    ...(o.targetMoney !== undefined && o.targetMoney !== null ? { targetMoney: o.targetMoney } : {}),
    ...(o.limitTicks !== undefined ? { limitTicks: o.limitTicks } : {}),
    ...(o.joinStop !== undefined && o.joinStop !== null && ticket.sizing === 'risk' ? { joinStop: o.joinStop } : {}),
    tileId: o.tile.tileId,
    layoutId: o.tile.layoutId,
  };
}

function joinedStop(p: Pick<Placement, 'mode' | 'joinStop'>): number | null {
  return p.mode === 'risk' ? (p.joinStop ?? null) : null;
}

export function beginPlacement(base: PlaceBase, entry: number | null = null): Placement {
  const priced = base.kind !== 'market';
  const known = !priced || entry !== null;
  return {
    ...base,
    stage: !known ? 'entry' : base.mode === 'risk' && joinedStop(base) === null ? 'stop' : 'send',
    entry: priced ? entry : null,
    orderId: null,
    stop: null,
    error: null,
    busy: false,
  };
}

export function placeAfterEntry(base: PlaceBase, orderId: string, fill: number | null): Placement {
  return { ...base, stage: 'stop', entry: fill, orderId, stop: null, error: null, busy: false };
}

export type PlaceStep =
  | { kind: 'error'; next: Placement }
  | { kind: 'next'; next: Placement }
  | { kind: 'send'; next: Placement; input: OrderInput; what: string }
  | { kind: 'attach'; next: Placement | null; role: LegRole; price: number; what: string }
  | { kind: 'end'; next: null };

function placedEntry(p: Placement): boolean {
  return p.orderId !== null;
}

const SIDE_WORD: Record<Side, string> = { buy: 'Buy', sell: 'Sell' };
const ROLE_WORD: Record<LegRole, string> = { stop: 'Stop', target: 'Target' };

function touchOf(side: Side, q: PlaceQuote): number | null {
  return (side === 'buy' ? q.ask : q.bid) ?? q.last;
}

export function placementLimit(p: Pick<Placement, 'kind' | 'side' | 'entry' | 'tick' | 'limitTicks'>): number | null {
  if (p.kind !== 'stop_limit' || p.entry === null) return null;
  return stopLimitPrice(p.side, p.entry, p.limitTicks ?? STOP_LIMIT_TICKS, p.tick);
}

function entryReference(p: Placement): number | null {
  return p.kind === 'stop_limit' ? placementLimit(p) : p.entry;
}

function placeReference(p: Placement, q: PlaceQuote, filled: boolean): number | null {
  if (!placedEntry(p)) {
    return expectedFill(p.side, p.kind, entryReference(p), touchOf(p.side, q));
  }
  if (filled || p.kind === 'market') return q.last ?? p.entry;
  return entryReference(p);
}

function entryError(side: Side, kind: EntryKind, price: number, q: PlaceQuote, decimals: number): string | null {
  const touch = touchOf(side, q);
  if (touch === null || kind === 'market') return null;
  const px = formatPrice(touch, decimals);
  const word = side === 'buy' ? 'ask' : 'bid';
  if (kind === 'limit') {
    const crosses = side === 'buy' ? price >= touch : price <= touch;
    return crosses
      ? `A ${side} limit at ${formatPrice(price, decimals)} is through the ${word} (${px}): it would fill at once. Click ${side === 'buy' ? 'below' : 'above'} it`
      : null;
  }
  const through = side === 'buy' ? price <= touch : price >= touch;
  return through
    ? `A ${side} ${KIND_WORD[kind]} at ${formatPrice(price, decimals)} is through the ${word} (${px}): it would trigger at once. Click ${side === 'buy' ? 'above' : 'below'} it`
    : null;
}

export interface PricedEntry {
  price: number;
  error: string | null;
  note: string | null;
}

export function pricedEntry(side: Side, kind: EntryKind, price: number, q: PlaceQuote, decimals: number): PricedEntry {
  const touch = touchOf(side, q);
  if (kind === 'limit' && touch !== null && (side === 'buy' ? price >= touch : price <= touch)) {
    const word = side === 'buy' ? 'ask' : 'bid';
    return {
      price: touch,
      error: null,
      note: `${SIDE_WORD[side]} limit at the ${word}, ${formatPrice(touch, decimals)}: it fills now`,
    };
  }
  return { price, error: kind === 'market' ? null : entryError(side, kind, price, q, decimals), note: null };
}

export function legError(
  side: Side,
  role: LegRole,
  price: number,
  ref: number | null,
  decimals: number,
): string | null {
  const b: OrderBracket =
    role === 'stop' ? { stopLoss: price, takeProfit: null } : { stopLoss: null, takeProfit: price };
  return bracketSideErrors(side, ref, b, decimals)[0] ?? null;
}

export function legMoveError(
  b: Bracket,
  role: LegRole,
  price: number,
  last: number | null,
  decimals: number,
): string | null {
  const ref = b.kind === 'position' ? last : b.kind === 'pending' ? b.price : null;
  return legError(b.side, role, price, ref, decimals);
}

function entryWhat(p: Placement, price: number | null): string {
  const limit = placementLimit(p);
  const at =
    p.kind === 'market'
      ? 'at market'
      : p.kind === 'stop_limit'
        ? `stop ${formatPrice(price, p.decimals)} limit ${formatPrice(limit, p.decimals)}`
        : `${p.kind} ${formatPrice(price, p.decimals)}`;
  return `${SIDE_WORD[p.side]} ${String(p.qty)} ${p.symbol} ${at}`;
}

export function placedTargetTicks(
  p: Pick<Placement, 'mode' | 'targetTicks' | 'targetMoney' | 'tickValue' | 'qty'>,
): number | null {
  if (p.targetTicks === null) return null;
  if (p.mode !== 'risk' || p.targetMoney === undefined || p.targetMoney === null || p.qty < 1) return p.targetTicks;
  return moneyTicks(p.targetMoney, p.tickValue, p.qty);
}

function sendEntry(p: Placement, stop: number | null, q?: PlaceQuote): PlaceStep {
  const ref = p.kind === 'market' ? (q ? touchOf(p.side, q) : null) : entryReference(p);
  const joined = joinedStop(p);
  if (joined !== null && stop === null) {
    const err = legError(p.side, 'stop', joined, ref, p.decimals);
    if (err) return { kind: 'error', next: { ...p, error: `The position's stop: ${err}` } };
    const qty = riskQty(p, ref, joined);
    if (qty < 1) {
      return {
        kind: 'error',
        next: { ...p, error: `${oneContract(p, ref, joined, "the position's stop")}: raise the risk or move the stop` },
      };
    }
    return sendEntry({ ...p, qty, joinStop: null, mode: 'risk' }, joined, q);
  }
  const autoStopTicks = stop === null && p.mode === 'qty' && ref !== null ? p.stopTicks : null;
  const from = ref === null ? null : legsFrom(p.side, p.kind, entryReference(p), q ? touchOf(p.side, q) : null);
  const auto =
    from === null ? null : tickLegs(p.side, from, p.tick, { stop: autoStopTicks, target: placedTargetTicks(p) });
  const set = stop !== null ? withLegPrice(auto ?? { stopLoss: null, takeProfit: null }, 'stop', stop) : auto;
  const bracket = hasLegs(set) ? set : null;
  stop = stop ?? (bracket && ref !== null ? legAt(bracket, 'stop', p.side, ref, p.tick) : null);
  const input = orderInput({
    accountId: p.accountId,
    instrument: p.instrument,
    side: p.side,
    kind: p.kind,
    price: p.entry,
    limit: placementLimit(p),
    qty: p.qty,
    bracket,
  });
  return {
    kind: 'send',
    next: { ...p, stage: 'target', stop, error: null, busy: true },
    input,
    what: entryWhat(p, p.entry),
  };
}

export function placeAt(p: Placement, raw: number, q: PlaceQuote, filled: boolean): PlaceStep {
  if (p.busy) return { kind: 'error', next: p };
  const price = toTick(raw, p.tick);
  if (p.stage === 'send') return sendEntry(p, null, q);
  if (p.stage === 'entry') {
    const at = pricedEntry(p.side, p.kind, price, q, p.decimals);
    if (at.error) return { kind: 'error', next: { ...p, error: at.error } };
    const priced = { ...p, entry: at.price, error: null };
    return p.mode === 'risk' && joinedStop(p) === null
      ? { kind: 'next', next: { ...priced, stage: 'stop' } }
      : sendEntry(priced, null, q);
  }
  const role: LegRole = p.stage === 'stop' ? 'stop' : 'target';
  const ref = placeReference(p, q, filled);
  const err = legError(p.side, role, price, ref, p.decimals);
  if (err) return { kind: 'error', next: { ...p, error: err } };
  if (role === 'stop' && !placedEntry(p)) {
    if (p.mode !== 'risk') return sendEntry(p, price, q);
    const refused = riskRefusal(p, ref, price);
    if (refused) return { kind: 'error', next: { ...p, error: refused } };
    return sendEntry({ ...p, qty: riskQty(p, ref, price) }, price, q);
  }
  return {
    kind: 'attach',
    next: role === 'stop' ? { ...p, stage: 'target', stop: price, error: null, busy: true } : null,
    role,
    price,
    what: `${ROLE_WORD[role]} ${formatPrice(price, p.decimals)} on ${p.symbol}`,
  };
}

export interface PlaceClick {
  placement: Placement;
  step: PlaceStep;
  fresh: boolean;
}

export function clickAt(
  placing: Placement | null,
  start: (PlaceBase & { side: Side }) | null,
  raw: number,
  q: PlaceQuote,
  filled: boolean,
): PlaceClick | null {
  if (placing) return { placement: placing, step: placeAt(placing, raw, q, filled), fresh: false };
  if (!start) return null;
  const placement = beginPlacement({ ...start, kind: start.kind === 'market' ? 'limit' : start.kind }, null);
  return { placement, step: placeAt(placement, raw, q, false), fresh: true };
}

export function entryKindAt(side: Side, price: number, q: PlaceQuote): EntryKind {
  const touch = touchOf(side, q);
  if (touch === null) return 'limit';
  return side === 'buy' ? (price < touch ? 'limit' : 'stop') : price > touch ? 'limit' : 'stop';
}

type RiskSizing = Pick<Placement, 'risk' | 'tick' | 'tickValue'>;

function contractRisk(p: RiskSizing, entry: number | null, stop: number): number | null {
  if (entry === null || !(p.tickValue > 0)) return null;
  const ticks = Math.round(Math.abs(entry - stop) / p.tick);
  return ticks > 0 ? ticks * p.tickValue : null;
}

export function riskQty(p: RiskSizing, entry: number | null, stop: number): number {
  const per = contractRisk(p, entry, stop);
  return per === null ? 0 : Math.floor(p.risk / per + 1e-9);
}

function oneContract(p: RiskSizing, entry: number | null, stop: number, to: string): string {
  const per = contractRisk(p, entry, stop);
  const at = formatMoney(p.risk);
  return per === null
    ? `No contract fits ${at} at risk to ${to}`
    : `One contract to ${to} risks ${formatMoney(per)}, over the ${at} at risk`;
}

function riskRefusal(p: RiskSizing, entry: number | null, stop: number): string | null {
  if (riskQty(p, entry, stop) >= 1) return null;
  return `${oneContract(p, entry, stop, 'this stop')}: click it closer`;
}

export function placeKey(p: Placement, key: string): PlaceStep | null {
  if (key === 'Escape') return { kind: 'end', next: null };
  if (key !== 'Enter' || p.busy) return null;
  if (p.stage === 'stop' && !placedEntry(p)) {
    if (p.mode === 'risk' || (p.kind !== 'market' && p.entry === null)) return null;
    return sendEntry(p, null);
  }
  return null;
}

export function placeHint(p: Placement, platform: Platform = detectPlatform()): string {
  const entry = `${p.side} ${KIND_WORD[p.kind]}`;
  const joined = joinedStop(p);
  const sized =
    joined !== null ? `: ${formatMoney(p.risk)} at risk to the position's stop ${formatPrice(joined, p.decimals)}` : '';
  if (p.stage === 'send' && joined !== null) return `Click the chart to ${p.side} at market${sized} · Esc cancels`;
  if (p.stage === 'send') return `Click the chart to ${p.side} ${String(p.qty)} at market · Esc cancels`;
  if (p.stage === 'entry') {
    const where =
      p.kind === 'stop' || p.kind === 'stop_limit'
        ? p.side === 'buy'
          ? ', above the ask'
          : ', below the bid'
        : p.side === 'buy'
          ? ' (above the ask it goes at the ask)'
          : ' (below the bid it goes at the bid)';
    if (p.kind === 'stop_limit') {
      const n = Math.max(0, Math.round(p.limitTicks ?? STOP_LIMIT_TICKS));
      const limit =
        n === 0
          ? 'its limit at it'
          : `its limit ${String(n)} ${n === 1 ? 'tick' : 'ticks'} ${p.side === 'buy' ? 'above' : 'below'}`;
      return `Click the ${entry}'s stop${where}, ${limit}${sized} · Esc cancels`;
    }
    return `Click the ${entry}'s price${where}${sized} · Esc cancels`;
  }
  if (p.stage === 'stop' && !placedEntry(p) && p.mode === 'risk')
    return `Click the stop: ${formatMoney(p.risk)} at risk sizes it · Esc cancels`;
  if (p.stage === 'stop' && !placedEntry(p)) {
    const goes = p.kind === 'market' ? `the ${p.side} at market goes with it` : `the ${entry} goes with it`;
    return `Click to place the stop: ${goes} · ${formatShortcut('enter', platform)} without a stop · Esc cancels`;
  }
  if (p.stage === 'stop') return 'Click to place the stop · Esc to skip';
  return 'Click to place the target · Esc to skip';
}

export function chartHint(
  place: Placement | null,
  why: string | null,
  spawnError: string | null,
  note: string | null = null,
): { text: string; tone: 'err' | 'info' | undefined } | null {
  if (place) {
    if (why) return { text: why, tone: 'err' };
    return note ? { text: `${note} · Esc cancels`, tone: 'info' } : { text: placeHint(place), tone: undefined };
  }
  if (spawnError) return { text: spawnError, tone: 'err' };
  return null;
}

export function placeGuide(
  p: Placement,
  raw: number,
  q: PlaceQuote,
  filled: boolean,
): { price: number; role: 'entry' | LegRole; error: string | null; note: string | null } {
  const price = toTick(raw, p.tick);
  if (p.stage === 'send') return { price, role: 'entry', error: null, note: null };
  if (p.stage === 'entry') {
    const at = pricedEntry(p.side, p.kind, price, q, p.decimals);
    return { price: at.price, role: 'entry', error: at.error, note: at.note };
  }
  const role: LegRole = p.stage === 'stop' ? 'stop' : 'target';
  const ref = placeReference(p, q, filled);
  const sized = role === 'stop' && !placedEntry(p) && p.mode === 'risk';
  return {
    price,
    role,
    error: legError(p.side, role, price, ref, p.decimals) ?? (sized ? riskRefusal(p, ref, price) : null),
    note: null,
  };
}

export type LegHost =
  | { kind: 'position'; bracketId: string; accountId: string; instrument: string; side: Side; qty: number }
  | { kind: 'entry'; bracketId: string; order: Order; side: Side; stopLoss: number | null; takeProfit: number | null };

export function legHostOf(b: Bracket, accountId: string | null): LegHost | null {
  if (b.kind === 'position') {
    if (!accountId) return null;
    return { kind: 'position', bracketId: b.id, accountId, instrument: b.instrument, side: b.side, qty: b.qty };
  }
  if ((b.kind === 'pending' || b.kind === 'order') && b.entry?.role === 'entry') {
    if (b.entry.request.reduceOnly) return null;
    const stop = effectiveLeg(b, 'stop');
    const target = effectiveLeg(b, 'target');
    return {
      kind: 'entry',
      bracketId: b.id,
      order: b.entry,
      side: b.side,
      stopLoss: stop?.price ?? null,
      takeProfit: target?.price ?? null,
    };
  }
  return null;
}

export function dragRole(side: Side, from: number, to: number): LegRole | null {
  if (to === from) return null;
  const down = to < from;
  return side === 'buy' ? (down ? 'stop' : 'target') : down ? 'target' : 'stop';
}

export function spawnPlan(
  b: Bracket,
  from: number,
  to: number,
): { role: LegRole; move: { tagId: string; from: number; orders: Order[] } | null } | null {
  const role = dragRole(b.side, from, to);
  if (!role) return null;
  const legs = role === 'stop' ? b.stops : b.targets;
  if (legs.length === 0) return { role, move: null };
  const lead = effectiveLeg(b, role)!;
  if (!lead.order) return null;
  return { role, move: { tagId: legTagId(b, role, lead), from: lead.price, orders: [lead.order] } };
}

export function hostReference(host: LegHost, entryPrice: number, last: number | null): number | null {
  return host.kind === 'position' ? last : entryPrice;
}

export function exitInput(
  host: Extract<LegHost, { kind: 'position' }>,
  role: LegRole,
  price: number,
  qty = host.qty,
): OrderInput {
  return orderInput({
    accountId: host.accountId,
    instrument: host.instrument,
    side: host.side === 'buy' ? 'sell' : 'buy',
    kind: role === 'stop' ? 'stop' : 'limit',
    price,
    qty: Math.min(qty, host.qty),
    bracket: null,
    reduceOnly: true,
  });
}

export function replaceInput(host: Extract<LegHost, { kind: 'entry' }>, role: LegRole, price: number): OrderInput {
  return entryWithLegs(
    host.order,
    role === 'stop' ? price : host.stopLoss,
    role === 'target' ? price : host.takeProfit,
  );
}

export function entryWithLegs(entry: Order, stopLoss: number | null, takeProfit: number | null): OrderInput {
  const r = entry.request;
  const remaining = entry.status === 'partially_filled' ? r.qty - entry.filledQty : r.qty;
  const { stopTicks: _stop, targetTicks: _target, ...kept } = r.bracket ?? { stopLoss: null, takeProfit: null };
  const bracket: OrderBracket = { ...kept, stopLoss, takeProfit };
  if (bracket.stopLoss === null) {
    delete bracket.breakeven;
    delete bracket.trail;
  }
  return {
    accountId: r.accountId,
    instrument: r.instrument,
    side: r.side,
    qty: remaining,
    orderType: r.orderType,
    ...(r.limitPrice !== null ? { limitPrice: r.limitPrice } : {}),
    ...(r.stopPrice !== null ? { stopPrice: r.stopPrice } : {}),
    tif: r.tif,
    ...(stopLoss !== null || takeProfit !== null ? { bracket } : {}),
  };
}

export function placementHost(p: Placement, brackets: readonly Bracket[]): { host: LegHost; filled: boolean } | null {
  if (p.orderId) {
    const working = brackets.find((b) => b.entry?.id === p.orderId);
    const host = working ? legHostOf(working, p.accountId) : null;
    if (host) return { host, filled: false };
  }
  const pos = brackets.find((b) => b.kind === 'position' && b.side === p.side);
  const host = pos ? legHostOf(pos, p.accountId) : null;
  return host ? { host, filled: true } : null;
}

export interface Ghost {
  host: { id: string } | { entry: { side: Side; price: number; qty: number; type: string } };
  legs: readonly { role: LegRole; price: number }[];
}

export const GHOST_ID = 'placing';

export function withGhost(brackets: readonly Bracket[], g: Ghost | null): Bracket[] {
  if (!g) return [...brackets];
  const leg = (b: Bracket, role: LegRole, price: number): Leg => ({
    order: null,
    role,
    price,
    qty: b.qty,
    held: b.kind === 'pending',
  });
  const add = (b: Bracket): Bracket => ({
    ...b,
    stops: [...b.stops, ...g.legs.filter((l) => l.role === 'stop').map((l) => leg(b, 'stop', l.price))],
    targets: [...b.targets, ...g.legs.filter((l) => l.role === 'target').map((l) => leg(b, 'target', l.price))],
  });
  if ('id' in g.host) {
    const id = g.host.id;
    return brackets.map((b) => (b.id === id ? add(b) : b));
  }
  const e = g.host.entry;
  const ghost: Bracket = {
    id: GHOST_ID,
    kind: 'pending',
    instrument: '',
    side: e.side,
    price: e.price,
    qty: e.qty,
    since: null,
    entry: null,
    type: e.type,
    stops: [],
    targets: [],
    pnl: null,
    draftId: null,
  };
  return [...brackets, add(ghost)];
}

export function placementGhost(
  p: Placement,
  price: number | null,
  brackets: readonly Bracket[],
  q: PlaceQuote,
): Ghost | null {
  const role: LegRole | null = p.stage === 'stop' ? 'stop' : p.stage === 'target' ? 'target' : null;
  const hover = price !== null && role ? [{ role, price: toTick(price, p.tick) }] : [];
  if (placedEntry(p)) {
    const at = placementHost(p, brackets);
    if (at) return hover.length ? { host: { id: at.host.bracketId }, legs: hover } : null;
  }
  const entry =
    p.stage === 'entry'
      ? price !== null
        ? pricedEntry(p.side, p.kind, toTick(price, p.tick), q, p.decimals).price
        : null
      : (p.entry ?? placeReference({ ...p, orderId: null }, q, false));
  if (entry === null) return null;
  const legs = [...(p.stop !== null ? [{ role: 'stop' as const, price: p.stop }] : []), ...hover];
  const at = hover[0];
  const sizedFrom = p.kind === 'stop_limit' ? (placementLimit({ ...p, entry }) ?? entry) : entry;
  const joined = joinedStop(p);
  const qty =
    joined !== null
      ? Math.max(1, riskQty(p, sizedFrom, joined))
      : p.mode === 'risk' && at?.role === 'stop'
        ? Math.max(1, riskQty(p, sizedFrom, at.price))
        : p.qty;
  return { host: { entry: { side: p.side, price: entry, qty, type: KIND_WORD[p.kind] } }, legs };
}
