import {
  AnnotationLayer,
  BigTradesLayer,
  BracketsLayer,
  CandlesLayer,
  createChart,
  LevelsLayer,
  type AnnotationSpec,
  type BigTradeCard,
  type ChartApi,
  LegendLayer,
  type LevelSpec,
  type OrderScene,
  type SeriesStyle,
} from '@tessera/chart';
import {
  msToNs,
  timeframeMs,
  type ChartLayer,
  type ContractSpec,
  type Level,
  type PrintBars,
  type SessionFilter,
  type Timeframe,
} from '@tessera/protocol';
import { MOTION } from '@tessera/ui';
import { useEffect, useEffectEvent, useRef } from 'react';
import { useClock } from '../app/clock.ts';
import { useInSight } from '../app/inSight.ts';
import { useTradeSettings, tradeSettingsStore } from '../state/tradeSettings.ts';
import { updateChart } from '../workspace/controller.ts';
import { ChartFeed, type FeedMeta } from './feed.ts';
import { withPaneHeights } from './indicators.ts';
import { flowHub } from '../market/flow/hub.ts';
import { bubbleTipAreas, bubbleTipCards, fillBubbleTip, placeBubbleTip } from './bubbleTip.ts';
import { gapTipWords } from './gapTip.ts';
import { LayerReconciler, type LevelsSink } from './layers/index.ts';
import { legendItems, type LegendSource } from './legend.ts';
import { useChartTheme, chartThemeStore } from './chartTheme.ts';
import { applyLevelSettings, type Palette } from './levelSettings.ts';
import { useLevelSources } from './useLevelSources.ts';
import { onMarkTime } from '../market/flow/events.ts';
import {
  keepView,
  keptView,
  onViewportRequest,
  pendingViewport,
  viewportTaken,
  viewportUpdate,
} from './viewportRequests.ts';
import { askOutcome, reportedView, viewToKeep, type HeldBars } from './askedView.ts';
import { viewShortWords } from '../shell/deskWords.ts';
import { displayZone } from '../state/timeZone.ts';
import { layoutsStore } from '../state/layouts.ts';
import type { HistoryEnd } from '../market/bars.ts';
import { TimeMarkLayer } from './timeMark.ts';
import { HistoryEdgeLayer } from './historyEdge.ts';
import { read } from '../app/store.ts';
import { runTool } from '../app/tools.ts';
import { profilesKey, renderedProfiles } from './renderedProfiles.ts';
import { CHART_INITIAL_BARS, CHART_RIGHT_PAD_BARS } from './chartSkeleton.ts';
import { quietWhileSharing } from '../share/quiet.ts';

const ORDERS_LAYER = 'orders';

export interface ChartViewProps {
  layoutId: string;
  tileId: string;
  instrument: string;
  tf: Timeframe;
  printBars?: PrintBars | null;
  session?: SessionFilter;
  spec: ContractSpec | null | undefined;
  layers: readonly ChartLayer[];
  levels: readonly Level[];
  annotations: readonly AnnotationSpec[];
  scene?: OrderScene;
  onChart?: (chart: ChartApi | null, brackets: BracketsLayer | null) => void;
  seriesStyle?: SeriesStyle;
  reportViewport: boolean;
  precision: number;
  onMeta?: (meta: FeedMeta) => void;
  onError?: (error: Error | null) => void;
  onLoading?: (loading: boolean) => void;
  visible?: boolean;
  lastPrice?: 'live' | 'stale';
}

const VIEWPORT_REPORT_MS = 1000;
const PROFILE_REPORT_MS = 1500;
const TIP_GAP = 12;
const BUBBLE_TIP_GAP = 8;
const TIP_INSET = 6;

