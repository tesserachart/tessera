import { aggressorNoteOf } from '@tessera/chart';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ScrollArea,
  SampleSkeleton,
  Tooltip,
  formatPrice,
  useLoadPending,
} from '@tessera/ui';
import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useClock } from '../../app/clock.ts';
import { useConnection } from '../../app/runtimeContext.ts';
import { markTime, onFocusPrint, onMarkTime } from '../../market/flow/events.ts';
import { flowHub } from '../../market/flow/hub.ts';
import { displaySymbol, useInstrumentSpec } from '../../market/instruments.ts';
import { useClosedNote } from '../../markets/sessions.ts';
import { droppedReader } from '../../orderflow/dom/ladderModel.ts';
import { RowMetrics } from '../../orderflow/rowMetrics.ts';
import { TapeController, type TapeContext } from '../../orderflow/tape/tapeController.ts';
import { TapeSample } from '../../orderflow/tape/TapeSample.tsx';
import {
  DEFAULT_TAPE_PARAMS,
  TapeClock,
  readTapeParams,
  tapeSize,
  tapeWords,
  type TapeParams,
  type TapePill,
  type TapeRow,
} from '../../orderflow/tape/tapeModel.ts';
import { TapeSettings } from '../../orderflow/tape/TapeSettings.tsx';
import { addTapeTile } from '../../orderflow/place.ts';
import { bindTileKeys } from '../../orderflow/tileKeys.ts';
import { useTileSettings } from '../dock/tileSettings.ts';
import { openTileSettings, setTileFacts, useTileFacts } from '../dock/tileSettingsUi.ts';
import { flowTab, flowTitle } from './flowTab.tsx';
import { PinnedRow } from './PinnedRow.tsx';
import { TapeView } from '../../orderflow/tape/tapeView.ts';
import { useFollowedInstrument, useNoChartOpen } from '../../orderflow/tileInstrument.ts';
import { NoChartOpen } from './NoChartOpen.tsx';
import { useShellData } from '../../shell/shellData.ts';
import { askAnalyst } from '../../shell/tradeActions.ts';
import { useTileSight } from './inSight.ts';
import { registerTile, type TileSettingsProps } from './registry.ts';
import { FlowScope } from '../dock/header/Scope.tsx';
import { displayZone, zoneLabel } from '../../state/timeZone.ts';

const clock = new TapeClock();

function rowWords(r: TapeRow, decimals: number): string {
  const side = r.side > 0 ? 'a buy' : r.side < 0 ? 'a sell' : 'a print (side unknown)';
  const [hms, ms] = clock.parts(r.ns);
  const joined = r.prints > 1 ? `, ${String(r.prints)} prints joined` : '';
  const price =
    r.average !== r.price
      ? `${formatPrice(r.price, decimals)} (average ${formatPrice(r.average, decimals)})`
      : formatPrice(r.price, decimals);
  return `${side} of ${tapeSize(r.size)} at ${price} at ${hms}${ms} ${zoneLabel(displayZone())}${joined}`;
}

