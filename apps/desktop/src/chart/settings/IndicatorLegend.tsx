import { IndicatorLayer, isFlowReadout, LegendLayer, PriceFormatter, type ChartApi } from '@tessera/chart';
import type { ChartLayer, IndicatorSpec } from '@tessera/protocol';
import {
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
  TOKENS,
  Tooltip,
  cx,
} from '@tessera/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { openAlertForm } from '../../alerts/formStore.ts';
import { chartPlotChoices, lineChoices, plotChoices, stackChoices, stackOf } from '../../alerts/seed.ts';
import { displaySymbol, useInstrumentSpec } from '../../market/instruments.ts';
import { layoutsStore } from '../../state/layouts.ts';
import { drawnLineLabels } from '../layers/custom.ts';
import { updateChart } from '../../workspace/controller.ts';
import {
  indicatorName,
  layerSpec,
  indicatorSummary,
  removeLayer,
  resolveIndicator,
  showLayer,
  type IndicatorSettings,
} from '../indicators.ts';
import { problemOf, useCustomCatalog } from '../../indicators/custom.ts';
import { indicatorLayerId } from '../layers/index.ts';
import { legendPanes, rowValues } from './model.ts';
import { firstFit, fitted, squeezed } from './legendFit.ts';
import { StudySettingsDialog } from './StudySettingsDialog.tsx';
import {
  closeIndicatorSettings,
  indicatorUiStore,
  isChart,
  openIndicatorSettings,
  useIndicatorUi,
  type ChartRef,
} from './store.ts';
import { read } from '../../app/store.ts';

const LEGEND_ROW_H = 22;
const MAIN_TOP = 26;
const PANE_TOP = 3;
const OVERLAY_VALUES = 3;
const LEGEND_COMPACT_W = 560;

interface Entry {
  layer: ChartLayer;
  spec: IndicatorSpec;
  settings: IndicatorSettings;
  summary: string;
}

