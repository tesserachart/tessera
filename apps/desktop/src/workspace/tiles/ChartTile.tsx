import type { AnnotationSpec, BracketsLayer, ChartApi } from '@tessera/chart';
import { normalizeEpochMs, type Annotation, type ChartLayer } from '@tessera/protocol';
import { Button, SKIP_SKELETON, formatInt } from '@tessera/ui';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { connectionOf } from '../../accounts/connections.ts';
import { useNeedsOnboarding } from '../../accounts/onboarding.ts';
import { useConnections } from '../../accounts/useConnections.ts';
import { useSight } from '../../app/inSight.ts';
import { useHasTool, useTool, useTools } from '../../app/tools.ts';
import { ChartSkeleton } from '../../chart/ChartSkeleton.tsx';
import { rememberAxisWidth } from '../../chart/chartSkeleton.ts';
import { ChartView } from '../../chart/ChartView.tsx';
import { useChartTheme } from '../../chart/chartTheme.ts';
import type { FeedMeta } from '../../chart/feed.ts';
import { layerFactory } from '../../chart/layers/index.ts';
import { groupLevels, isLevelShown, levelTitle, toggleLevel } from '../../chart/levels.ts';
import { ChartAlerts } from '../../chart/ChartAlerts.tsx';
import { ChartTrading } from '../../chart/ChartTrading.tsx';
import { loadErrorAction, loadErrorWords } from '../../chart/chartNotice.ts';
import { ChartDrawings } from '../../chart/drawings/ChartDrawings.tsx';
import { DrawingToolbar } from '../../chart/drawings/DrawingToolbar.tsx';
import { SymbolSearch } from '../../chart/ChartTools.tsx';
import { useShownDrawings } from '../../chart/drawings/sources.ts';
import { ChartIndicators } from '../../chart/settings/ChartIndicators.tsx';
import { useChartLevels } from '../../chart/useChartLevels.ts';
import { hoursOf, useChartSession } from '../../chart/hours.ts';
import { frontMonthsNote } from '../../market/frontMonths.ts';
import { displaySymbol, printBarsShort, isReplay } from '../../market/instruments.ts';
import { ReplayBar } from '../../chart/replay/ReplayBar.tsx';
import { ReplayPicker } from '../../chart/replay/ReplayPicker.tsx';
import { pricesStale, useFeeds } from '../../shell/freshness.ts';
import { chartTypeOf, useChartState, useStageView } from '../../state/layouts.ts';
import { useUi, openSymbolSearch } from '../../state/ui.ts';
import { patchActiveChartRef, useWorkspace, workspaceStore } from '../../state/workspace.ts';
import { activateChart, releaseActiveChart, updateChart } from '../controller.ts';
import type { ChartTileParams } from '../layouts.ts';
import { ChartBar } from './ChartBar.tsx';
import { ChartScope } from '../dock/header/Scope.tsx';
import { chartMenu } from './chartMenu.ts';
import { CHART_CANVAS_ATTR } from '../../share/model.ts';
import { ChartSettingsForm } from './ChartSettings.tsx';
import { ChartTab } from './ChartTab.tsx';
import { registerTile } from './registry.ts';
import { read } from '../../app/store.ts';
import { track } from '../../app/telemetry.ts';

function toAnnotationSpecs(annotations: readonly Annotation[], instrument: string): AnnotationSpec[] {
  return annotations
    .filter((a) => a.instrument === null || a.instrument === instrument)
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      points: a.points.map((p) => ({ t: p.t === null ? null : normalizeEpochMs(p.t), price: p.price })),
      label: a.label,
      agent: a.namespace === 'agent',
    }));
}

