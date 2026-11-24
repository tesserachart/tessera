import { aggressorNoteOf, type FlowState, type FootprintStore, type Layer, type TimeSpan } from '@tessera/chart';
import { INDICATOR_SPECS, type ChartLayer, type DrawnLayerKind, type IndicatorSpec } from '@tessera/protocol';
import {
  DEFAULT_DAYS_TO_LOAD,
  mostLoading,
  NO_GAPS,
  type FlowStatus,
  type InstrumentFlow,
} from '../../../market/flow/hub.ts';
import { FEED_FAILED, loadedWords, screenWords } from '../../../shell/deskWords.ts';
import { indicatorLabel, resolveIndicator, type IndicatorSettings } from '../../indicators.ts';
import { indicatorLayerId } from '../indicators.ts';
import { registerLayerFactory, type LayerBinding, type LayerContext } from '../registry.ts';

export interface FlowView {
  readonly layers: readonly Layer[];
  apply(settings: IndicatorSettings, model: ChartLayer, ctx: LayerContext, order: number): void;
  shown?(settings: IndicatorSettings): readonly boolean[];
  linkKey?(settings: IndicatorSettings, ctx: LayerContext): string;
  readonly keepsLinkAcrossTimeframes?: boolean;
  link(flow: InstrumentFlow, ctx: LayerContext, settings: IndicatorSettings): () => void;
  dispose?(): void;
}

export function noteFrom(state: FlowState, statuses: readonly (FlowStatus | null | undefined)[]): void {
  const error = statuses.find((s) => s?.error)?.error;
  state.notice = error ? null : loadedWords(mostLoading(statuses.map((s) => s?.loaded)));
  if (error) {
    state.stop(`stopped: ${screenWords(error, FEED_FAILED)}`);
    return;
  }
  state.read(statuses.some((s) => s?.reading === true));
}

export function daysToLoadOf(settings: IndicatorSettings): number {
  const n = Number(settings.inputs.daysToLoad);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_DAYS_TO_LOAD;
}

export class Links {
  private readonly offs: (() => void)[] = [];

  add(off: () => void): void {
    this.offs.push(off);
  }

  dispose(): void {
    for (const off of this.offs.splice(0).reverse()) off();
  }
}

function flowBinding(spec: IndicatorSpec, ctx0: LayerContext, make: (ctx: LayerContext) => FlowView): LayerBinding {
  const { chart } = ctx0;
  let view: FlowView | null = null;
  let link: { key: string; unlink: () => void; release: () => void } | null = null;
  const unlink = () => {
    if (!link) return;
    link.unlink();
    link.release();
    link = null;
  };
  return {
    update(model: ChartLayer, ctx: LayerContext, order: number) {
      const settings = resolveIndicator(spec, model.params);
      if (!view) {
        view = make(ctx);
        for (const l of view.layers) chart.addLayer(l);
      }
      view.apply(settings, model, ctx, order);
      const shown = view.shown?.(settings) ?? view.layers.map(() => true);
      view.layers.forEach((l, k) => chart.setLayerVisible(l.id, model.visible && shown[k] !== false));
      const s = ctx.spec;
      const key =
        model.visible && ctx.flow && ctx.instrument && ctx.tf && s
          ? `${ctx.instrument}|${view.keepsLinkAcrossTimeframes ? '' : ctx.tf}|${ctx.session ?? 'all'}|${String(s.tickSize)}|${view.linkKey?.(settings, ctx) ?? ''}`
          : null;
      if (key === (link?.key ?? null)) return;
      unlink();
      if (key && ctx.flow && ctx.instrument && s) {
        const { flow, release } = ctx.flow.acquire(ctx.instrument, s.tickSize, s.priceDecimals);
        link = { key, unlink: view.link(flow, ctx, settings), release };
      }
    },
    dispose() {
      unlink();
      view?.dispose?.();
      if (view) for (const l of view.layers) chart.removeLayer(l.id);
      view = null;
    },
  };
}

export function registerFlowView(kind: DrawnLayerKind, make: (model: ChartLayer, ctx: LayerContext) => FlowView): void {
  const spec = INDICATOR_SPECS.find((s) => s.kind === kind);
  if (!spec) throw new Error(`no indicator declaration for ${kind}`);
  registerLayerFactory(kind, {
    label: (layer) => indicatorLabel(spec, resolveIndicator(spec, layer.params).inputs),
    create: (layer, ctx) => flowBinding(spec, ctx, (c) => make(layer, c)),
  });
}

export function flowLayerId(model: ChartLayer, part?: string): string {
  return part ? `${indicatorLayerId(model.id)}:${part}` : indicatorLayerId(model.id);
}

export function rowTicksOf(v: unknown): number | 'auto' {
  const n = Number(v);
  return v === 'auto' || !Number.isFinite(n) || n < 1 ? 'auto' : n;
}

export interface FootprintReader {
  readonly state: FlowState;
  readonly needFrom: number | null;
  setStore(store: FootprintStore | null): void;
  setGaps(gaps: readonly TimeSpan[]): void;
  dataChanged(): void;
}

export function followFootprints(
  layer: FootprintReader,
  flow: InstrumentFlow,
  ctx: LayerContext,
  days = DEFAULT_DAYS_TO_LOAD,
): () => void {
  const { feed, release } = flow.useFootprints(ctx.tf!, days);
  const links = new Links();
  layer.setStore(feed.store);
  const ensure = () => {
    if (layer.needFrom !== null) void feed.ensureFrom(layer.needFrom);
  };
  const sync = () => {
    noteFrom(layer.state, [feed.status]);
    layer.setGaps(feed.gaps);
    layer.state.aggressor = aggressorNoteOf(feed.aggressorSource);
    layer.dataChanged();
    ensure();
  };
  links.add(feed.changed.on(sync));
  links.add(ctx.chart.on('settled', ensure));
  sync();
  return () => {
    links.dispose();
    layer.setStore(null);
    layer.setGaps(NO_GAPS);
    layer.state.clear();
    release();
  };
}
