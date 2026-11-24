import type { JsonValue, Timeframe, TradeDetail } from '@tessera/protocol';
import {
  AnnotationLayer,
  LevelsLayer,
  TradeLayer,
  createChart,
  type ChartApi,
  type DrawingEvent,
  type DrawingKind,
  type DrawingSpec,
} from '@tessera/chart';
import { Button, SKIP_SKELETON, Select, Tooltip, cx } from '@tessera/ui';
import { useEffect, useRef, useState } from 'react';
import { refreshUnread, runTool } from '../../../app/tools.ts';
import { ChartSkeleton } from '../../../chart/ChartSkeleton.tsx';
import { chartThemeStore, orderColorsOf } from '../../../chart/chartTheme.ts';
import { colorOf } from '../../../chart/indicators.ts';
import { ColorControl } from '../../../chart/settings/controls.tsx';
import type { PlanLeg } from '../model/activity.ts';
import { autoTimeframe } from '../model/chart.ts';
import { nsToMs } from '../model/format.ts';
import { tradeFrame, tradeOverlayOf } from '../model/tradeOverlay.ts';
import { TF_MS, useTradeBars, useTradeTf, type TfChoice } from './tradeBars.ts';
import { read } from '../../../app/store.ts';

const TFS: readonly Timeframe[] = ['1m', '5m', '15m', '1h'];

export function TfSelect({
  choice,
  tf,
  onChange,
}: {
  choice: TfChoice;
  tf: Timeframe;
  onChange: (c: TfChoice) => void;
}) {
  return (
    <Select<TfChoice>
      size="s"
      label="Interval"
      value={choice}
      onValueChange={onChange}
      options={[{ value: 'auto', label: `Auto · ${tf}` }, ...TFS.map((v) => ({ value: v, label: v }))]}
    />
  );
}

interface Kept {
  id: string;
  kind: DrawingKind;
  points: { t: number; price: number }[];
  color: string;
  dash: 'solid' | 'dash';
}

function readKept(raw: readonly unknown[]): Kept[] {
  return raw.flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Partial<Kept>;
    if (typeof o.id !== 'string' || (o.kind !== 'horizontal_line' && o.kind !== 'vertical_line')) return [];
    if (!Array.isArray(o.points)) return [];
    return [
      {
        id: o.id,
        kind: o.kind,
        points: o.points.map((p) => ({ t: Number(p.t as unknown), price: Number(p.price as unknown) })),
        color: typeof o.color === 'string' ? o.color : 'mist',
        dash: o.dash === 'dash' ? 'dash' : 'solid',
      },
    ];
  });
}

function spec(k: Kept): DrawingSpec {
  return {
    id: k.id,
    kind: k.kind,
    points: k.points,
    color: colorOf(k.color),
    width: 1,
    dash: k.dash,
    extend: 'none',
    locked: false,
    agent: false,
  };
}

export function TradeChart({
  d,
  height = 380,
  lit = null,
}: {
  d: TradeDetail;
  height?: number | string;
  lit?: { leg: PlanLeg; price: number } | null;
}) {
  const t = d.trade;
  const host = useRef<HTMLDivElement>(null);
  const [tf, choice, setChoice] = useTradeTf(t.holdSecs);
  const { bars, state } = useTradeBars(d, tf);
  const [fit, setFit] = useState(0);
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const [dash, setDash] = useState<'solid' | 'dash'>('solid');
  const [color, setColor] = useState('mist');
  const [kept, setKept] = useState<Kept[]>(() => readKept(d.drawings));
  const [seen, setSeen] = useState(t.id);
  if (t.id !== seen) {
    setSeen(t.id);
    setKept(readKept(d.drawings));
    setTool(null);
  }
  const litLayer = useRef<{ layer: LevelsLayer; up: string; down: string } | null>(null);
  const marksRef = useRef<AnnotationLayer | null>(null);
  const now = useRef({ lit, kept, tool, dash, color });
  const onDrawing = useRef<(e: DrawingEvent) => void>(() => undefined);
  const save = (next: Kept[]) => {
    setKept(next);
    void runTool('journal.save_trade_drawings', { tradeId: t.id, drawings: next as unknown as JsonValue[] }).then(
      () => {
        refreshUnread('journal.get_trade');
      },
    );
  };
  useEffect(() => {
    now.current = { lit, kept, tool, dash, color };
    onDrawing.current = (e) => {
      if (e.type === 'create' && (e.kind === 'horizontal_line' || e.kind === 'vertical_line')) {
        save([...kept, { id: `d${String(Date.now())}`, kind: e.kind, points: e.points, color, dash }]);
        setTool(null);
      } else if (e.type === 'move') save(kept.map((k) => (k.id === e.id ? { ...k, points: e.points } : k)));
      else if (e.type === 'remove') save(kept.filter((k) => k.id !== e.id));
      else if (e.type === 'cancel') setTool(null);
    };
  });
  useEffect(() => {
    const el = host.current;
    if (!el || !bars.length) return;
    const step = TF_MS[tf] ?? 60_000;
    const { theme, resolved } = read(chartThemeStore);
    const chart: ChartApi = createChart(el, {
      theme,
      legend: { title: `${t.symbol} · ${tf}`, hover: true },
      timeframeMs: step,
      rightPadBars: 4,
      volumePane: 0,
      priceFormat: { precision: t.priceDecimals, minMove: d.tickSize || 0.01 },
    });
    chart.setLayerVisible('last-price', false);
    chart.setData('main', bars);
    const oc = orderColorsOf(resolved);
    const trade = new TradeLayer({ id: 'trade', z: 24 });
    chart.addLayer(trade);
    trade.setTrade(
      tradeOverlayOf(d, {
        entry: oc.mist,
        up: oc.up,
        down: oc.down,
        stopZone: oc.downZone,
        targetZone: oc.upZone,
        label: theme.mutedText,
      }),
    );
    const last = bars[bars.length - 1]!.t;
    chart.setViewport({
      range: tradeFrame(nsToMs(t.openedAt), t.closedAt === null ? null : nsToMs(t.closedAt), last, step),
    });
    const pick = new LevelsLayer({ id: 'trade-lit', z: 25, shortTags: false });
    chart.addLayer(pick);
    litLayer.current = { layer: pick, up: oc.up, down: oc.down };
    drawLit(litLayer.current, now.current.lit);
    const marks = new AnnotationLayer({ id: 'trade-drawings', z: 30 });
    chart.addLayer(marks);
    marks.onDrawing = (e) => onDrawing.current(e);
    marksRef.current = marks;
    const n = now.current;
    marks.setDrawings(n.kept.map(spec));
    marks.setNewDrawingStyle({ color: colorOf(n.color), width: 1, dash: n.dash });
    marks.setDrawingTool(n.tool);
    return () => {
      litLayer.current = null;
      marksRef.current = null;
      chart.destroy();
    };
  }, [bars, d, t, tf, fit]);
  useEffect(() => {
    if (litLayer.current) drawLit(litLayer.current, lit);
  }, [lit]);
  useEffect(() => {
    const m = marksRef.current;
    if (!m) return;
    m.setDrawings(kept.map(spec));
  }, [kept]);
  useEffect(() => {
    const m = marksRef.current;
    if (!m) return;
    m.setDrawingTool(tool);
    m.setNewDrawingStyle({ color: colorOf(color), width: 1, dash });
  }, [tool, dash, color]);
  return (
    <div className="jr-tchart">
      <TradeChartHead
        choice={choice}
        tf={tf}
        onChoice={setChoice}
        onFit={() => setFit((f) => f + 1)}
        tool={tool}
        onTool={setTool}
        dash={dash}
        onDash={setDash}
        color={color}
        onColor={setColor}
        onClear={kept.length ? () => save([]) : null}
      />
      <div className="jr-tchart-plot" ref={host} style={{ height }}>
        {state === 'none' ? (
          <div className="jr-empty">
            No bars for {t.instrument} at its time from the connections open now. Fills and levels are in the panel.
          </div>
        ) : state === 'loading' ? (
          <ChartSkeleton chart={null} instrument={t.instrument} />
        ) : null}
      </div>
    </div>
  );
}

