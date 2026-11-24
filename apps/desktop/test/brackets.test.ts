import type { Order, OrderRole, OrderStatus, Position, Side } from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { describe, expect, it } from 'vitest';
import {
  bracketModeOf,
  bracketPalette,
  bracketScene,
  bracketTags,
  effectiveLeg,
  groupBrackets,
  joinStopOf,
  joinsBracket,
  mergeOffer,
  protectionPairs,
  workingRows,
  type ChartMath,
} from '../src/chart/brackets.ts';
import type { LevelSourceInfo } from '@tessera/protocol';
import {
  DEFAULT_LEVEL_SETTINGS,
  INITIAL_BALANCE_SOURCE,
  TESSERA_SOURCE,
  applyLevelSettings,
  defsOf,
  levelShown,
  readLevelSettings,
  setLevelStyle,
  setSourceOn,
  sourceDefs,
  swatchLine,
  type Palette,
} from '../src/chart/levelSettings.ts';

const NQ = 'NQZ6.CME';
const ids = new Set([NQ, 'NQ']);
const math: ChartMath = { decimals: 2, tick: 0.25, multiplier: 20 };
const pal = bracketPalette(TOKENS);

let n = 0;
function order(o: {
  side: Side;
  type: 'limit' | 'stop' | 'market';
  price: number | null;
  qty?: number;
  role?: OrderRole;
  parent?: string | null;
  status?: OrderStatus;
  id?: string;
}): Order {
  n += 1;
  return {
    id: o.id ?? `o${String(n)}`,
    brokerOrderId: null,
    draftId: null,
    request: {
      accountId: 'paper-main',
      instrument: NQ,
      side: o.side,
      qty: o.qty ?? 1,
      orderType: o.type,
      limitPrice: o.type === 'limit' ? o.price : null,
      stopPrice: o.type === 'stop' ? o.price : null,
      tif: 'gtc',
      bracket: null,
      clientOrderId: null,
      reduceOnly: o.role === 'stop_loss' || o.role === 'take_profit',
    },
    role: o.role ?? 'entry',
    parentId: o.parent ?? null,
    status: o.status ?? 'working',
    filledQty: 0,
    avgFillPrice: null,
    queueAhead: null,
    triggeredAt: null,
    environment: 'paper',
    reason: null,
    createdAt: 1_759_430_000_000,
    updatedAt: 1_759_430_000_000,
  };
}

const position = (qty: number, avg: number): Position => ({
  accountId: 'paper-main',
  instrument: NQ,
  qty,
  avgPrice: avg,
  realizedPnl: { amount: 0, currency: 'USD' },
  unrealizedPnl: { amount: -295, currency: 'USD' },
  mark: 20651,
  openedAt: 1_759_430_000_000,
});

