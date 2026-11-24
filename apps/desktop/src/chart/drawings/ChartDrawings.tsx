import {
  AnnotationLayer,
  LegendLayer,
  picksProfile,
  VolumeProfileLayer,
  type ChartApi,
  type DrawingEvent,
} from '@tessera/chart';
import type { Drawing } from '@tessera/protocol';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { layoutsStore, useLayouts } from '../../state/layouts.ts';
import { useChartTheme } from '../chartTheme.ts';
import { afterOpenerTakesFocus } from '../focus.ts';
import { colorOf } from '../indicators.ts';
import { indicatorLayerId } from '../layers/indicators.ts';
import { placedInputs, placeProfile } from '../profilePlacement.ts';
import { isPlacedProfile, selectProfile, useSelectedProfile } from '../profileStudy.ts';
import { ProfileStudyBar } from '../ProfileStudyBar.tsx';
import type { ChartRef } from '../settings/store.ts';
import { addDrawing, moveDrawing, relabelDrawing, removeDrawing, updateDrawing } from './actions.ts';
import { DrawingStyleBar } from './DrawingStyleBar.tsx';
import { inAnalystColour, labelOf, toSpec } from './model.ts';
import { styleBarAt, type Box } from './place.ts';
import { drawingStore, editNote, onChart, selectDrawing, setTool, useDrawingUi, type NoteEdit } from './store.ts';
import { read } from '../../app/store.ts';

function layerOf(chart: ChartApi | null): AnnotationLayer | null {
  return chart?.getLayer('annotations', AnnotationLayer) ?? null;
}

function placedBoxOf(chart: ChartApi | null, layerId: string): Box | null {
  return chart?.getLayer(indicatorLayerId(layerId), VolumeProfileLayer)?.placedBox() ?? null;
}

function legendBlock(chart: ChartApi, host: HTMLElement | null): Box | null {
  const canvas = chart.getLayer('legend', LegendLayer)?.extent ?? null;
  const rows = host?.querySelector<HTMLElement>('.ind-legend-pane[data-pane="main"]');
  let dom: Box | null = null;
  if (host && rows && rows.style.visibility !== 'hidden') {
    const r = rows.getBoundingClientRect();
    const c = host.getBoundingClientRect();
    const x = r.left - c.left - host.clientLeft;
    const y = r.top - c.top - host.clientTop;
    if (r.width > 0 && r.height > 0) dom = { x, y, w: r.width, h: r.height };
  }
  if (!canvas || !dom) return canvas ?? dom;
  const x = Math.min(canvas.x, dom.x);
  const y = Math.min(canvas.y, dom.y);
  return {
    x,
    y,
    w: Math.max(canvas.x + canvas.w, dom.x + dom.w) - x,
    h: Math.max(canvas.y + canvas.h, dom.y + dom.h) - y,
  };
}

