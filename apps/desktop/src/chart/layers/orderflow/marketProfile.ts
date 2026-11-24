import {
  MarketProfileLayer,
  TickGrid,
  type MarketProfileOptions,
  type ProfilePeriod,
  type ProfileStyle,
  type TpoStyle,
} from '@tessera/chart';
import { INDICATOR_SPECS, type IndicatorSpec, type SessionFilter } from '@tessera/protocol';
import { NO_GAPS } from '../../../market/flow/hub.ts';
import { engineStyle, resolveIndicator, type IndicatorSettings } from '../../indicators.ts';
import { flowLayerId, Links, noteFrom, registerFlowView, rowTicksOf } from './common.ts';

const SPEC: IndicatorSpec = INDICATOR_SPECS.find((s) => s.kind === 'market_profile')!;
const PERIODS: readonly ProfilePeriod[] = ['session', 'day', 'week', 'month'];
const TPO_MINUTES: readonly number[] = [5, 10, 15, 30, 60];

function marketProfileOptions(s: IndicatorSettings, chart: SessionFilter = 'all'): MarketProfileOptions {
  const i = s.inputs;
  const period = PERIODS.find((p) => p === i.period) ?? 'session';
  const tpo = Number(i.tpo);
  return {
    period,
    length: Math.max(1, Number(i.length) || 1),
    tpo: TPO_MINUTES.includes(tpo) ? tpo : 30,
    style: (i.style === 'blocks' ? 'blocks' : 'letters') satisfies TpoStyle,
    hours: i.hours === 'rth' || i.hours === 'all' ? i.hours : chart,
    valueArea: Number(i.valueArea) / 100,
    rowTicks: rowTicksOf(i.rowTicks),
    ib: i.ib !== false,
    notes: { 'hours.chart': chart === 'rth' ? 'RTH' : 'ETH' },
  };
}

function styleOf(s: IndicatorSettings): ProfileStyle {
  const st = engineStyle(SPEC, s);
  const plot = (k: string) => ({ ...st.plots[k]!, downColor: st.plots[k]!.downColor ?? null });
  return { poc: plot('poc'), vah: plot('vah'), val: plot('val') };
}

registerFlowView('market_profile', (model, ctx) => {
  const layer = new MarketProfileLayer({
    id: flowLayerId(model),
    owner: model.sessionId,
    grid: new TickGrid(ctx.spec?.tickSize ?? 0.25, ctx.spec?.priceDecimals),
    style: styleOf(resolveIndicator(SPEC, model.params)),
  });
  return {
    layers: [layer],
    apply(settings, _m, c) {
      layer.setOptions(marketProfileOptions(settings, c.session), styleOf(settings));
    },
    link(flow) {
      layer.grid = flow.grid;
      const links = new Links();
      const profiles = flow.useProfiles();
      const feed = profiles.feed;
      layer.setSource(feed);
      const want = () => {
        if (layer.needFrom === null) return;
        const o = layer.options;
        feed.ensureFrom(o.period, layer.needFrom, o.length, o.tpo);
      };
      const sync = () => {
        noteFrom(layer.state, [feed.status]);
        layer.setGaps(feed.gaps);
        layer.dataChanged();
        want();
      };
      links.add(feed.changed.on(sync));
      links.add(ctx.chart.on('settled', want));
      sync();
      return () => {
        links.dispose();
        layer.setSource(null);
        layer.setGaps(NO_GAPS);
        layer.state.clear();
        profiles.release();
      };
    },
  };
});
