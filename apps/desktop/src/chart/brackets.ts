import type { BracketLine, BracketZone, OrderScene, OrderTagSpec } from '@tessera/chart';
import type { DraftInfo, Order, OrderRequest, Position, Side } from '@tessera/protocol';
import { formatMoney, formatPrice } from '@tessera/ui';
import { orderPreviewOf, type AccountRef } from '../app/orders.ts';
import { draftLeg } from '../shell/oco.ts';
import { withAlpha } from './levelSettings.ts';

export type LegRole = 'stop' | 'target';

export interface Leg {
  order: Order | null;
  role: LegRole;
  price: number;
  qty: number;
  held: boolean;
  pair?: string | null;
}

type BracketKind = 'position' | 'pending' | 'order' | 'draft';

export interface Bracket {
  id: string;
  kind: BracketKind;
  instrument: string;
  side: Side;
  price: number;
  qty: number;
  since: number | null;
  entry: Order | null;
  type: string | null;
  stops: Leg[];
  targets: Leg[];
  pnl: number | null;
  draftId: string | null;
}

export interface ChartMath {
  decimals: number;
  tick: number;
  multiplier: number | null;
}

const OPEN_STATUSES = new Set(['pending_submit', 'held', 'working', 'partially_filled', 'pending_cancel']);

export function restingPrice(r: OrderRequest): number | null {
  if (r.orderType === 'stop' || r.orderType === 'stop_limit') return r.stopPrice;
  if (r.orderType === 'limit') return r.limitPrice;
  return null;
}

function remaining(o: Order): number {
  return o.status === 'partially_filled' ? o.request.qty - o.filledQty : o.request.qty;
}

function toMs(t: number): number {
  return t > 1e14 ? Math.round(t / 1e6) : t;
}

function exitRole(o: Order): LegRole | null {
  if (o.role === 'stop_loss') return 'stop';
  if (o.role === 'take_profit') return 'target';
  if (!o.request.reduceOnly) return null;
  const t = o.request.orderType;
  return t === 'stop' || t === 'stop_limit' ? 'stop' : t === 'limit' ? 'target' : null;
}

export function draftsFor(drafts: readonly DraftInfo[] | null, accountId: string | null): DraftInfo[] {
  return accountId === null ? [] : (drafts ?? []).filter((d) => d.account === accountId);
}

export function groupBrackets(
  orders: readonly Order[],
  positions: readonly Position[],
  drafts: readonly DraftInfo[],
  ids: ReadonlySet<string>,
): Bracket[] {
  const mine = orders.filter((o) => ids.has(o.request.instrument) && OPEN_STATUSES.has(o.status));
  const out: Bracket[] = [];
  const position = positions.find((p) => ids.has(p.instrument) && p.qty !== 0) ?? null;
  const used = new Set<string>();

  for (const o of mine) {
    if (o.role !== 'entry' || o.request.reduceOnly) continue;
    const price = restingPrice(o.request);
    if (price === null) continue;
    const kids = mine.filter((c) => c.parentId === o.id && c.status === 'held');
    const legs = kids.flatMap((c): Leg[] => {
      const role = exitRole(c);
      const p = restingPrice(c.request);
      return role && p !== null ? [{ order: c, role, price: p, qty: remaining(c), held: true, pair: o.id }] : [];
    });
    for (const k of kids) used.add(k.id);
    used.add(o.id);
    out.push({
      id: legs.length ? `entry:${o.id}` : `order:${o.id}`,
      kind: legs.length ? 'pending' : 'order',
      instrument: o.request.instrument,
      side: o.request.side,
      price,
      qty: remaining(o),
      since: toMs(o.createdAt),
      entry: o,
      type: o.request.orderType.replace('_', ' '),
      stops: legs.filter((l) => l.role === 'stop'),
      targets: legs.filter((l) => l.role === 'target'),
      pnl: null,
      draftId: null,
    });
  }

  if (position) {
    const side: Side = position.qty > 0 ? 'buy' : 'sell';
    const closing: Side = side === 'buy' ? 'sell' : 'buy';
    const legs: Leg[] = [];
    for (const o of mine) {
      if (used.has(o.id) || o.request.side !== closing) continue;
      const role = exitRole(o);
      const price = restingPrice(o.request);
      if (!role || price === null) continue;
      used.add(o.id);
      legs.push({ order: o, role, price, qty: remaining(o), held: false, pair: o.parentId ?? o.id });
    }
    out.unshift({
      id: `position:${position.instrument}`,
      kind: 'position',
      instrument: position.instrument,
      side,
      price: position.avgPrice,
      qty: Math.abs(position.qty),
      since: toMs(position.openedAt),
      entry: null,
      type: null,
      stops: legs.filter((l) => l.role === 'stop'),
      targets: legs.filter((l) => l.role === 'target'),
      pnl: position.unrealizedPnl?.amount ?? null,
      draftId: null,
    });
  }

  for (const o of mine) {
    if (used.has(o.id)) continue;
    const price = restingPrice(o.request);
    if (price === null) continue;
    out.push({
      id: `order:${o.id}`,
      kind: 'order',
      instrument: o.request.instrument,
      side: o.request.side,
      price,
      qty: remaining(o),
      since: toMs(o.createdAt),
      entry: o,
      type: o.request.orderType.replace('_', ' '),
      stops: [],
      targets: [],
      pnl: null,
      draftId: null,
    });
  }

  for (const d of drafts) {
    const preview = orderPreviewOf(d);
    if (!preview) continue;
    const r = preview.request;
    if (!ids.has(r.instrument)) continue;
    const price = restingPrice(r) ?? preview.estPrice ?? preview.referencePrice;
    if (price === null) continue;
    const leg = (role: LegRole, p: number | null): Leg[] =>
      p === null ? [] : [{ order: null, role, price: p, qty: r.qty, held: true }];
    out.push({
      id: `draft:${d.draftId}`,
      kind: 'draft',
      instrument: r.instrument,
      side: r.side,
      price,
      qty: r.qty,
      since: null,
      entry: null,
      type: restingPrice(r) === null ? 'market' : r.orderType.replace('_', ' '),
      stops: leg('stop', draftLeg(r, 'stop', price)),
      targets: leg('target', draftLeg(r, 'target', price)),
      pnl: null,
      draftId: d.draftId,
    });
  }
  return out;
}