function NoteEditor({
  at,
  initial,
  color,
  centred = false,
  face,
  placeholder = 'Note',
  onDone,
}: {
  at: { x: number; y: number };
  initial: string;
  color: string;
  centred?: boolean;
  face?: { size: number; bold: boolean; italic: boolean };
  placeholder?: string;
  onDone: (text: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  useEffect(
    () =>
      afterOpenerTakesFocus(() => {
        const el = field.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
      }),
    [],
  );
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  const lines = Math.max(1, text.split('\n').length);
  return (
    <textarea
      ref={field}
      className={centred ? 'dt-note is-label' : 'dt-note'}
      aria-label={placeholder}
      placeholder={placeholder}
      rows={lines}
      spellCheck={false}
      value={text}
      style={{
        transform: `translate(${String(Math.round(at.x))}px, ${String(Math.round(at.y))}px)${centred ? ' translate(-50%, -50%)' : ''}`,
        color,
        ...(face
          ? {
              fontSize: face.size,
              lineHeight: `${String(Math.round(face.size * 1.3))}px`,
              fontWeight: face.bold ? 700 : 500,
              fontStyle: face.italic ? 'italic' : 'normal',
            }
          : {}),
      }}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        if (focused.current) finish(text);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          finish(text);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
    />
  );
}

export function ChartDrawings({
  chart,
  layoutId,
  tileId,
  instrument,
  drawings,
}: {
  chart: ChartApi | null;
  layoutId: string;
  tileId: string;
  instrument: string;
  drawings: readonly Drawing[];
}) {
  const ref = useMemo<ChartRef>(() => ({ layoutId, tileId }), [layoutId, tileId]);
  const layer = layerOf(chart);
  const tool = useDrawingUi((s) => s.tool);
  const magnet = useDrawingUi((s) => s.magnet);
  const selectedRef = useDrawingUi((s) => s.selected);
  const note = useDrawingUi((s) => s.note);
  const selectedId = onChart(selectedRef, ref) ? selectedRef!.id : null;
  const selected = selectedId ? (drawings.find((d) => d.id === selectedId) ?? null) : null;
  const tf = useLayouts((s) => s.layouts[layoutId]?.charts[tileId]?.timeframe ?? null);
  const layers = useLayouts((s) => s.layouts[layoutId]?.charts[tileId]?.layers);
  const profileId = useSelectedProfile(ref);
  const profileLayer = layers?.find((l) => l.id === profileId);
  const placedProfile = isPlacedProfile(profileLayer) ? profileLayer : null;
  const profileBarRef = useRef<HTMLDivElement>(null);
  const swatches = useChartTheme((s) => s.swatches);
  const specs = useMemo(() => drawings.map((d) => toSpec(d, swatches)), [drawings, swatches]);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    layer?.setDrawings(specs);
  }, [layer, specs]);
  useEffect(() => {
    layer?.setDrawingTool(tool);
  }, [layer, tool]);
  useEffect(() => {
    layer?.setMagnet(magnet);
  }, [layer, magnet]);
  useEffect(() => {
    if (!layer || !tool) return;
    const last = picksProfile(tool) ? undefined : read(drawingStore).styleByKind[tool];
    layer.setNewDrawingStyle({
      color: colorOf(last?.color ?? 'mist'),
      width: last?.width ?? 1,
      dash: last?.line ?? 'solid',
    });
  }, [layer, tool]);
  useEffect(() => {
    layer?.selectDrawing(selectedId);
  }, [layer, selectedId]);

  const onEvent = useCallback(
    (e: DrawingEvent) => {
      const st = read(drawingStore);
      switch (e.type) {
        case 'create': {
          const keep = st.sticky;
          if (!keep) setTool(null);
          if (e.kind === 'text') {
            editNote({ ...ref, id: null, point: e.points[0]! });
            return;
          }
          if (picksProfile(e.kind)) {
            const inputs = placedInputs(e.kind, e.points, chart?.getSeries() ?? null, tf);
            if (inputs)
              placeProfile(ref, inputs, (layerId) => {
                if (!keep) selectProfile({ ...ref, layerId });
              });
            return;
          }
          const id = addDrawing(ref, e.kind, e.points, instrument);
          if (!keep) selectDrawing({ ...ref, id });
          return;
        }
        case 'move':
          moveDrawing(ref, e.id, e.points);
          return;
        case 'remove':
          removeDrawing(ref, e.id);
          return;
        case 'select':
          if (e.id) {
            selectProfile(null);
            selectDrawing({ ...ref, id: e.id });
          } else if (onChart(st.selected, ref)) selectDrawing(null);
          return;
        case 'cancel':
          setTool(null);
          return;
        case 'edit-text':
          selectDrawing({ ...ref, id: e.id });
          editNote({ ...ref, id: e.id });
          return;
      }
    },
    [ref, instrument, tf, chart],
  );
  useEffect(() => {
    const l = layerOf(chart);
    if (!l) return;
    l.onDrawing = onEvent;
    return () => {
      if (l.onDrawing === onEvent) l.onDrawing = null;
    };
  }, [chart, onEvent]);

  useEffect(() => {
    if (!chart) return;
    return chart.on('click', (e) => {
      if (read(drawingStore).tool) return;
      const all = read(layoutsStore).layouts[layoutId]?.charts[tileId]?.layers ?? [];
      const hit = all.find((l) => {
        if (!isPlacedProfile(l)) return false;
        const b = placedBoxOf(chart, l.id);
        return b !== null && e.x >= b.x && e.x <= b.x + b.w && e.y >= b.y && e.y <= b.y + b.h;
      });
      if (hit) {
        selectDrawing(null);
        selectProfile({ ...ref, layerId: hit.id });
      } else selectProfile(null);
    });
  }, [chart, ref, layoutId, tileId]);

  const placeProfileBar = useCallback(() => {
    const el = profileBarRef.current;
    if (!el || !chart || !placedProfile) return;
    const box = placedBoxOf(chart, placedProfile.id);
    if (!box) {
      el.style.visibility = 'hidden';
      return;
    }
    const legend = legendBlock(chart, el.offsetParent instanceof HTMLElement ? el.offsetParent : null);
    const { x, y } = styleBarAt(box, { w: el.offsetWidth, h: el.offsetHeight }, chart.coords().plot, legend);
    el.style.transform = `translate(${String(Math.round(x))}px, ${String(Math.round(y))}px)`;
    el.style.visibility = 'inherit';
  }, [chart, placedProfile]);

  useLayoutEffect(() => {
    placeProfileBar();
  });
  useEffect(() => {
    if (!chart) return;
    return chart.on('frame', placeProfileBar);
  }, [chart, placeProfileBar]);

  const place = useCallback(() => {
    const el = barRef.current;
    if (!el || !chart || !layer || !selectedId) return;
    const box = layer.drawingBox(selectedId);
    if (!box || layer.drawingBusy) {
      el.style.visibility = 'hidden';
      return;
    }
    const legend = legendBlock(chart, el.offsetParent instanceof HTMLElement ? el.offsetParent : null);
    const { x, y } = styleBarAt(box, { w: el.offsetWidth, h: el.offsetHeight }, chart.coords().plot, legend);
    el.style.transform = `translate(${String(Math.round(x))}px, ${String(Math.round(y))}px)`;
    el.style.visibility = 'inherit';
  }, [chart, layer, selectedId]);

  useLayoutEffect(() => {
    place();
  });
  useEffect(() => {
    if (!chart) return;
    return chart.on('frame', place);
  }, [chart, place]);

  const myNote: NoteEdit | null = onChart(note, ref) ? note : null;
  const noteDrawing = myNote?.id ? (drawings.find((d) => d.id === myNote.id) ?? null) : null;
  const editLabel = noteDrawing && noteDrawing.kind !== 'text' ? labelOf(noteDrawing) : null;
  let noteAt: { x: number; y: number } | null = null;
  if (myNote && layer) {
    if (myNote.id === null) noteAt = layer.screenOf(myNote.point);
    else if (editLabel) noteAt = layer.drawingLabelAt(myNote.id);
    else {
      const box = layer.drawingBox(myNote.id);
      noteAt = box ? { x: box.x, y: box.y } : null;
    }
  }
  const finishNote = (text: string | null) => {
    const st = read(drawingStore);
    editNote(null);
    if (!myNote || text === null) return;
    if (myNote.id === null) {
      if (text.trim() === '') return;
      const id = addDrawing(ref, 'text', [myNote.point], instrument, { text: text.trimEnd() });
      if (!st.sticky) selectDrawing({ ...ref, id });
    } else if (editLabel) {
      relabelDrawing(ref, myNote.id, { text });
    } else {
      updateDrawing(ref, myNote.id, { text: text.trimEnd() });
    }
  };
  const noteColor =
    editLabel && noteDrawing
      ? editLabel.color
        ? colorOf(editLabel.color)
        : inAnalystColour(noteDrawing)
          ? 'var(--aqua)'
          : colorOf(noteDrawing.style.color)
      : colorOf(noteDrawing?.style.color ?? read(drawingStore).styleByKind.text?.color ?? 'mist');

  return (
    <>
      {selected && !myNote ? <DrawingStyleBar ref={barRef} chart={ref} drawing={selected} /> : null}
      {placedProfile && !selected ? (
        <ProfileStudyBar ref={profileBarRef} target={{ ...ref, layerId: placedProfile.id }} layer={placedProfile} />
      ) : null}
      {myNote && noteAt ? (
        <NoteEditor
          key={myNote.id ?? 'new'}
          at={noteAt}
          initial={editLabel ? editLabel.text : (noteDrawing?.text ?? '')}
          color={noteColor}
          {...(editLabel
            ? {
                centred: true,
                face: { size: editLabel.size, bold: editLabel.bold, italic: editLabel.italic },
                placeholder: 'Text',
              }
            : {})}
          onDone={finishNote}
        />
      ) : null}
    </>
  );
}