export function ChartTile({ params, api }: IDockviewPanelProps<ChartTileParams>) {
  const { layoutId, tileId } = params;
  const chart = useChartState(layoutId, tileId);
  const [meta, setMeta] = useState<FeedMeta | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const unconnected = useNeedsOnboarding() === true;
  const errorAction = error ? loadErrorAction(error, !unconnected) : null;
  const hasSpec = useHasTool('market.get_contract_spec');
  const canReport = useTools() !== null;
  const instrument = chart?.instrument ?? null;
  const specQ = useTool('market.get_contract_spec', hasSpec && !!instrument ? { instrument: instrument } : null, {
    keepFor: Infinity,
  });
  const spec = !hasSpec || specQ.isError ? null : specQ.isSuccess ? specQ.data.spec : undefined;
  const allLevels = useChartLevels(instrument);
  const session = useChartSession(instrument, chart?.printBars ? 'eth' : hoursOf(chart));
  const layers = useMemo(() => chart?.layers ?? [], [chart]);
  const annotations = useMemo(() => (chart ? toAnnotationSpecs(chart.annotations, chart.instrument) : []), [chart]);
  const drawings = useShownDrawings(layoutId, tileId);
  const resolved = spec?.instrument ?? null;
  const feedInstrument = meta?.instrument ?? null;
  const precision = spec?.priceDecimals ?? 2;
  const ids = useMemo(
    () => new Set([instrument, resolved, feedInstrument].filter((x): x is string => !!x)),
    [instrument, resolved, feedInstrument],
  );
  const [handle, setHandle] = useState<{ chart: ChartApi; layer: BracketsLayer } | null>(null);
  const seriesStyle = chartTypeOf(
    useStageView(layoutId),
    tileId,
    useUi((s) => s.defaultChartType),
    chart,
  );
  const active = useWorkspace((s) => s.activeChart?.tileId === tileId && s.activeChart.layoutId === layoutId);
  const subscribeVisible = useCallback(
    (changed: () => void) => {
      const sub = api.onDidVisibilityChange(changed);
      return () => sub.dispose();
    },
    [api],
  );
  const visible = useSyncExternalStore(subscribeVisible, () => api.isVisible);
  const sight = useSight();
  const themeVars = useChartTheme((s) => s.vars);
  const interval = chart ? (chart.printBars ? printBarsShort(chart.printBars) : chart.timeframe) : null;
  const tabTitle = chart ? `${displaySymbol(resolved ?? chart.instrument)} ${interval ?? ''}` : null;
  useEffect(() => {
    if (tabTitle) api.setTitle(tabTitle);
  }, [api, tabTitle]);

  const activate = () => activateChart(layoutId, tileId, meta?.source.provider);
  const activateFromEffect = useEffectEvent(activate);
  useEffect(() => {
    if (chart && sight.get() && !read(workspaceStore).activeChart) activateFromEffect();
  }, [chart, sight]);
  const provider = meta?.source.provider ?? null;
  const { rows: connections } = useConnections();
  const providerName = provider === null ? undefined : connectionOf(connections, provider)?.name;
  const feedLine = meta
    ? [`${formatInt(meta.bars)} bars`, providerName].filter((part) => part !== undefined).join(' · ')
    : '';
  const feeds = useFeeds();
  const loaded = instrument && interval && meta && meta.bars > 0 ? `${instrument} ${interval}` : null;
  useEffect(() => {
    if (loaded && instrument && interval) track({ event: 'chart loaded', instrument, timeframe: interval });
  }, [loaded, instrument, interval]);
  const drawn = handle?.chart ?? null;
  useEffect(() => {
    if (!drawn || !loaded || !instrument) return;
    return () => rememberAxisWidth(instrument, drawn.coords().priceAxis.w);
  }, [drawn, loaded, instrument]);
  useEffect(() => {
    if (active && provider) patchActiveChartRef(layoutId, tileId, { source: provider });
  }, [active, provider, layoutId, tileId]);
  useEffect(() => () => releaseActiveChart(layoutId, tileId), [layoutId, tileId]);

  if (!chart) {
    return (
      <div className="tile">
        <div className="tile-empty">
          Chart <b>{tileId}</b> is not in layout {layoutId}.
        </div>
      </div>
    );
  }

  const edit = (fn: (ls: readonly ChartLayer[]) => ChartLayer[]) =>
    void updateChart(layoutId, tileId, (c) => ({ ...c, layers: fn(c.layers) }));
  const agentObjects =
    chart.layers.filter((l) => l.namespace === 'agent').length +
    chart.annotations.filter((a) => a.namespace === 'agent').length;
  const frontMonths = meta ? frontMonthsNote(meta.contracts, meta.instrument) : null;

  return (
    <div
      className="tile chart-tile"
      data-focus-zone="chart"
      data-active={active || undefined}
      onPointerDownCapture={activate}
      onFocusCapture={activate}
      onKeyDown={(e) => {
        const el = e.target as HTMLElement;
        if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || !/[a-z0-9]/i.test(e.key)) return;
        if (el.closest('input, textarea, [contenteditable="true"], [role="menu"]')) return;
        e.preventDefault();
        activate();
        openSymbolSearch(e.key);
      }}
    >
      {isReplay(chart.instrument) ? <ReplayBar target={{ layoutId, tileId }} instrument={chart.instrument} /> : null}
      <ReplayPicker target={{ layoutId, tileId }} charted={chart.instrument} />
      <ChartBar layoutId={layoutId} tileId={tileId} />
      <div className="chart-body">
        <div
          className="chart-canvas"
          {...{ [CHART_CANVAS_ATTR]: tileId }}
          data-draw={active || undefined}
          {...SKIP_SKELETON}
          style={themeVars as CSSProperties}
        >
          <SymbolSearch active={active} />
          <ChartTrading
            chart={handle?.chart ?? null}
            layer={handle?.layer ?? null}
            layoutId={layoutId}
            tileId={tileId}
            instrument={chart.instrument}
            ids={ids}
            spec={spec}
            levels={allLevels}
            layers={layers}
          >
            <ChartView
              layoutId={layoutId}
              tileId={tileId}
              instrument={chart.instrument}
              tf={chart.timeframe}
              printBars={chart.printBars ?? null}
              session={session}
              spec={spec}
              layers={layers}
              levels={allLevels}
              annotations={annotations}
              seriesStyle={seriesStyle}
              reportViewport={canReport}
              precision={precision}
              onChart={(c, l) => setHandle(c && l ? { chart: c, layer: l } : null)}
              onMeta={setMeta}
              onError={setError}
              onLoading={setLoading}
              visible={visible}
              lastPrice={pricesStale(feeds, provider) ? 'stale' : 'live'}
            />
          </ChartTrading>
          <ChartIndicators
            chart={handle?.chart ?? null}
            layoutId={layoutId}
            tileId={tileId}
            layers={layers}
            precision={precision}
          />
          <ChartDrawings
            chart={handle?.chart ?? null}
            layoutId={layoutId}
            tileId={tileId}
            instrument={chart.instrument}
            drawings={drawings}
          />
          <ChartAlerts
            chart={handle?.chart ?? null}
            ids={ids}
            decimals={precision}
            tick={spec?.tickSize ?? 10 ** -precision}
            target={{ layoutId, tileId }}
          />
          {active ? (
            <DrawingToolbar
              chart={{ layoutId, tileId }}
              api={handle?.chart ?? null}
              instrument={chart.instrument}
              count={drawings.length}
            />
          ) : null}
          {loading ? (
            <div className="chart-status is-loading" role="status" aria-label="Loading bars">
              <ChartSkeleton chart={handle?.chart ?? null} instrument={chart.instrument} />
            </div>
          ) : error ? (
            <div className="chart-status" role="status">
              <p data-selectable>{loadErrorWords(chart.instrument, error)}</p>
              {errorAction ? (
                <Button size="s" variant="quiet" onClick={errorAction.run}>
                  {errorAction.label}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="layer-strip" role="toolbar" aria-label="Layers">
            {layers
              .filter((l) => l.kind !== 'levels')
              .map((l) => {
                const factory = layerFactory(l.kind);
                const label = factory ? factory.label(l) : l.kind.toUpperCase();
                return factory ? (
                  <button
                    key={l.id}
                    type="button"
                    className={l.namespace === 'agent' ? 'lc ag' : 'lc'}
                    aria-pressed={l.visible}
                    title={l.namespace === 'agent' ? `${label} · added by an agent` : label}
                    onClick={() => edit((ls) => ls.map((x) => (x.id === l.id ? { ...x, visible: !x.visible } : x)))}
                  >
                    {label}
                  </button>
                ) : (
                  <span key={l.id} className="lc" aria-disabled="true" title="This layer kind is not drawn yet">
                    {label}
                  </span>
                );
              })}
            {groupLevels(allLevels, layers).map((g) => (
              <span key={g.label} style={{ display: 'contents' }}>
                <span className="ldiv" />
                <span className="grp">{g.label}</span>
                {g.levels.map((l) => {
                  const on = isLevelShown(layers, l);
                  return (
                    <button
                      key={l.key}
                      type="button"
                      className="lc"
                      aria-pressed={on}
                      aria-label={l.label}
                      disabled={l.price === null}
                      onClick={() => edit((ls) => toggleLevel(ls, l))}
                      title={levelTitle(l)}
                    >
                      {l.short ?? l.label}
                    </button>
                  );
                })}
              </span>
            ))}
            {agentObjects > 0 ? (
              <>
                <span className="ldiv" />
                <span className="grp">Analyst</span>
                <span className="lc ag">{agentObjects} marks</span>
              </>
            ) : null}
            <span className="meta">{feedLine}</span>
            {frontMonths ? (
              <span
                className="meta"
                title="Daily history continues through the earlier quarterly contracts, each from the day it became the front month. Every bar keeps its own contract's prices."
              >
                {frontMonths}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

registerTile({
  kind: 'chart',
  title: 'Chart',
  component: ChartTile,
  home: 'centre',
  icon: 'chart',
  linkable: true,
  tab: ChartTab,
  scope: ChartScope,
  menu: chartMenu,
  settings: { component: ChartSettingsForm },
});