export function ChartView(props: ChartViewProps) {
  const { layoutId, tileId, instrument, tf, printBars, spec, layers, levels, annotations, scene, reportViewport } =
    props;
  const { precision } = props;
  const session = props.session ?? 'all';
  const legendRef = useRef<LegendSource>({ layers, levels, precision, contracts: [], charted: null });
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartApi | null>(null);
  const feedRef = useRef<ChartFeed | null>(null);
  const reconcilerRef = useRef<LayerReconciler | null>(null);
  const sinkRef = useRef<LevelsSink | null>(null);
  const annotationsRef = useRef<AnnotationLayer | null>(null);
  const ordersRef = useRef<BracketsLayer | null>(null);
  const levelSettings = useTradeSettings((s) => s.levels);
  const levelDefs = useLevelSources().defs;
  const levelDefsRef = useRef(levelDefs);
  const republishRef = useRef<(() => void) | null>(null);
  const clock = useClock();
  const markIds = useRef<readonly string[]>([]);
  const specInstrument = spec?.instrument;
  useEffect(() => {
    markIds.current = [instrument, specInstrument].filter((x): x is string => !!x);
  }, [instrument, specInstrument]);
  const theme = useChartTheme((s) => s.theme);
  const emitMeta = useEffectEvent((meta: FeedMeta) => {
    Object.assign(legendRef.current, { contracts: meta.contracts, charted: meta.instrument });
    props.onError?.(null);
    props.onMeta?.(meta);
  });
  const emitError = useEffectEvent((err: Error | null) => props.onError?.(err));
  const emitLoading = useEffectEvent((loading: boolean) => props.onLoading?.(loading));
  const emitChart = useEffectEvent((chart: ChartApi | null, b: BracketsLayer | null) => props.onChart?.(chart, b));
  const savePaneHeights = useEffectEvent((heights: readonly { id: string; height: number }[]) => {
    void updateChart(layoutId, tileId, (c) => {
      const next = withPaneHeights(c.layers, heights);
      return next ? { ...c, layers: next } : c;
    });
  });
  const reportedProfiles = useRef('');
  const shownRef = useRef(true);
  const answerRef = useRef<string | null>(null);
  const shortRef = useRef<string | null>(null);
  const endRef = useRef<HistoryEnd | null>(null);
  const stopRef = useRef<string | null>(null);
  const edgeRef = useRef<HistoryEdgeLayer | null>(null);
  const report = useEffectEvent((chart: ChartApi, onlyIfProfilesChanged = false) => {
    if (!reportViewport || !shownRef.current || chart.coords().plot.w <= 1) return;
    const vp = chart.getViewport();
    const series = chart.getSeries();
    if (!vp.shown || !series) return;
    const profiles = renderedProfiles(chart, layers);
    const key = profilesKey(profiles);
    if (onlyIfProfilesChanged && key === reportedProfiles.current) return;
    reportedProfiles.current = key;
    const answers = answerRef.current;
    answerRef.current = null;
    void runTool('chart.report_viewport', {
      tileId,
      layoutId,
      viewport: {
        from: msToNs(series.time[vp.shown.from]!),
        to: msToNs(series.time[vp.shown.to]!),
        priceMin: vp.priceMin,
        priceMax: vp.priceMax,
        bars: vp.shown.to - vp.shown.from + 1,
        reportedAt: msToNs(clock.now()),
        ...(vp.following ? { follows: true } : {}),
        ...(shortRef.current ? { short: shortRef.current } : {}),
        ...(answers ? { answers } : {}),
        ...(profiles.length ? { profiles } : {}),
      },
    }).catch(() => undefined);
  });
  const held = (chart: ChartApi): HeldBars => {
    const s = chart.getSeries();
    const n = s?.length ?? 0;
    if (!s || n === 0) return { count: 0, first: null, last: null, lastEnd: null };
    const last = s.time[n - 1]!;
    return { count: n, first: s.time[0]!, last, lastEnd: printBars ? Infinity : last + timeframeMs(tf) };
  };
  const settleAsk = useEffectEvent((chart: ChartApi) => {
    const asked = chart.getViewport().asked;
    const outcome = asked ? askOutcome(asked, held(chart), endRef.current) : null;
    shortRef.current = outcome?.kind === 'short' ? viewShortWords(outcome.short, displayZone()) : null;
    edgeRef.current?.set(
      shortRef.current ?? stopRef.current,
      outcome?.kind === 'short' && outcome.short.kind === 'after',
    );
    if (!answerRef.current || outcome?.kind === 'reading' || !shownRef.current) return;
    chart.render(true);
    report(chart);
  });
  const restoreView = useEffectEvent((chart: ChartApi) => {
    const view =
      keptView({ layoutId, tileId }) ?? reportedView(read(layoutsStore).layouts[layoutId]?.charts[tileId]?.viewport);
    if (view) chart.setViewport(view);
  });
  const rememberView = useEffectEvent((chart: ChartApi) => {
    const series = chart.getSeries();
    if (series && series.length > 0) keepView({ layoutId, tileId }, viewToKeep(chart.getViewport(), series.time));
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      theme: read(chartThemeStore).theme,
      now: clock.now,
      legend: { title: '' },
      initialBars: CHART_INITIAL_BARS,
      rightPadBars: CHART_RIGHT_PAD_BARS,
      volumePane: 0,
    });
    const levelsLayer = new LevelsLayer({ id: 'levels', z: 20, vendorOnce: true, shortTags: false });
    chart.addLayer(levelsLayer);
    const byLayer = new Map<string, readonly LevelSpec[]>();
    const publish = () => {
      const seen = new Set<string>();
      const all: LevelSpec[] = [];
      const settings = read(tradeSettingsStore).levels;
      const { swatches } = read(chartThemeStore);
      const palette = swatches as unknown as Palette;
      for (const specs of byLayer.values()) {
        for (const s of specs) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          const styled = applyLevelSettings(s, settings, palette, levelDefsRef.current);
          if (styled) all.push(styled);
        }
      }
      levelsLayer.setLevels(all);
    };
    republishRef.current = publish;
    sinkRef.current = {
      set(layerId, specs) {
        byLayer.set(layerId, specs);
        publish();
      },
      remove(layerId) {
        byLayer.delete(layerId);
        publish();
      },
    };
    const annotationLayer = new AnnotationLayer({ id: 'annotations', z: 30 });
    chart.addLayer(annotationLayer);
    const orderLayer = new BracketsLayer({ id: ORDERS_LAYER, z: 40 });
    chart.addLayer(orderLayer);
    const markLayer = new TimeMarkLayer();
    chart.addLayer(markLayer);
    const edgeLayer = new HistoryEdgeLayer();
    chart.addLayer(edgeLayer);
    edgeRef.current = edgeLayer;
    restoreView(chart);
    const offMark = onMarkTime((m) => {
      if (m && !markIds.current.includes(m.instrument)) return;
      markLayer.set(m ? { t: m.t, price: m.price } : null);
      if (m) markLayer.reveal(chart);
    });
    const legend = chart.getLayer('legend', LegendLayer);
    if (legend) legend.extra = (i) => legendItems(legendRef.current, chart.getSeries()?.time[i]);
    const feed = new ChartFeed(chart, {
      onMeta: (m) => emitMeta(m),
      onError: (e) => emitError(e),
      onLoading: (l) => emitLoading(l),
      onHistoryStop: (why) => {
        stopRef.current = why;
        settleAsk(chart);
      },
      onHistoryEnd: (end) => {
        endRef.current = end;
        settleAsk(chart);
      },
      warm: true,
    });
    chartRef.current = chart;
    feedRef.current = feed;
    reconcilerRef.current = new LayerReconciler();
    annotationsRef.current = annotationLayer;
    ordersRef.current = orderLayer;
    emitChart(chart, orderLayer);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const offViewport = chart.on('viewport', () => {
      settleAsk(chart);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => report(chart), VIEWPORT_REPORT_MS);
    });
    const profileWatch = setInterval(() => report(chart, true), PROFILE_REPORT_MS);
    const offPanes = chart.on('panes', (heights) => savePaneHeights(heights));
    let tipTimer: ReturnType<typeof setTimeout> | null = null;
    let tipWarm = false;
    const hideTip = () => {
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = null;
      const el = tipRef.current;
      if (el?.dataset.open === 'true') {
        el.dataset.open = 'false';
        setTimeout(() => {
          if (tipRef.current?.dataset.open !== 'true') tipWarm = false;
        }, 400);
      }
    };
    let hoveredLayer: BigTradesLayer | null = null;
    const hover = (layer: BigTradesLayer | null, ref: string | null) => {
      if (hoveredLayer && hoveredLayer !== layer) hoveredLayer.setHovered(null);
      layer?.setHovered(ref);
      hoveredLayer = layer;
    };
    const offTip = chart.on('crosshair', (e) => {
      const el = tipRef.current;
      if (!el) return;
      let hit: { x: number; y: number; r: number; cards: BigTradeCard[] } | null = null;
      if (e) {
        for (const info of chart.layers()) {
          const l = info.visible ? chart.getLayer(info.id) : null;
          if (!(l instanceof BigTradesLayer)) continue;
          const ms = l.markersAt(e.x, e.y);
          const m = ms[0];
          if (m) {
            hit = { x: m.x, y: m.y, r: m.r, cards: bubbleTipCards(ms, legendRef.current.precision) };
            hover(l, m.trade.ref);
            break;
          }
        }
      }
      if (!hit) {
        hover(null, null);
        if (el.dataset.kind !== 'gap') hideTip();
        return;
      }
      const h = hit;
      const show = () => {
        el.dataset.kind = 'bubble';
        fillBubbleTip(el, h.cards);
        const areas = bubbleTipAreas(chart.coords(), TIP_INSET);
        el.style.maxWidth = `${String(Math.floor(Math.max(...areas.map((a) => a.w))))}px`;
        const at = placeBubbleTip(h, { w: el.offsetWidth, h: el.offsetHeight }, areas, BUBBLE_TIP_GAP);
        el.style.transform = `translate(${String(Math.round(at.x))}px, ${String(Math.round(at.y))}px)`;
        el.dataset.open = 'true';
        tipWarm = true;
      };
      if (tipWarm) show();
      else {
        if (tipTimer) clearTimeout(tipTimer);
        tipTimer = setTimeout(show, MOTION.tooltipDelayMs);
      }
    });
    const offGap = chart.on('gap', (g) => {
      const el = tipRef.current;
      if (!el) return;
      if (!g) {
        if (el.dataset.kind === 'gap') hideTip();
        return;
      }
      const show = () => {
        el.dataset.kind = 'gap';
        el.style.maxWidth = '';
        el.textContent = gapTipWords(g.from, g.to);
        const box = el.parentElement;
        const w = el.offsetWidth;
        const x = Math.max(TIP_GAP, Math.min(g.x - w / 2, (box?.clientWidth ?? Infinity) - w - TIP_GAP));
        const y = g.y - el.offsetHeight - TIP_GAP;
        el.style.transform = `translate(${String(Math.round(x))}px, ${String(Math.round(y))}px)`;
        el.dataset.open = 'true';
        tipWarm = true;
      };
      if (tipWarm) show();
      else {
        if (tipTimer) clearTimeout(tipTimer);
        tipTimer = setTimeout(show, MOTION.tooltipDelayMs);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      if (tipTimer) clearTimeout(tipTimer);
      offTip();
      offGap();
      offMark();
      offViewport();
      clearInterval(profileWatch);
      offPanes();
      rememberView(chart);
      emitChart(null, null);
      reconcilerRef.current?.dispose();
      feed.dispose();
      chart.destroy();
      chartRef.current = null;
      feedRef.current = null;
      reconcilerRef.current = null;
      sinkRef.current = null;
      republishRef.current = null;
      annotationsRef.current = null;
      ordersRef.current = null;
      edgeRef.current = null;
    };
  }, [clock]);

  useEffect(() => {
    const target = { layoutId, tileId };
    const take = () => {
      const chart = chartRef.current;
      const view = pendingViewport(target);
      if (!chart || !view) return;
      viewportTaken(target);
      answerRef.current = view.op ?? null;
      chart.setViewport(viewportUpdate(view));
      settleAsk(chart);
    };
    const offAsk = onViewportRequest(target, take);
    take();
    return offAsk;
  }, [layoutId, tileId]);

  useEffect(
    () =>
      quietWhileSharing(tileId, () => {
        const chart = chartRef.current;
        if (!chart) return () => undefined;
        const ordersShown = chart.layers().find((l) => l.id === ORDERS_LAYER)?.visible ?? false;
        chart.setLayerVisible(ORDERS_LAYER, false);
        chart.setOptions({ countdown: false });
        chart.render(true);
        return () => {
          if (chartRef.current !== chart) return;
          chart.setLayerVisible(ORDERS_LAYER, ordersShown);
          chart.setOptions({ countdown: true });
          chart.render(true);
        };
      }),
    [tileId],
  );

  useEffect(() => {
    Object.assign(legendRef.current, { contracts: [], charted: null });
  }, [instrument, tf]);

  useEffect(() => {
    feedRef.current?.load(instrument, tf, spec ?? null, printBars ?? null, session);
  }, [instrument, tf, spec, printBars, session]);

  useEffect(() => {
    const chart = chartRef.current;
    const sink = sinkRef.current;
    if (!chart || !sink) return;
    reconcilerRef.current?.reconcile(layers, {
      chart,
      levels,
      levelsSink: sink,
      levelSettings,
      instrument,
      tf,
      printBars: printBars ?? null,
      session,
      spec,
      flow: flowHub(clock),
    });
    levelDefsRef.current = levelDefs;
    republishRef.current?.();
  }, [layers, levels, levelSettings, levelDefs, clock, instrument, tf, printBars, session, spec, theme]);

  useEffect(() => {
    Object.assign(legendRef.current, { layers, levels, precision });
    chartRef.current?.setOptions({});
  }, [layers, levels, precision]);

  useEffect(() => {
    annotationsRef.current?.setAnnotations(annotations);
  }, [annotations, clock]);

  useEffect(() => {
    if (scene) ordersRef.current?.setScene(scene);
  }, [scene, clock]);

  useEffect(() => {
    chartRef.current?.setOptions({ theme });
  }, [theme]);

  const lastPrice = props.lastPrice ?? 'live';
  useEffect(() => {
    chartRef.current?.setOptions({ lastPrice });
  }, [lastPrice, clock]);

  const inSight = useInSight();
  const visible = (props.visible ?? true) && inSight;
  useEffect(() => {
    const chart = chartRef.current;
    shownRef.current = visible;
    chart?.setSuspended(!visible);
    if (chart && visible) settleAsk(chart);
  }, [visible, clock]);

  const seriesStyle = props.seriesStyle ?? 'candles';
  useEffect(() => {
    const chart = chartRef.current;
    const series = chart?.getLayer('candles', CandlesLayer);
    if (!chart || !series || series.style === seriesStyle) return;
    series.style = seriesStyle;
    chart.setOptions({});
  }, [seriesStyle, clock]);

  return (
    <>
      <div ref={hostRef} className="chart-host" style={{ position: 'absolute', inset: 0 }} />
      <div ref={tipRef} className="t-tip chart-bubble-tip" role="tooltip" data-open="false" />
    </>
  );
}