export function effectiveLeg(b: Bracket, role: LegRole): Leg | null {
  const legs = role === 'stop' ? b.stops : b.targets;
  if (legs.length === 0) return null;
  const long = b.side === 'buy';
  const first = role === 'stop' ? (long ? Math.max : Math.min) : long ? Math.min : Math.max;
  const p = first(...legs.map((l) => l.price));
  return legs.find((l) => l.price === p) ?? legs[0]!;
}

export type BracketMode = 'grow' | 'per_entry';

export function bracketModeOf(v: unknown): BracketMode {
  return v === 'grow' ? 'grow' : 'per_entry';
}

export function protectionPairs(b: Bracket): string[] {
  const pairs = new Set<string>();
  for (const l of [...b.stops, ...b.targets]) {
    const role = l.order?.role;
    if ((role === 'stop_loss' || role === 'take_profit') && l.pair) pairs.add(l.pair);
  }
  return [...pairs];
}

function protectedPosition(brackets: readonly Bracket[], side: Side): Bracket | null {
  return brackets.find((b) => b.kind === 'position' && b.side === side && protectionPairs(b).length > 0) ?? null;
}

export function joinStopOf(brackets: readonly Bracket[], side: Side, mode: BracketMode): number | null {
  if (mode !== 'grow') return null;
  const pos = protectedPosition(brackets, side);
  return pos ? (effectiveLeg(pos, 'stop')?.price ?? null) : null;
}

export function joinsBracket(b: Bracket, brackets: readonly Bracket[], mode: BracketMode): boolean {
  if (mode !== 'grow' || (b.kind !== 'pending' && b.kind !== 'order')) return false;
  if (b.entry?.role !== 'entry' || b.entry.request.reduceOnly) return false;
  return protectedPosition(brackets, b.side) !== null;
}

export function mergeOffer(brackets: readonly Bracket[], mode: BracketMode): Bracket | null {
  if (mode !== 'grow') return null;
  return brackets.find((b) => b.kind === 'position' && protectionPairs(b).length > 1) ?? null;
}

export function legsMoney(b: Bracket, legs: readonly Leg[], m: ChartMath): number | null {
  if (m.multiplier === null) return null;
  const dir = b.side === 'buy' ? 1 : -1;
  return legs.reduce((sum, l) => sum + (l.price - b.price) * dir * l.qty * m.multiplier!, 0);
}

function ticksBetween(a: number, b: number, tick: number): number {
  return Math.round(Math.abs(a - b) / tick);
}