export function IndicatorLegend({
  chart,
  layoutId,
  tileId,
  layers,
  precision,
}: {
  chart: ChartApi | null;
  layoutId: string;
  tileId: string;
  layers: readonly ChartLayer[];
  precision: number;
}) {
  const ref = useMemo(() => ({ layoutId, tileId }), [layoutId, tileId]);
  const custom = useCustomCatalog();
  const entries = useMemo<Entry[]>(
    () =>
      layers.flatMap((layer) => {
        const spec = layerSpec(layer, custom);
        if (!spec) return [];
        const settings = resolveIndicator(spec, layer.params);
        return [{ layer, spec, settings, summary: indicatorSummary(spec, settings.inputs) }];
      }),
    [layers, custom],
  );
  const [panes, setPanes] = useState<readonly string[]>([]);
  const groups = useMemo(() => legendPanes(entries, panes), [entries, panes]);
  const paneEls = useRef(new Map<string, HTMLDivElement>());
  const valueEls = useRef(new Map<string, HTMLSpanElement>());
  const suffixEls = useRef(new Map<string, HTMLSpanElement>());
  const noticeEls = useRef(new Map<string, HTMLSpanElement>());
  const fitKeys = useRef(new WeakMap<HTMLSpanElement, string>());
  const shown = useRef(new Map<string, string>());
  const [marks, setMarks] = useState<ReadonlyMap<string, string>>(new Map());
  const marksRef = useRef<ReadonlyMap<string, string>>(marks);
  const [notes, setNotes] = useState<ReadonlyMap<string, Readonly<Record<string, string>>>>(new Map());
  const notesRef = useRef(new Map<string, string>());
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const readingRef = useRef<ReadonlySet<string>>(reading);
  const crosshair = useRef<number | null>(null);
  const formatter = useMemo(() => new PriceFormatter({ precision, minMove: 10 ** -precision }), [precision]);

  const syncPanes = useCallback(() => {
    if (!chart) return;
    const ids = chart
      .coords()
      .panes.map((p) => p.id)
      .filter((id) => id.startsWith('pane:'));
    setPanes((prev) => (prev.length === ids.length && prev.every((p, k) => p === ids[k]) ? prev : ids));
  }, [chart]);

  const sync = useCallback(() => {
    if (!chart) return;
    const coords = chart.coords();
    for (const [pane, el] of paneEls.current) {
      const rect = pane === 'main' ? coords.plot : coords.panes.find((p) => p.id === pane)?.rect;
      if (!rect) continue;
      const top = rect.y + (pane === 'main' ? MAIN_TOP : PANE_TOP);
      el.style.transform = `translate(0, ${String(top)}px)`;
      el.style.maxWidth = `${String(Math.max(0, rect.w - 16))}px`;
      if (pane === 'main') {
        const compact = rect.w < LEGEND_COMPACT_W;
        if (el.hasAttribute('data-compact') !== compact) el.toggleAttribute('data-compact', compact);
        const room = Math.max(0, coords.priceAxis.x + coords.priceAxis.w - rect.x - 16);
        el.style.setProperty('--lg-room', `${String(room)}px`);
      }
      el.style.visibility = pane === 'main' || rect.h >= LEGEND_ROW_H + PANE_TOP * 2 ? 'inherit' : 'hidden';
    }
    const store = chart.getSeries();
    const down = (i: number) => (store ? store.close[i]! < store.open[i]! : false);
    let nextMarks: Map<string, string> | null = null;
    let nextNotes: Map<string, Readonly<Record<string, string>>> | null = null;
    const nowReading = new Set<string>();
    for (const [id, el] of valueEls.current) {
      const drawn = chart.getLayer(indicatorLayerId(id));
      const layer = layers.find((l) => l.id === id);
      let values: { text: string; color: string }[] = [];
      const problem = layer?.kind === 'custom' ? problemOf(id) : null;
      if (problem && layer?.visible) {
        values = [{ text: problem.message, color: TOKENS.t2 }];
      } else if (drawn instanceof IndicatorLayer && layer?.visible && drawn.reading) {
        nowReading.add(id);
      } else if (drawn instanceof IndicatorLayer && layer?.visible && drawn.length > 0) {
        const at = crosshair.current;
        const i = at !== null && at >= 0 && at < drawn.length ? at : drawn.length - 1;
        const max = drawn.def.placement === 'overlay' ? OVERLAY_VALUES : Infinity;
        values = rowValues(drawn, i, formatter, down, max);
      } else if (isFlowReadout(drawn)) {
        const note = layer?.visible ? drawn.legendNote() : null;
        const n = store?.length ?? 0;
        const at = crosshair.current;
        if (note) values = [{ text: note.text, color: TOKENS.t3 }];
        else if (layer?.visible && drawn.reading()) nowReading.add(id);
        else if (layer?.visible && n > 0)
          values = drawn.legendValues(at !== null && at >= 0 && at < n ? at : n - 1, formatter, chart.theme);
        const sfx = suffixEls.current.get(id);
        const notice = !note && layer?.visible ? (drawn.legendNotice?.() ?? null) : null;
        const base = layer?.visible ? drawn.legendSuffix() : '';
        const row = sfx?.closest<HTMLElement>('.ind-lg-row') ?? null;
        const noticeEl = noticeEls.current.get(id);
        if (sfx && row && noticeEl) {
          const pane = row.parentElement;
          const room = pane ? `${pane.style.maxWidth}|${pane.style.getPropertyValue('--lg-room')}` : '';
          const key = `${base}|${notice?.text ?? ''}|${room}|${String(row.childElementCount)}`;
          if (fitKeys.current.get(sfx) !== key) {
            fitKeys.current.set(sfx, key);
            const apply = (step: number) => {
              const f = fitted(base, notice, step);
              row.toggleAttribute('data-tight', f.tight);
              row.toggleAttribute('data-least', f.least);
              if (sfx.textContent !== f.suffix) sfx.textContent = f.suffix;
              if (noticeEl.textContent !== f.notice) noticeEl.textContent = f.notice;
            };
            apply(
              firstFit((step) => {
                apply(step);
                return !squeezed(row);
              }),
            );
          }
        }
        const options = drawn.optionNotes?.() ?? null;
        const optionsKey = options ? JSON.stringify(options) : '';
        if ((notesRef.current.get(id) ?? '') !== optionsKey) {
          notesRef.current.set(id, optionsKey);
          nextNotes ??= new Map();
          if (options) nextNotes.set(id, options);
        }
        const mark = drawn.aggressorNote() ?? '';
        if ((marksRef.current.get(id) ?? '') !== mark) {
          nextMarks ??= new Map(marksRef.current);
          if (mark) nextMarks.set(id, mark);
          else nextMarks.delete(id);
        }
      }
      const key = values.map((v) => `${v.text}|${v.color}`).join(';');
      if (shown.current.get(id) !== key) {
        shown.current.set(id, key);
        el.replaceChildren(
          ...values.map((v) => {
            const span = document.createElement('span');
            span.textContent = v.text;
            span.style.color = v.color;
            return span;
          }),
        );
      }
    }
    if (nowReading.size !== readingRef.current.size || [...nowReading].some((id) => !readingRef.current.has(id))) {
      readingRef.current = nowReading;
      setReading(nowReading);
    }
    if (nextMarks) {
      marksRef.current = nextMarks;
      setMarks(nextMarks);
    }
    if (nextNotes) {
      const changed = nextNotes;
      setNotes((prev) => {
        const next = new Map(prev);
        for (const id of notesRef.current.keys()) if (!notesRef.current.get(id)) next.delete(id);
        for (const [id, n] of changed) next.set(id, n);
        return next;
      });
    }
  }, [chart, layers, formatter]);

  useLayoutEffect(() => {
    sync();
  });

  useEffect(() => {
    if (!chart) return;
    const offCross = chart.on('crosshair', (e) => {
      crosshair.current = e ? e.index : null;
    });
    const offFrame = chart.on('frame', () => {
      syncPanes();
      sync();
    });
    const first = requestAnimationFrame(syncPanes);
    return () => {
      cancelAnimationFrame(first);
      offCross();
      offFrame();
    };
  }, [chart, sync, syncPanes]);

  const mainRows = groups[0]?.ids.length ?? 0;
  const [mainHeight, setMainHeight] = useState<number | null>(null);
  const mainEl = useRef<HTMLDivElement | null>(null);
  const observeMain = useCallback((el: HTMLDivElement | null) => {
    mainEl.current = el;
    if (!el) setMainHeight(null);
  }, []);
  useEffect(() => {
    const el = mainEl.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setMainHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mainRows]);
  useEffect(() => {
    const legend = chart?.getLayer('legend', LegendLayer);
    if (!chart || !legend) return;
    const reserved = mainRows === 0 ? 0 : (mainHeight ?? mainRows * LEGEND_ROW_H);
    if (legend.reserved === reserved) return;
    legend.reserved = reserved;
    chart.setOptions({});
  }, [chart, mainRows, mainHeight]);

  const editLayers = (fn: (ls: readonly ChartLayer[]) => ChartLayer[]) =>
    void updateChart(layoutId, tileId, (c) => ({ ...c, layers: fn(c.layers) }));
  const byId = new Map(entries.map((e) => [e.layer.id, e]));

  return (
    <div className="ind-legend" aria-label="Indicators">
      {groups.map((g) =>
        g.ids.length === 0 ? null : (
          <div
            key={g.pane}
            className="ind-legend-pane"
            data-pane={g.pane}
            ref={(el) => {
              if (el) paneEls.current.set(g.pane, el);
              else paneEls.current.delete(g.pane);
              if (g.pane === 'main') observeMain(el);
            }}
          >
            {g.ids.map((id) => {
              const e = byId.get(id)!;
              return (
                <LegendRow
                  key={id}
                  chart={ref}
                  entry={e}
                  reading={reading.has(id)}
                  mark={marks.get(id) ?? null}
                  notes={notes.get(id)}
                  suffixRef={(el) => {
                    if (el) suffixEls.current.set(id, el);
                    else suffixEls.current.delete(id);
                  }}
                  noticeRef={(el) => {
                    if (el) noticeEls.current.set(id, el);
                    else noticeEls.current.delete(id);
                  }}
                  valuesRef={(el) => {
                    if (el) valueEls.current.set(id, el);
                    else {
                      valueEls.current.delete(id);
                      shown.current.delete(id);
                    }
                  }}
                  onShow={(visible) => editLayers((ls) => showLayer(ls, id, visible))}
                  onRemove={() => {
                    if (isChart(read(indicatorUiStore).editing, ref)) closeIndicatorSettings();
                    editLayers((ls) => removeLayer(ls, id));
                  }}
                />
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}

function AlertButton({ chart, layer, name }: { chart: ChartRef; layer: ChartLayer; name: string }) {
  const model = read(layoutsStore).layouts[chart.layoutId]?.charts[chart.tileId] ?? null;
  const spec = useInstrumentSpec(model?.instrument ?? null);
  const stacks = stackChoices(layer, spec?.root);
  const own = [...lineChoices(layer, drawnLineLabels(layer.id)), ...plotChoices(layer), ...stacks];
  if (!model || own.length === 0) return null;
  const open = (e: { clientX: number; clientY: number }) => {
    const decimals = spec?.priceDecimals ?? 2;
    const first = own[0]!;
    openAlertForm(
      {
        instrument: model.instrument,
        symbol: displaySymbol(model.instrument),
        interval: model.timeframe,
        decimals,
        tick: spec?.tickSize ?? 10 ** -decimals,
        price: null,
        ...(stacks.length > 0 ? { subject: first, count: stackOf(layer) } : { target: first }),
        more: [...own, ...chartPlotChoices(model.layers, spec?.root)],
      },
      { x: e.clientX, y: e.clientY },
    );
  };
  return (
    <Tooltip content="Alert">
      <button type="button" className="ind-act" aria-label={`Alert on ${name}`} onClick={open}>
        <Icon name="alert" />
      </button>
    </Tooltip>
  );
}

function LegendRow({
  chart,
  entry,
  reading,
  mark,
  notes,
  suffixRef,
  noticeRef,
  valuesRef,
  onShow,
  onRemove,
}: {
  chart: ChartRef;
  entry: Entry;
  reading: boolean;
  mark: string | null;
  notes: Readonly<Record<string, string>> | undefined;
  suffixRef: (el: HTMLSpanElement | null) => void;
  noticeRef: (el: HTMLSpanElement | null) => void;
  valuesRef: (el: HTMLSpanElement | null) => void;
  onShow: (visible: boolean) => void;
  onRemove: () => void;
}) {
  const { layer, spec, settings, summary } = entry;
  const open = useIndicatorUi((s) => isChart(s.editing, chart) && s.editing?.layerId === layer.id);
  const short = indicatorName(spec, settings.inputs);
  const name = summary ? `${short} ${summary}` : short;
  const flow = spec.group === 'order_flow';
  const agent = layer.namespace === 'agent';
  const rowRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const handoff = useRef(false);
  return (
    <>
      <div
        ref={rowRef}
        className={cx(
          'ind-lg-row',
          flow && 'is-flow',
          !layer.visible && 'is-off',
          (open || menuOpen) && 'is-open',
          agent && 'is-agent',
        )}
        data-layer={layer.id}
        onKeyDown={(e) => {
          if (e.key !== 'Backspace' && e.key !== 'Delete') return;
          if (!e.currentTarget.contains(e.target as Node)) return;
          e.preventDefault();
          onRemove();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen(true);
        }}
      >
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button type="button" className="name" aria-label={`${name}: menu`}>
              <span className="short">{short}</span>
              {summary ? <span className="args">{summary}</span> : null}
              {flow ? <span className="args sfx" ref={suffixRef} /> : null}
            </button>
          </MenuTrigger>
          <MenuContent
            align="start"
            onCloseAutoFocus={(e) => {
              if (!handoff.current) return;
              handoff.current = false;
              e.preventDefault();
            }}
          >
            <MenuItem
              onSelect={() => {
                handoff.current = true;
                openIndicatorSettings(chart, layer.id);
              }}
            >
              Settings…
            </MenuItem>
            <MenuItem onSelect={() => onShow(!layer.visible)}>{layer.visible ? 'Hide' : 'Show'}</MenuItem>
            <MenuSeparator />
            <MenuItem destructive onSelect={onRemove}>
              Remove
            </MenuItem>
          </MenuContent>
        </Menu>
        {mark ? (
          <Tooltip content={mark}>
            <span className="ind-lg-mark" aria-label={mark}>
              ≈
            </span>
          </Tooltip>
        ) : null}
        {reading ? <Skeleton w={48} h={10} className="ind-lg-skel" /> : null}
        <span className="vals" ref={valuesRef} aria-live="off" />
        {flow ? <span className="ind-lg-notice" ref={noticeRef} /> : null}
        <span className="acts">
          <AlertButton chart={chart} layer={layer} name={name} />
          <Tooltip content="Settings">
            <button
              type="button"
              className="ind-act"
              aria-label={`${name}: settings`}
              onClick={() => openIndicatorSettings(chart, layer.id)}
            >
              <Icon name="settings" />
            </button>
          </Tooltip>
          <Tooltip content={layer.visible ? 'Hide' : 'Show'}>
            <button
              type="button"
              className="ind-act vis"
              aria-label={`${layer.visible ? 'Hide' : 'Show'} ${name}`}
              aria-pressed={!layer.visible}
              onClick={() => onShow(!layer.visible)}
            >
              <Icon name={layer.visible ? 'shown' : 'hidden'} />
            </button>
          </Tooltip>
          <Tooltip content="Remove">
            <button type="button" className="ind-act" aria-label={`Remove ${name}`} onClick={onRemove}>
              <Icon name="remove" />
            </button>
          </Tooltip>
        </span>
      </div>
      <StudySettingsDialog
        chart={chart}
        layerId={layer.id}
        spec={spec}
        open={open}
        notes={notes}
        onOpenChange={(o) => (o ? openIndicatorSettings(chart, layer.id) : closeIndicatorSettings())}
      />
    </>
  );
}