describe('chart brackets', () => {
  it('a position with OCO is one bracket: entry, stop and target, labelled once with the quantity', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20640.75, role: 'stop_loss', parent: 'e1' });
    const tp = order({ side: 'sell', type: 'limit', price: 20674.75, role: 'take_profit', parent: 'e1' });
    const [b] = groupBrackets([sl, tp], [position(1, 20651)], [], ids);
    expect(b!.kind).toBe('position');
    const tags = bracketTags([b!], math, pal, { fanned: null, preview: null });
    expect(tags.map((t) => t.text)).toEqual([
      'Long 1 · 20,651.00 · −$295.00',
      'SL 20,640.75 · −$205.00 · 41t',
      'TP 20,674.75 · +$475.00 · 95t · 2.3R',
    ]);
    expect(tags.map((t) => t.color)).toEqual([TOKENS.mist, TOKENS.down, TOKENS.up]);
    expect(tags[0]!.close?.kind).toBe('flatten');
    expect(tags[1]!.close).toMatchObject({ kind: 'cancel', orders: [sl] });
    const scene = bracketScene([b!], tags, pal, { fanned: null, preview: null });
    expect(scene.zones.map((z) => [z.from, z.to])).toEqual([
      [20651, 20640.75],
      [20651, 20674.75],
    ]);
    expect(scene.lines.every((l) => l.since === 1_759_430_000_000)).toBe(true);
  });

  it('every entry its own bracket: each pair drawn as its own lines and tags with its size, never one ranged tag', () => {
    const legs: Order[] = [];
    const pairs: [string, number, number, number][] = [
      ['e1', 13, 20544.75, 20806],
      ['e2', 13, 20544.75, 20806],
      ['e3', 5, 20531, 20806.75],
    ];
    for (const [e, qty, stop, target] of pairs) {
      legs.push(order({ side: 'sell', type: 'stop', price: stop, qty, role: 'stop_loss', parent: e, id: `${e}-sl` }));
      legs.push(
        order({ side: 'sell', type: 'limit', price: target, qty, role: 'take_profit', parent: e, id: `${e}-tp` }),
      );
    }
    const brackets = groupBrackets(legs, [position(31, 20555.87)], [], ids);
    expect(brackets).toHaveLength(1);
    const b = brackets[0]!;
    expect(effectiveLeg(b, 'stop')!.price).toBe(20544.75);
    expect(protectionPairs(b)).toEqual(['e1', 'e2', 'e3']);
    const tags = bracketTags(brackets, math, pal, { fanned: null, preview: null });
    expect(tags.map((t) => t.text)).toEqual([
      'Long 31 · 20,555.87 · −$295.00',
      'SL 13 @ 20,544.75 · −$2,891.20 · 44t',
      'SL 13 @ 20,544.75 · −$2,891.20 · 44t',
      'SL 5 @ 20,531.00 · −$2,487.00 · 99t',
      'TP 13 @ 20,806.00 · +$65,033.80 · 1001t · 22.5R',
      'TP 13 @ 20,806.00 · +$65,033.80 · 1001t · 22.5R',
      'TP 5 @ 20,806.75 · +$25,088.00 · 1004t · 10.1R',
    ]);
    expect(tags.some((t) => /legs|–/.test(t.text))).toBe(false);
    expect(tags[1]!.drag).toEqual([legs[0]]);
    expect(tags[3]!.close).toMatchObject({ kind: 'cancel', orders: [legs[4]] });
    const moved = bracketScene(brackets, tags, pal, { fanned: null, preview: { tagId: tags[3]!.id, price: 20535 } });
    expect(moved.lines.filter((l) => l.id.startsWith(`${b.id}:stop`)).map((l) => l.price)).toEqual([
      20544.75, 20544.75, 20535,
    ]);
    expect(moved.zones[0]!.to).toBe(20544.75);
  });

  it('a position whose numbers are old says so on its tag in place of its P/L', () => {
    const [b] = groupBrackets([], [position(2, 29_675.25)], [], ids);
    const live = bracketTags([b!], math, pal, { fanned: null, preview: null });
    expect(live[0]!.text).toMatch(/^Long 2 · 29,675\.25 · [+−]\$/);
    const behind = bracketTags([b!], math, pal, { fanned: null, preview: null, stale: '2 min behind' });
    expect(behind[0]!.text).toBe('Long 2 · 29,675.25 · 2 min behind');
    const dark = bracketTags([b!], math, pal, { fanned: null, preview: null, stale: 'No live prices' });
    expect(dark[0]!.text).toBe('Long 2 · 29,675.25 · No live prices');
  });

  it('a grown bracket is one stop and one target of the whole position', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20544.75, qty: 31, role: 'stop_loss', parent: 'e1' });
    const tp = order({ side: 'sell', type: 'limit', price: 20806, qty: 31, role: 'take_profit', parent: 'e1' });
    const [b] = groupBrackets([sl, tp], [position(31, 20555.87)], [], ids);
    const tags = bracketTags([b!], math, pal, { fanned: null, preview: null });
    expect(tags.map((t) => t.text)).toEqual([
      'Long 31 · 20,555.87 · −$295.00',
      'SL 20,544.75 · −$6,894.40 · 44t',
      'TP 20,806.00 · +$155,080.60 · 1001t · 22.5R',
    ]);
    expect(tags.map((t) => t.id)).toEqual([`${b!.id}:entry`, `${b!.id}:stop`, `${b!.id}:target`]);
  });

  it('grow mode: an add joins the bracket, risk counts to its stop, several pairs offer a merge', () => {
    expect(bracketModeOf('per_entry')).toBe('per_entry');
    expect(bracketModeOf('grow')).toBe('grow');
    expect(bracketModeOf(undefined)).toBe('per_entry');
    const sl = order({ side: 'sell', type: 'stop', price: 20544.75, qty: 13, role: 'stop_loss', parent: 'e1' });
    const tp = order({ side: 'sell', type: 'limit', price: 20806, qty: 13, role: 'take_profit', parent: 'e1' });
    const add = order({ side: 'buy', type: 'limit', price: 20550, qty: 2, id: 'e2' });
    const brackets = groupBrackets([sl, tp, add], [position(13, 20555.87)], [], ids);
    const working = brackets.find((b) => b.entry?.id === 'e2')!;
    expect(joinsBracket(working, brackets, 'grow')).toBe(true);
    expect(joinsBracket(working, brackets, 'per_entry')).toBe(false);
    expect(joinStopOf(brackets, 'buy', 'grow')).toBe(20544.75);
    expect(joinStopOf(brackets, 'sell', 'grow')).toBeNull();
    expect(joinStopOf(brackets, 'buy', 'per_entry')).toBeNull();
    expect(mergeOffer(brackets, 'grow')).toBeNull();
    const sl2 = order({ side: 'sell', type: 'stop', price: 20531, qty: 5, role: 'stop_loss', parent: 'e3' });
    const two = groupBrackets([sl, tp, sl2], [position(18, 20555.87)], [], ids);
    expect(mergeOffer(two, 'grow')?.kind).toBe('position');
    expect(mergeOffer(two, 'per_entry')).toBeNull();
    const exit = order({ side: 'sell', type: 'stop', price: 20530, qty: 13 });
    exit.request.reduceOnly = true;
    exit.role = 'exit';
    expect(mergeOffer(groupBrackets([sl, tp, exit], [position(13, 20555.87)], [], ids), 'grow')).toBeNull();
  });

  it('a drag previews the new price with its money and moves the group by the same delta', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20640.75, role: 'stop_loss', parent: 'e1' });
    const brackets = groupBrackets([sl], [position(1, 20651)], [], ids);
    const id = `${brackets[0]!.id}:stop`;
    const tags = bracketTags(brackets, math, pal, { fanned: null, preview: { tagId: id, price: 20645 } });
    expect(tags[1]!.text).toBe('SL 20,645.00 · −$120.00 · 24t');
    expect(tags[1]!.price).toBe(20645);
  });

  it('a pending entry dragged takes its held legs along: the same ticks, money and R from where it would rest', () => {
    const e = order({ side: 'buy', type: 'limit', price: 20615, id: 'e8' });
    const s = order({ side: 'sell', type: 'stop', price: 20605, role: 'stop_loss', parent: 'e8', status: 'held' });
    const t = order({ side: 'sell', type: 'limit', price: 20635, role: 'take_profit', parent: 'e8', status: 'held' });
    const brackets = groupBrackets([e, s, t], [], [], ids);
    const still = { fanned: null, preview: null };
    expect(bracketTags(brackets, math, pal, still).map((x) => x.text)).toEqual([
      'Buy limit 1 · 20,615.00',
      'SL 20,605.00 · −$200.00 · 40t',
      'TP 20,635.00 · +$400.00 · 80t · 2.0R',
    ]);
    const dragged = { fanned: null, preview: { tagId: `${brackets[0]!.id}:entry`, price: 20617 } };
    const tags = bracketTags(brackets, math, pal, dragged);
    expect(tags.map((x) => [x.price, x.text])).toEqual([
      [20617, 'Buy limit 1 · 20,617.00'],
      [20607, 'SL 20,607.00 · −$200.00 · 40t'],
      [20637, 'TP 20,637.00 · +$400.00 · 80t · 2.0R'],
    ]);
    const scene = bracketScene(brackets, tags, pal, dragged);
    expect(scene.zones.map((z) => [z.from, z.to])).toEqual([
      [20617, 20607],
      [20617, 20637],
    ]);
  });

  it('pending entries hold their legs; lone orders are t2; drafts are aqua and never draggable', () => {
    const e = order({ side: 'buy', type: 'limit', price: 20615, qty: 2, id: 'e9' });
    const s = order({
      side: 'sell',
      type: 'stop',
      price: 20598,
      role: 'stop_loss',
      parent: 'e9',
      status: 'held',
      qty: 2,
    });
    const lone = order({ side: 'sell', type: 'stop', price: 20600 });
    const draft = {
      draftId: 'd1',
      live: true,
      preview: {
        request: {
          ...e.request,
          side: 'buy',
          qty: 1,
          orderType: 'limit',
          limitPrice: 20610,
          bracket: { stopLoss: 20600, takeProfit: 20640 },
        },
        estPrice: 20610,
        referencePrice: 20641,
      },
    } as never;
    const brackets = groupBrackets([e, s, lone], [], [draft], ids);
    expect(brackets.map((b) => b.kind)).toEqual(['pending', 'order', 'draft']);
    const tags = bracketTags(brackets, math, pal, { fanned: null, preview: null });
    expect(tags.find((t) => t.bracketId === 'order:' + lone.id)!.color).toBe(TOKENS.t2);
    const draftTags = tags.filter((t) => t.draft);
    expect(draftTags.every((t) => t.color === TOKENS.aqua && t.drag.length === 0 && t.close === null)).toBe(true);
    const scene = bracketScene(brackets, tags, pal, { fanned: null, preview: null });
    expect(scene.lines.find((l) => l.id === `order:${lone.id}:entry`)!.dash).toEqual([1, 3]);
  });

  it('the panel lists working orders by bracket, the state only when not working', () => {
    const e = order({ side: 'buy', type: 'limit', price: 20615, id: 'w1' });
    const s = order({ side: 'sell', type: 'stop', price: 20598, role: 'stop_loss', parent: 'w1', status: 'held' });
    const filled: Order = {
      ...order({ side: 'buy', type: 'market', price: null, id: 'f1' }),
      status: 'filled',
      filledQty: 1,
      avgFillPrice: 20653.95,
    };
    const fs = order({ side: 'sell', type: 'stop', price: 20643.5, role: 'stop_loss', parent: 'f1' });
    const ft = order({ side: 'sell', type: 'limit', price: 20673.5, role: 'take_profit', parent: 'f1' });
    const rows = workingRows([e, s, fs, ft], new Map([['f1', filled]]), ids, 2);
    expect(rows.map((r) => [r.head, r.legs, r.state])).toEqual([
      ['Buy limit 1 @ 20,615.00', ['SL 20,598.00'], null],
      ['Long 1 @ 20,653.95', ['SL 20,643.50', 'TP 20,673.50'], null],
    ]);
  });
});

