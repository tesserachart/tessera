import {
  aggressorNoteOf,
  periodOf,
  TickGrid,
  VolumeProfileLayer,
  type ProfileHours,
  type ProfileKind,
  type ProfilePeriod,
  type ProfileShow,
  type ProfileSide,
  type ProfileStyle,
} from '@tessera/chart';
import {
  INDICATOR_SPECS,
  normalizeEpochMs,
  type IndicatorSpec,
  type Level,
  type SessionFilter,
} from '@tessera/protocol';
import { NO_GAPS } from '../../../market/flow/hub.ts';
import type { ProfileFeed } from '../../../market/flow/profiles.ts';
import { engineStyle, resolveIndicator, type IndicatorSettings } from '../../indicators.ts';
import { daysToLoadOf, flowLayerId, Links, noteFrom, registerFlowView, rowTicksOf } from './common.ts';

const SPEC: IndicatorSpec = INDICATOR_SPECS.find((s) => s.kind === 'volume_profile')!;

export function profileHours(hours: unknown, chart: SessionFilter = 'all'): ProfileHours {
  if (hours === 'rth' || hours === 'split' || hours === 'all') return hours;
  return chart;
}

function profileTime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? normalizeEpochMs(v) : null;
  if (typeof v !== 'string' || v === '') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

export function profileOptions(s: IndicatorSettings, chart: SessionFilter = 'all') {
  const i = s.inputs;
  return {
    period: String(i.period) as ProfileKind,
    compositePeriod: String(i.compositePeriod ?? 'session') as ProfilePeriod,
    length: Math.max(1, Number(i.length) || 1),
    from: profileTime(i.from),
    to: profileTime(i.to),
    show: String(i.show) as ProfileShow,
    hours: profileHours(i.hours, chart),
    valueArea: Number(i.valueArea) / 100,
    rowTicks: rowTicksOf(i.rowTicks),
    extendLines: i.extendLines === true,
    nakedPocs: i.nakedPocs === true,
    developingPoc: i.developingPoc === true,
    developingVa: i.developingVa === true,
    nodes: i.nodes === true,
    side: String(i.side ?? 'left') as ProfileSide,
    priorVa: i.priorVa === true,
    notes: { 'hours.chart': chart === 'rth' ? 'RTH' : 'ETH' },
  };
}

function styleOf(s: IndicatorSettings): ProfileStyle {
  const st = engineStyle(SPEC, s);
  const plot = (k: string) => ({ ...st.plots[k]!, downColor: st.plots[k]!.downColor ?? null });
  return { poc: plot('poc'), vah: plot('vah'), val: plot('val') };
}

function readsFootprints(s: IndicatorSettings): boolean {
  const o = profileOptions(s);
  return o.developingPoc || o.developingVa;
}

registerFlowView('volume_profile', (model, ctx) => {
  const layer = new VolumeProfileLayer({
    id: flowLayerId(model),
    owner: model.sessionId,
    grid: new TickGrid(ctx.spec?.tickSize ?? 0.25, ctx.spec?.priceDecimals),
    style: styleOf(resolveIndicator(SPEC, model.params)),
  });
  let levels: readonly Level[] = ctx.levels;
  let feed: ProfileFeed | null = null;
  let period: ProfilePeriod | null = null;
  let length = 1;
  return {
    layers: [layer],
    apply(settings, _m, c) {
      const options = profileOptions(settings, c.session);
      layer.setOptions(options, styleOf(settings));
      period = periodOf(options.period);
      length = options.length;
      levels = c.levels;
      feed?.setLevels(levels);
    },
    linkKey: (settings) => `${readsFootprints(settings) ? 'footprints' : ''}|${String(daysToLoadOf(settings))}`,
    link(flow, c, settings) {
      layer.grid = flow.grid;
      const links = new Links();
      const days = daysToLoadOf(settings);
      const profiles = flow.useProfiles(days);
      feed = profiles.feed;
      feed.setLevels(levels);
      layer.setSource(feed);
      const fp = readsFootprints(settings) ? flow.useFootprints(c.tf!, days) : null;
      layer.setFootprints(fp?.feed.store ?? null);
      const want = () => {
        if (layer.needFrom === null) return;
        if (period) profiles.feed.ensureFrom(period, layer.needFrom, length);
        if (fp) void fp.feed.ensureFrom(layer.needFrom);
      };
      const sync = () => {
        noteFrom(layer.state, [profiles.feed.status, fp?.feed.status]);
        layer.setGaps(profiles.feed.gaps);
        layer.state.aggressor = aggressorNoteOf(flow.info.aggressorSource);
        layer.dataChanged();
        want();
      };
      links.add(profiles.feed.changed.on(sync));
      if (fp) links.add(fp.feed.changed.on(sync));
      links.add(ctx.chart.on('settled', want));
      sync();
      return () => {
        links.dispose();
        layer.setSource(null);
        layer.setFootprints(null);
        layer.setGaps(NO_GAPS);
        layer.state.clear();
        feed = null;
        fp?.release();
        profiles.release();
      };
    },
  };
});