export function TapeTile({ params, api }: IDockviewPanelProps<Partial<TapeParams>>) {
  const p = readTapeParams(params);
  const runtimeClock = useClock();
  const instrument = useFollowedInstrument(p);
  const noChart = useNoChartOpen(instrument);
  const spec = useInstrumentSpec(instrument);
  const broker = spec?.instrument ?? instrument;
  const symbol = broker ? displaySymbol(broker) : '';
  useEffect(() => {
    api.setTitle(flowTitle(symbol, 'T&S'));
  }, [api, symbol]);
  const { providers } = useShellData();
  const conn = useConnection();
  const dropped = useMemo(() => droppedReader(conn, providers), [conn, providers]);
  const closed = useClosedNote(instrument);
  const decimals = spec?.priceDecimals ?? 2;

  const tileRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<TapeController | null>(null);
  const [pill, setPill] = useState<TapePill | null>(null);
  const [loading, setLoading] = useState(true);
  useLoadPending(loading && !!instrument);
  const [menuRow, setMenuRow] = useState<TapeRow | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tip, setTip] = useState<{ text: string; left: number; top: number; width: number; height: number } | null>(
    null,
  );
  const instrumentRef = useRef(instrument);
  useEffect(() => {
    instrumentRef.current = instrument;
  }, [instrument]);

  const latest: TapeContext = {
    params: p,
    decimals,
    dropped,
    closed,
  };
  const live = useRef(latest);
  useLayoutEffect(() => {
    live.current = latest;
    ctrlRef.current?.invalidate();
  });

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    const content = contentRef.current;
    const tile = tileRef.current;
    if (!vp || !content || !tile) return;
    const metrics = new RowMetrics(content, () => ctrlRef.current?.invalidate());
    const rowHeight = () => metrics.rowH;
    const ctrl = new TapeController(
      new TapeView(vp, content),
      () => live.current,
      {
        pill: setPill,
        loading: setLoading,
        mark: (row) => {
          const win = tileRef.current?.ownerDocument.defaultView;
          markTime(
            row && instrumentRef.current
              ? { instrument: instrumentRef.current, t: row.ns / 1e6, price: row.price }
              : null,
            win ? [win] : [],
          );
        },
        tip: (t) => {
          const box = tileRef.current?.getBoundingClientRect();
          setTip(
            t && box
              ? {
                  text: t.text,
                  left: t.box.left - box.left,
                  top: t.box.top - box.top,
                  width: t.box.width,
                  height: t.box.height,
                }
              : null,
          );
        },
      },
      rowHeight,
      tile,
    );
    ctrlRef.current = ctrl;
    const ro = new ResizeObserver(() => {
      metrics.refresh();
      ctrl.onResized();
    });
    ro.observe(vp);
    const unbind = bindTileKeys('tape', tile, {
      toggle: () => ctrl.toggle(),
      newest: () => void ctrl.resume(),
      paused: () => ctrl.paused,
    });
    return () => {
      unbind();
      ro.disconnect();
      metrics.dispose();
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, []);

  useTileSight(api, (inSight) => ctrlRef.current?.setHidden(!inSight));

  const tickSize = spec?.tickSize ?? null;
  const specDecimals = spec?.priceDecimals ?? null;
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl || !instrument || tickSize === null || specDecimals === null) {
      ctrl?.setFlow(null);
      return;
    }
    const { flow, release } = flowHub(runtimeClock).acquire(instrument, tickSize, specDecimals);
    const off = flow.useTrades();
    ctrl.setFlow(flow);
    const sync = () =>
      setTileFacts(api.id, {
        autoSize: flow.threshold?.size ?? null,
        note: aggressorNoteOf(flow.info.aggressorSource, flow.info.source?.provider ?? null),
      });
    const offT = flow.tradesChanged.on(sync);
    sync();
    return () => {
      offT();
      setTileFacts(api.id, null);
      ctrl.setFlow(null);
      off();
      release();
    };
  }, [runtimeClock, instrument, tickSize, specDecimals, api]);

  useEffect(() => {
    const ids = new Set([instrument, broker].filter((x): x is string => !!x));
    return onFocusPrint((f) => {
      if (ids.has(f.instrument)) ctrlRef.current?.focusPrint(f);
    });
  }, [instrument, broker]);

  useEffect(
    () =>
      onMarkTime((m) => {
        if (!m) ctrlRef.current?.clearMark();
      }),
    [],
  );

  return (
    <div
      ref={tileRef}
      className="tile tape-tile"
      tabIndex={0}
      data-focus-zone="tape"
      aria-label={symbol ? `${symbol} time and sales` : 'Time and sales'}
      onPointerDown={() => tileRef.current?.focus({ preventScroll: true })}
    >
      <ContextMenu
        onOpenChange={(o) => {
          setMenuOpen(o);
          if (o) ctrlRef.current?.menuOpened();
          else {
            ctrlRef.current?.menuClosed();
            setMenuRow(null);
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            className="tape-frame relative"
            onContextMenu={(e) => {
              const ctrl = ctrlRef.current;
              const el = e.target instanceof Element ? e.target.closest<HTMLElement>('.r[data-pos]') : null;
              const pos = el ? Number(el.dataset.pos) : null;
              setMenuRow(ctrl && pos !== null ? ctrl.list.row(pos) : null);
            }}
          >
            <ScrollArea
              className="t-tape"
              viewportRef={viewportRef}
              viewportClassName="t-tape-view"
              data-millis={p.millis ? 'true' : 'false'}
              data-agg={p.aggregate ? 'true' : 'false'}
            >
              <div ref={contentRef} className="t-tape-rows" role="list" aria-label="Prints, newest first" />
            </ScrollArea>
            {noChart ? <NoChartOpen /> : null}
            {loading && instrument ? (
              <SampleSkeleton
                label="Loading prints"
                className="pointer-events-none absolute inset-0 flex flex-col overflow-hidden"
              >
                <TapeSample millis={p.millis} aggregate={p.aggregate} />
              </SampleSkeleton>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label="Time and sales menu">
          {menuRow ? (
            <>
              <ContextMenuItem
                onSelect={() =>
                  instrument &&
                  markTime(
                    { instrument, t: menuRow.ns / 1e6, price: menuRow.price },
                    tileRef.current?.ownerDocument.defaultView ? [tileRef.current.ownerDocument.defaultView] : [],
                  )
                }
              >
                Mark on the chart
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  askAnalyst(
                    `${symbol} time & sales: ${rowWords(menuRow, decimals)}. What does the order flow around it say?`,
                  )
                }
              >
                Ask the analyst about this {p.aggregate ? 'order' : 'print'}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}
          <ContextMenuItem onSelect={() => openTileSettings(api.id)}>Settings…</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pill ? (
        pill.kind === 'note' ? (
          <div className="t-tape-pill" data-kind={pill.kind} role="status">
            {pill.text}
          </div>
        ) : (
          <button
            type="button"
            className="t-tape-pill"
            data-kind={pill.kind}
            onClick={() => ctrlRef.current?.resume()}
            aria-label={`${pill.text}: show the newest`}
          >
            {pill.text}
          </button>
        )
      ) : null}
      {/* Radix gives Esc to the top layer: a tip under an open menu would take the menu's Esc */}
      {tip && !menuOpen ? (
        <Tooltip open content={tip.text} side="left">
          <span
            className="dom-tip-anchor"
            aria-hidden="true"
            style={{ left: tip.left, top: tip.top, width: tip.width, height: tip.height }}
          />
        </Tooltip>
      ) : null}
    </div>
  );
}

function TapeSettingsForm({ panel }: TileSettingsProps) {
  const [params, set] = useTileSettings<TapeParams>(panel.api, DEFAULT_TAPE_PARAMS);
  const autoSize = useTileFacts(panel.id).autoSize ?? null;
  const p = readTapeParams(params);
  return (
    <>
      <PinnedRow instrument={p.instrument} onFollow={() => set({ instrument: undefined })} />
      <TapeSettings params={p} onChange={set} autoSize={autoSize} />
    </>
  );
}

registerTile<Partial<TapeParams>>({
  kind: 'tape',
  title: 'Time & Sales',
  aliases: ['time_and_sales'],
  component: TapeTile,
  home: 'centre',
  icon: 'tape',
  order: 1,
  keywords: ['time and sales', 't&s', 'prints', 'trades', 'order flow', 'scalp'],
  linkable: true,
  tab: flowTab('T&S'),
  scope: FlowScope,
  settings: { component: TapeSettingsForm, summary: (params) => tapeWords(readTapeParams(params)) },
  add: addTapeTile,
});