const ignore = () => undefined;

export function TradeChartSample({ d, height = 380 }: { d: TradeDetail; height?: number | string }) {
  return (
    <div className="jr-tchart">
      <TradeChartHead
        choice="auto"
        tf={autoTimeframe(d.trade.holdSecs)}
        onChoice={ignore}
        onFit={ignore}
        tool={null}
        onTool={ignore}
        dash="solid"
        onDash={ignore}
        color="mist"
        onColor={ignore}
        onClear={null}
      />
      <div className="jr-tchart-plot" style={{ height }} {...SKIP_SKELETON}>
        <ChartSkeleton chart={null} instrument={d.trade.instrument} />
      </div>
    </div>
  );
}

function TradeChartHead({
  choice,
  tf,
  onChoice,
  onFit,
  tool,
  onTool,
  dash,
  onDash,
  color,
  onColor,
  onClear,
}: {
  choice: TfChoice;
  tf: Timeframe;
  onChoice: (c: TfChoice) => void;
  onFit: () => void;
  tool: DrawingKind | null;
  onTool: (tool: DrawingKind | null) => void;
  dash: 'solid' | 'dash';
  onDash: (dash: 'solid' | 'dash') => void;
  color: string;
  onColor: (color: string) => void;
  onClear: (() => void) | null;
}) {
  return (
    <div className="jr-tchart-head">
      <TfSelect choice={choice} tf={tf} onChange={onChoice} />
      <Tooltip content="Fit the trade">
        <Button size="s" variant="quiet" onClick={onFit}>
          Fit
        </Button>
      </Tooltip>
      <span className="jr-tchart-sep" />
      <Tooltip content="Horizontal line" shortcut="H">
        <button
          type="button"
          className={cx('jr-tool', tool === 'horizontal_line' && 'is-on')}
          aria-pressed={tool === 'horizontal_line'}
          onClick={() => onTool(tool === 'horizontal_line' ? null : 'horizontal_line')}
        >
          H
        </button>
      </Tooltip>
      <Tooltip content="Vertical line" shortcut="V">
        <button
          type="button"
          className={cx('jr-tool', tool === 'vertical_line' && 'is-on')}
          aria-pressed={tool === 'vertical_line'}
          onClick={() => onTool(tool === 'vertical_line' ? null : 'vertical_line')}
        >
          V
        </button>
      </Tooltip>
      <Tooltip content={dash === 'solid' ? 'Solid line' : 'Dashed line'}>
        <button type="button" className="jr-tool" onClick={() => onDash(dash === 'solid' ? 'dash' : 'solid')}>
          <span className={cx('jr-tool-dash', dash)} />
        </button>
      </Tooltip>
      <ColorControl color={color} label="Line colour" onChange={(c) => onColor(c.color)} />
      {onClear ? (
        <Button size="s" variant="quiet" onClick={onClear}>
          Clear drawings
        </Button>
      ) : null}
    </div>
  );
}

function drawLit(
  at: { layer: LevelsLayer; up: string; down: string },
  lit: { leg: PlanLeg; price: number } | null,
): void {
  at.layer.setLevels(
    lit
      ? [
          {
            id: 'lit',
            price: lit.price,
            label: '',
            labelMode: 'none',
            color: lit.leg === 'stop' ? at.down : at.up,
            style: 'solid',
            distance: false,
          },
        ]
      : [],
  );
}
