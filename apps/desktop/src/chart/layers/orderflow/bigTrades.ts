import {
  aggressorNoteOf,
  BigTradesLayer,
  formatCount,
  groupingKey,
  type BigTradePlotPrice,
  type BigTradeTier,
  type BigTradeZoneOptions,
  type Grouping,
  type ZoneFilter,
} from '@tessera/chart';
import type { BigTradeCuts } from '@tessera/protocol';
import { focusPrint } from '../../../market/flow/events.ts';
import { NO_GAPS } from '../../../market/flow/hub.ts';
import {
  BigTradeView,
  sameFilter,
  type BigTradeDemand,
  type BigTradeFeed,
  type BigTradeFilter,
} from '../../../market/flow/bigTrades.ts';
import type { IndicatorSettings } from '../../indicators.ts';
import { daysToLoadOf, flowLayerId, Links, noteFrom, registerFlowView } from './common.ts';

export function bigTradeFilter(s: IndicatorSettings): BigTradeFilter {
  if (s.inputs.size !== 'fixed') return { kind: 'auto', tier: String(s.inputs.tier) as BigTradeTier };
  const max = Number(s.inputs.maxSize);
  return { kind: 'size', min: Number(s.inputs.minSize), max: max > 0 ? max : null };
}

export function bigTradeGrouping(s: IndicatorSettings): Grouping {
  return { joinOrders: s.inputs.joinOrders !== false, reachLimit: s.inputs.reachLimit !== false };
}

export function bigTradeLegend(filter: BigTradeFilter, cut: number | null, sizing: boolean): string {
  if (filter.kind === 'size')
    return filter.max === null
      ? `≥ ${formatCount(filter.min)}`
      : `${formatCount(filter.min)}–${formatCount(filter.max)}`;
  const live = autoMinNote(filter, cut, sizing);
  const auto = `Auto ${filter.tier}`;
  return live === null ? auto : `${auto} ${live}`;
}

export function autoMinNote(filter: BigTradeFilter, cut: number | null, sizing: boolean): string | null {
  return filter.kind === 'auto' && !sizing && cut !== null ? `≥ ${formatCount(cut)}` : null;
}

export function tierNotes(cuts: BigTradeCuts | null): Readonly<Record<string, string>> | null {
  if (cuts === null) return null;
  return {
    'tier.low': `≥ ${formatCount(cuts.low)}`,
    'tier.medium': `≥ ${formatCount(cuts.medium)}`,
    'tier.high': `≥ ${formatCount(cuts.high)}`,
  };
}

function bigTradeZoneOptions(s: IndicatorSettings): BigTradeZoneOptions | null {
  const i = s.inputs;
  if (i.zones !== 'on') return null;
  return {
    bars: Number(i.zoneBars),
    biggest: i.zoneBiggest === true,
    body: String(i.zoneBody) as ZoneFilter,
    wick: String(i.zoneWick) as ZoneFilter,
  };
}

registerFlowView('big_trades', (model, ctx) => {
  const layer = new BigTradesLayer({ id: flowLayerId(model), owner: model.sessionId });
  let instrument = ctx.instrument ?? '';
  let filter: BigTradeFilter = { kind: 'auto', tier: 'low' };
  let linked: { feed: BigTradeFeed; demand: BigTradeDemand; sync: () => void } | null = null;
  return {
    layers: [layer],
    keepsLinkAcrossTimeframes: true,
    apply(settings, _m, c) {
      layer.setOptions({
        showSize: settings.inputs.showSize === true,
        price: String(settings.inputs.price) as BigTradePlotPrice,
        zones: bigTradeZoneOptions(settings),
      });
      instrument = c.instrument ?? instrument;
      const next = bigTradeFilter(settings);
      if (sameFilter(next, filter)) return;
      filter = next;
      if (!linked) return;
      linked.demand.set(filter);
      layer.setSource(new BigTradeView(linked.feed, filter));
      linked.sync();
    },
    linkKey: (settings) => `${groupingKey(bigTradeGrouping(settings))}|${String(daysToLoadOf(settings))}`,
    link(flow, _c, settings) {
      filter = bigTradeFilter(settings);
      const { feed, release } = flow.useBigTrades(bigTradeGrouping(settings), daysToLoadOf(settings));
      const demand = feed.demand(filter);
      const links = new Links();
      layer.setSource(new BigTradeView(feed, filter));
      const sync = () => {
        noteFrom(layer.state, [feed.statusFor(filter)]);
        layer.setGaps(feed.gaps);
        layer.state.aggressor = aggressorNoteOf(flow.info.aggressorSource);
        const cut = filter.kind === 'auto' ? feed.cutFor(filter.tier) : null;
        const legend = bigTradeLegend(filter, cut, feed.sizing);
        const notes = tierNotes(feed.cuts);
        if (legend !== layer.options.legend || JSON.stringify(notes) !== JSON.stringify(layer.options.notes))
          layer.setOptions({ legend, notes });
        layer.dataChanged();
      };
      linked = { feed, demand, sync };
      links.add(feed.changed.on(sync));
      links.add(
        ctx.chart.on('click', (e) => {
          const hit = e.hits.find((h) => h.layerId === layer.id);
          if (!hit) return;
          const t = layer.markersAt(e.x, e.y)[0]?.trade;
          if (t) focusPrint({ instrument, t: t.t, price: t.price, size: t.size, side: t.side, ref: t.ref });
        }),
      );
      sync();
      return () => {
        links.dispose();
        linked = null;
        demand.drop();
        layer.setSource(null);
        layer.setGaps(NO_GAPS);
        layer.state.clear();
        release();
      };
    },
  };
});