function entryText(b: Bracket, m: ChartMath, stale: string | null = null): string {
  const px = formatPrice(b.price, b.kind === 'position' ? Math.max(m.decimals, 2) : m.decimals);
  if (b.kind === 'position') {
    const word = b.side === 'buy' ? 'Long' : 'Short';
    const pnl = stale ?? (b.pnl !== null ? formatMoney(b.pnl, { signed: true }) : null);
    return [`${word} ${String(b.qty)}`, px, pnl].filter(Boolean).join(' · ');
  }
  const verb = b.side === 'buy' ? 'Buy' : 'Sell';
  const head = `${verb} ${b.type ?? ''} ${String(b.qty)}`.replace(/\s+/g, ' ');
  return b.kind === 'draft' ? `${head} · ${px} · draft` : `${head} · ${px}`;
}

function legText(b: Bracket, role: LegRole, legs: readonly Leg[], m: ChartMath, delta = 0): string {
  const word = role === 'stop' ? 'SL' : 'TP';
  const moved = delta === 0 ? legs : legs.map((l) => ({ ...l, price: l.price + delta }));
  const prices = moved.map((l) => l.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const px = lo === hi ? formatPrice(lo, m.decimals) : `${formatPrice(lo, m.decimals)}–${formatPrice(hi, m.decimals)}`;
  const one = moved.length === 1 ? moved[0]! : null;
  const part = one !== null && b.kind === 'position' && one.qty !== b.qty;
  const parts = [part ? `${word} ${String(one.qty)} @ ${px}` : `${word} ${px}`];
  if (moved.length > 1) parts.push(`${String(moved.length)} legs`);
  const money = legsMoney(b, moved, m);
  if (money !== null) parts.push(formatMoney(money, { signed: true }));
  if (one) parts.push(`${String(ticksBetween(one.price, b.price, m.tick))}t`);
  if (role === 'target' && money !== null && b.stops.length > 0) {
    const own = one?.pair ? b.stops.filter((l) => l.pair === one.pair) : [];
    const stops = own.length > 0 ? own : b.stops;
    const risk = legsMoney(b, stops, m);
    const stopQty = stops.reduce((sum, l) => sum + l.qty, 0);
    const qty = moved.reduce((sum, l) => sum + l.qty, 0);
    if (risk !== null && risk < 0 && stopQty > 0 && qty > 0) {
      parts.push(`${(money / qty / (Math.abs(risk) / stopQty)).toFixed(1)}R`);
    }
  }
  return parts.join(' · ');
}

export interface BracketPalette {
  mist: string;
  t2: string;
  t3: string;
  aqua: string;
  up: string;
  down: string;
  upZone: string;
  downZone: string;
}

export interface TagModel {
  id: string;
  bracketId: string;
  part: 'entry' | LegRole;
  price: number;
  text: string;
  color: string;
  drag: Order[];
  close: { kind: 'cancel'; orders: Order[]; label: string } | { kind: 'flatten'; label: string } | null;
  group: number;
  fanned: boolean;
  draft: boolean;
  priority: number;
  account?: AccountRef;
}

export interface SceneOptions {
  fanned: string | null;
  preview: { tagId: string; price: number } | null;
  stale?: string | null;
}

const ZONE_ALPHA = 0.07;

const tagIds = {
  entry: (b: Bracket) => `${b.id}:entry`,
  group: (b: Bracket, role: LegRole) => `${b.id}:${role}`,
  leg: (b: Bracket, role: LegRole, l: Leg, i: number) => `${b.id}:${role}:${l.order?.id ?? String(i)}`,
};

export function legTagId(b: Bracket, role: LegRole, l: Leg): string {
  const legs = role === 'stop' ? b.stops : b.targets;
  return legs.length > 1 ? tagIds.leg(b, role, l, legs.indexOf(l)) : tagIds.group(b, role);
}

interface TagLegs {
  id: string;
  legs: Leg[];
  lead: Leg;
  fanned: boolean;
}

function tagLegs(b: Bracket, role: LegRole): TagLegs[] {
  const legs = role === 'stop' ? b.stops : b.targets;
  return legs.map((l) => ({ id: legTagId(b, role, l), legs: [l], lead: l, fanned: false }));
}

function legDelta(o: SceneOptions, b: Bracket, role: LegRole, l: Leg): number {
  const pv = o.preview;
  if (!pv) return 0;
  return pv.tagId === legTagId(b, role, l) ? pv.price - l.price : 0;
}

function previewed(b: Bracket, o: SceneOptions): Bracket {
  const pv = o.preview;
  if (pv?.tagId !== tagIds.entry(b)) return b;
  if (b.kind !== 'pending') return { ...b, price: pv.price };
  const by = pv.price - b.price;
  const carry = (l: Leg): Leg => ({ ...l, price: l.price + by });
  return { ...b, price: pv.price, stops: b.stops.map(carry), targets: b.targets.map(carry) };
}

export function bracketTags(
  brackets: readonly Bracket[],
  m: ChartMath,
  p: BracketPalette,
  o: SceneOptions,
): TagModel[] {
  const out: TagModel[] = [];
  for (const placed of brackets) {
    const b = previewed(placed, o);
    const draft = b.kind === 'draft';
    const id = tagIds.entry(b);
    const lone = b.kind === 'order';
    out.push({
      id,
      bracketId: b.id,
      part: 'entry',
      price: b.price,
      text: entryText(b, m, o.stale ?? null),
      color: draft ? p.aqua : lone ? p.t2 : p.mist,
      drag: b.entry && !draft ? [b.entry] : [],
      close:
        b.kind === 'position'
          ? { kind: 'flatten', label: `Flatten ${b.side === 'buy' ? 'long' : 'short'} ${String(b.qty)}` }
          : b.entry
            ? { kind: 'cancel', orders: [b.entry], label: `Cancel ${entryText(placed, m)}` }
            : null,
      group: 1,
      fanned: false,
      draft,
      priority: b.kind === 'position' ? 3 : 2,
    });
    for (const role of ['stop', 'target'] as const) {
      const color = draft ? p.aqua : role === 'stop' ? p.down : p.up;
      for (const t of tagLegs(b, role)) {
        const delta = legDelta(o, b, role, t.lead);
        const orders = t.legs.flatMap((l) => (l.order ? [l.order] : []));
        out.push({
          id: t.id,
          bracketId: b.id,
          part: role,
          price: t.lead.price + delta,
          text: legText(b, role, t.legs, m, delta),
          color,
          drag: draft ? [] : orders,
          close:
            draft || t.legs.length > 1 || orders.length === 0
              ? null
              : {
                  kind: 'cancel',
                  orders,
                  label: `Cancel ${role === 'stop' ? 'stop' : 'target'} ${formatPrice(t.lead.price, m.decimals)}`,
                },
          group: t.legs.length,
          fanned: t.fanned,
          draft,
          priority: 1,
        });
      }
    }
  }
  return out;
}

export function namedTags(tags: readonly TagModel[], name: string | null): TagModel[] {
  if (!name) return [...tags];
  return tags.map((t) => (t.part === 'entry' ? { ...t, text: `${name} · ${t.text}` } : t));
}

export function readOnlyTags(tags: readonly TagModel[]): TagModel[] {
  return tags.map((t) => (t.drag.length === 0 && t.close === null ? t : { ...t, drag: [], close: null }));
}

export function elsewhereTags(tags: readonly TagModel[], account: AccountRef): TagModel[] {
  return readOnlyTags(tags).map((t) => ({
    ...t,
    id: `${account.id}:${t.id}`,
    text: `${account.name} · ${t.text}`,
    account,
  }));
}

export function bracketScene(
  brackets: readonly Bracket[],
  tags: readonly TagModel[],
  p: BracketPalette,
  o: SceneOptions,
): OrderScene {
  const lines: BracketLine[] = [];
  const zones: BracketZone[] = [];
  for (const placed of brackets) {
    const b = previewed(placed, o);
    const draft = b.kind === 'draft';
    const pending = b.kind === 'pending';
    const entryId = tagIds.entry(b);
    const entry = b.price;
    if (b.kind === 'order') {
      const t = b.entry?.request.orderType;
      lines.push({
        id: entryId,
        price: entry,
        since: b.since,
        color: p.t2,
        dash: t === 'stop' || t === 'stop_limit' ? [1, 3] : [5, 3],
        width: 1,
      });
      continue;
    }
    lines.push({
      id: entryId,
      price: entry,
      since: b.since,
      color: draft ? p.aqua : p.mist,
      dash: draft || pending ? [5, 3] : [],
      width: 1,
    });
    for (const role of ['stop', 'target'] as const) {
      const legs = role === 'stop' ? b.stops : b.targets;
      if (legs.length === 0) continue;
      const hue = draft ? p.aqua : role === 'stop' ? p.down : p.up;
      const dash = draft || pending ? [5, 3] : [];
      const lead = effectiveLeg(b, role)!;
      let edge = lead.price;
      for (const [i, l] of legs.entries()) {
        const price = l.price + legDelta(o, b, role, l);
        const owner = legTagId(b, role, l);
        lines.push({
          id: `${owner}:line:${String(i)}`,
          price,
          since: b.since,
          color: withAlpha(hue, 0.75),
          dash,
          width: 1,
        });
        if (l === lead) edge = price;
      }
      const zone = role === 'stop' ? p.downZone : p.upZone;
      zones.push({
        id: `${b.id}:${role}:zone`,
        from: entry,
        to: edge,
        since: b.since,
        fill: draft ? withAlpha(hue, ZONE_ALPHA / 2) : pending ? scaleAlpha(zone, 0.5) : zone,
      });
    }
  }
  return {
    lines,
    zones,
    tags: tags.map((t): OrderTagSpec => ({ id: t.id, price: t.price, priority: t.priority, fanned: t.fanned })),
  };
}

export interface WorkingRowModel {
  id: string;
  head: string;
  legs: string[];
  state: string | null;
  cancel: Order[];
}

const STATE: Partial<Record<Order['status'], string>> = {
  pending_submit: 'sending',
  partially_filled: 'partly filled',
  pending_cancel: 'cancelling',
};

export function workingRows(
  orders: readonly Order[],
  known: ReadonlyMap<string, Order>,
  ids: ReadonlySet<string>,
  decimals: number,
): WorkingRowModel[] {
  const mine = orders.filter((o) => ids.has(o.request.instrument) && OPEN_STATUSES.has(o.status));
  const px = (p: number | null) => (p === null ? 'mkt' : formatPrice(p, decimals));
  const legWord = (c: Order) => `${exitRole(c) === 'stop' ? 'SL' : 'TP'} ${px(restingPrice(c.request))}`;
  const rows: WorkingRowModel[] = [];
  const done = new Set<string>();
  for (const o of mine) {
    if (done.has(o.id)) continue;
    const parentId = o.parentId;
    if (parentId) {
      const legs = mine.filter((c) => c.parentId === parentId);
      for (const c of legs) done.add(c.id);
      const parent = mine.find((x) => x.id === parentId) ?? known.get(parentId) ?? null;
      if (parent && OPEN_STATUSES.has(parent.status) && !parent.filledQty) continue;
      const qty = legs[0] ? remaining(legs[0]) : 0;
      const side = legs[0]?.request.side === 'sell' ? 'Long' : 'Short';
      const fill = parent?.avgFillPrice ?? legs[0]?.stopRules?.entryPrice ?? null;
      rows.push({
        id: `legs:${parentId}`,
        head: fill !== null ? `${side} ${String(qty)} @ ${px(fill)}` : `${side} ${String(qty)}`,
        legs: legs.sort((a, b) => (exitRole(a) === 'stop' ? -1 : 1) - (exitRole(b) === 'stop' ? -1 : 1)).map(legWord),
        state: legs.map((c) => STATE[c.status]).find(Boolean) ?? null,
        cancel: legs,
      });
      continue;
    }
    done.add(o.id);
    const kids = mine.filter((c) => c.parentId === o.id);
    for (const c of kids) done.add(c.id);
    const verb = o.request.side === 'buy' ? 'Buy' : 'Sell';
    const type =
      o.role === 'exit' ? `${o.request.orderType.replace('_', ' ')} exit` : o.request.orderType.replace('_', ' ');
    rows.push({
      id: `order:${o.id}`,
      head: `${verb} ${type} ${String(remaining(o))} @ ${px(restingPrice(o.request))}`,
      legs: kids.map(legWord),
      state: STATE[o.status] ?? null,
      cancel: [o],
    });
  }
  return rows;
}

export function bracketPalette(t: {
  mist: string;
  t2: string;
  t3: string;
  aqua: string;
  up: string;
  down: string;
  upZone?: string;
  downZone?: string;
}): BracketPalette {
  return {
    mist: t.mist,
    t2: t.t2,
    t3: t.t3,
    aqua: t.aqua,
    up: t.up,
    down: t.down,
    upZone: t.upZone ?? withAlpha(t.up, ZONE_ALPHA),
    downZone: t.downZone ?? withAlpha(t.down, ZONE_ALPHA),
  };
}

function scaleAlpha(css: string, k: number): string {
  const rgba = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(css.replace(/\s+/g, ''));
  if (rgba) return `rgba(${rgba[1]!},${rgba[2]!},${rgba[3]!},${String(Number(rgba[4]) * k)})`;
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css.trim());
  if (!hex) return css;
  const a = hex[2] ? parseInt(hex[2], 16) / 255 : 1;
  return withAlpha(`#${hex[1]!}`, Math.round(a * k * 1000) / 1000);
}