describe('level settings', () => {
  const palette = TOKENS as unknown as Palette;
  const spec = { id: 'zeta.classic.major_pos_vol', price: 20850, label: 'Major Positive Volume', short: 'MPV' };
  const lvl = (key: string, label: string, style: LevelSourceInfo['packages'][number]['levels'][number]['style']) => ({
    key,
    field: key.split('.').slice(2).join('.'),
    label,
    short: null,
    group: 'gamma',
    endpoint: 'classic/gex_full',
    description: null,
    concept: null,
    style,
  });
  const info = (first: boolean, keys: string[]): LevelSourceInfo => ({
    providerId: first ? 'zeta' : 'zeta-mirror',
    displayName: first ? 'Zeta' : 'Zeta mirror',
    vendor: 'Zeta',
    packages: [
      {
        key: 'zeta.classic',
        vendor: 'Zeta',
        package: 'Classic',
        open: false,
        levels: [
          lvl('zeta.classic.zero_gamma', 'Zero Gamma', { color: 'mist', line: 'dash' }),
          lvl('zeta.classic.major_pos_vol', 'Major Positive Volume', { color: 'up', line: 'solid' }),
        ].filter((l) => keys.includes(l.key)),
      },
    ],
    instruments: ['NQ'],
    schedule: first ? 'Every 2 min, US market hours' : null,
    callsToday: [],
    spec: null,
    editable: true,
    sendsSecret: true,
    history: null,
    health: null as never,
  });
  const sources = sourceDefs([
    info(true, ['zeta.classic.zero_gamma']),
    info(false, ['zeta.classic.zero_gamma', 'zeta.classic.major_pos_vol']),
  ]);
  const defs = defsOf(sources);

  it('lists each vendor package once, from what the sources declare, then Tessera’s own', () => {
    expect(sources.map((s) => [s.key, s.name])).toEqual([
      ['zeta.classic', 'Zeta · Classic'],
      ['tessera.concepts', 'Prior day'],
      ['tessera.ib', 'Initial balance'],
    ]);
    expect(sources[0]!.note).toBe('Every 2 min, US market hours');
    expect(sources[0]!.levels.map((l) => l.name)).toEqual(['Zero Gamma', 'Major Positive Volume']);
    expect(sources[1]).toBe(TESSERA_SOURCE);
    expect(sources[2]).toBe(INITIAL_BALANCE_SOURCE);
    expect(INITIAL_BALANCE_SOURCE.levels.map((l) => l.key)).toEqual([
      'tessera.ib.high',
      'tessera.ib.low',
      'tessera.ib.mid',
      'tessera.ib.high50',
      'tessera.ib.low50',
      'tessera.ib.high100',
      'tessera.ib.low100',
    ]);
    expect(sourceDefs([info(false, ['zeta.classic.zero_gamma'])])[0]!.note).toBe('From Zeta mirror.');
  });

  it('applies colour, line, label and distance from the declared defaults, and hides by level or by source', () => {
    expect(applyLevelSettings(spec, DEFAULT_LEVEL_SETTINGS, palette, defs)).toMatchObject({
      color: swatchLine(palette, 'up'),
      style: 'solid',
      labelMode: 'name',
      distance: true,
    });
    let s = setLevelStyle(
      DEFAULT_LEVEL_SETTINGS,
      spec.id,
      { color: 'brass', line: 'dot', label: 'short', distance: false },
      defs,
    );
    expect(applyLevelSettings(spec, s, palette, defs)).toMatchObject({
      color: 'rgba(216,178,106,0.6)',
      style: 'dot',
      dash: [1, 3],
      labelMode: 'short',
      distance: false,
    });
    s = setLevelStyle(s, spec.id, { on: false }, defs);
    expect(applyLevelSettings(spec, s, palette, defs)).toBeNull();
    s = setSourceOn(setLevelStyle(s, spec.id, { on: true }, defs), 'zeta.classic', false);
    expect(applyLevelSettings(spec, s, palette, defs)).toBeNull();
    expect(levelShown(s, spec.id, defs)).toBe(false);
    expect(applyLevelSettings({ ...spec, id: 'acme.flow.hvl' }, s, palette, defs)).toEqual({
      ...spec,
      id: 'acme.flow.hvl',
    });
    expect(
      applyLevelSettings({ ...spec, id: 'zeta.classic.zero_gamma' }, DEFAULT_LEVEL_SETTINGS, palette, defs),
    ).toMatchObject({ style: 'dash' });
  });

  it('keeps only what differs from the defaults, reads storage safely (never aqua) and moves old keys', () => {
    const s = setLevelStyle(
      setLevelStyle(DEFAULT_LEVEL_SETTINGS, 'tessera.concepts.pdh', { color: 'up' }),
      'tessera.concepts.pdh',
      { color: 't2' },
    );
    expect(s.levels).toEqual({});
    const read = readLevelSettings({
      sources: { 'tessera.concepts': false, bogus: true },
      levels: { 'tessera.concepts.pdh': { color: 'aqua', line: 'dash' }, zz: {}, 'acme.main.Call Wall': { on: false } },
    });
    expect(read).toEqual({
      sources: { 'tessera.concepts': false },
      levels: { 'tessera.concepts.pdh': { line: 'dash' }, 'acme.main.Call Wall': { on: false } },
    });
    const old = readLevelSettings({
      sources: { gamma: false, prior: true, vwap: false },
      levels: {
        call_wall: { color: 'brass' },
        gamma_flip: { line: 'dot' },
        zero_gamma: { on: false },
        pdc: { on: false },
      },
    });
    expect(old).toEqual({
      sources: { 'tessera.concepts': true },
      levels: { 'tessera.concepts.pdc': { on: false } },
    });
  });
});
