import type { PlaceKind } from '@tessera/chart';
import { ICON_BUTTON, ICON_BUTTON_ON, Icon, Menu, MenuContent, MenuItem, MenuTrigger, Tooltip, cx } from '@tessera/ui';
import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { ChartApi } from '@tessera/chart';
import type { ChartRef } from '../settings/store.ts';
import { removeAllDrawings } from './actions.ts';
import { TOOL_GROUPS, toolOf, type ToolGroup } from './model.ts';
import { drawingStore, groupTool, setCollapsed, setMagnet, setTool, useDrawingUi } from './store.ts';
import { read } from '../../app/store.ts';

const LONG_PRESS_MS = 350;

function GroupButton({ group }: { group: ToolGroup }) {
  const tool = useDrawingUi((s) => s.tool);
  const sticky = useDrawingUi((s) => s.sticky);
  const last = useDrawingUi((s) => groupTool(s.lastInGroup, group.id));
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const opened = useRef(false);
  const active = tool !== null && group.kinds.includes(tool);
  const kind = active ? tool : last;
  const def = toolOf(kind);
  const more = group.kinds.length > 1;
  const pick = (k: PlaceKind, keep: boolean) => setTool(k, keep);
  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    opened.current = false;
    if (!more || e.button !== 0) return;
    timer.current = window.setTimeout(() => {
      opened.current = true;
      setOpen(true);
    }, LONG_PRESS_MS);
  };
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    clearTimer();
    if (opened.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (more && e.detail <= 1 && e.clientX > r.right - 9 && e.clientY > r.bottom - 9) {
      setOpen(true);
      return;
    }
    if (e.detail >= 2) pick(kind, true);
    else if (active && tool === kind) setTool(null);
    else pick(kind, false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (more && e.key === 'ArrowRight') {
      e.preventDefault();
      setOpen(true);
    }
  };
  const label = active && sticky ? `${def.label}, kept for drawing` : def.label;
  return (
    <div className="dt-group">
      <Tooltip content={label} shortcut={def.shortcut} side="right">
        <button
          type="button"
          className={cx(
            ICON_BUTTON,
            'dt-tool',
            active && cx(ICON_BUTTON_ON, 'is-on'),
            active && sticky && 'is-sticky',
            more && 'has-more',
          )}
          aria-label={def.label}
          aria-pressed={active}
          aria-haspopup={more ? 'menu' : undefined}
          onPointerDown={onPointerDown}
          onPointerUp={clearTimer}
          onPointerLeave={clearTimer}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            if (!more) return;
            e.preventDefault();
            setOpen(true);
          }}
        >
          <Icon name={def.icon} className="text-inherit" />
        </button>
      </Tooltip>
      {more ? (
        <Menu open={open} onOpenChange={setOpen} modal={false}>
          <MenuTrigger asChild>
            <span className="dt-anchor" aria-hidden="true" tabIndex={-1} />
          </MenuTrigger>
          <MenuContent side="right" align="start" sideOffset={2} className="dt-menu" aria-label={group.label}>
            {group.kinds.map((k) => {
              const t = toolOf(k);
              return (
                <MenuItem
                  key={k}
                  shortcut={t.shortcut}
                  current={k === kind}
                  icon={t.icon}
                  onSelect={() => pick(k, false)}
                >
                  {t.label}
                </MenuItem>
              );
            })}
          </MenuContent>
        </Menu>
      ) : null}
    </div>
  );
}

const CANVAS_ROW = 21;
const RAIL_TOP_MIN = 26 + CANVAS_ROW;
const RAIL_GAP = 6;

const RAIL_ROOM = 360;
const RAIL_MIN_H = 96;

function useRailTop(
  rail: RefObject<HTMLElement | null>,
  live: boolean,
  api: ChartApi | null,
): { top: number; height: number | null; tight: boolean } {
  const [top, setTop] = useState(RAIL_TOP_MIN);
  const [height, setHeight] = useState<number | null>(null);
  const [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    const canvas = rail.current?.closest<HTMLElement>('.chart-canvas');
    if (!live || !canvas) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const pane = canvas.querySelector<HTMLElement>('.ind-legend-pane[data-pane="main"]');
      const c = canvas.getBoundingClientRect();
      const bottom = pane ? pane.getBoundingClientRect().bottom - c.top : 0;
      const next = Math.round(Math.max(RAIL_TOP_MIN, bottom + CANVAS_ROW) + RAIL_GAP);
      const plot = api?.coords().plot;
      const foot = plot && plot.h > 0 ? plot.y + plot.h : c.height;
      const room = Math.round(foot - next - RAIL_GAP);
      setTop(next);
      setHeight(Math.max(RAIL_MIN_H, room));
      setTight(room < RAIL_ROOM);
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(soon);
    ro.observe(canvas);
    const mo = new MutationObserver(soon);
    mo.observe(canvas, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
    };
  }, [rail, live, api]);
  return { top, height, tight };
}

function useClearBehind(chrome: RefObject<HTMLElement | null>, api: ChartApi | null, collapsed: boolean): void {
  useLayoutEffect(() => {
    const el = chrome.current;
    const canvas = el?.closest<HTMLElement>('.chart-canvas');
    if (!api || !el || !canvas) return;
    const right = el.getBoundingClientRect().right - canvas.getBoundingClientRect().left;
    api.setOptions({ clearLeft: Math.ceil(right) + RAIL_GAP });
    return () => api.setOptions({ clearLeft: 0 });
  }, [chrome, api, collapsed]);
}

export function DrawingToolbar({
  chart,
  api,
  instrument,
  count,
}: {
  chart: ChartRef;
  api: ChartApi | null;
  instrument: string;
  count: number;
}) {
  const tool = useDrawingUi((s) => s.tool);
  const magnet = useDrawingUi((s) => s.magnet);
  const collapsed = useDrawingUi((s) => s.collapsed);
  const rail = useRef<HTMLDivElement>(null);
  const reveal = useRef<HTMLButtonElement>(null);
  const { top, height, tight } = useRailTop(rail, !collapsed, api);
  useClearBehind(collapsed ? reveal : rail, api, collapsed);
  if (collapsed) {
    return (
      <Tooltip content="Show drawing tools" side="right">
        <button
          ref={reveal}
          type="button"
          className="dt-reveal"
          aria-label="Show drawing tools"
          onClick={() => setCollapsed(false)}
        >
          <Icon name="chevron-right" />
        </button>
      </Tooltip>
    );
  }
  return (
    <div
      ref={rail}
      className={cx('dt-rail', tight && 'is-tight')}
      style={{ top, maxHeight: height ?? `calc(100% - ${String(top + RAIL_GAP)}px)` }}
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="vertical"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && read(drawingStore).tool) {
          e.stopPropagation();
          setTool(null);
        }
      }}
    >
      <Tooltip content="Pointer" shortcut="escape" side="right">
        <button
          type="button"
          className={cx(ICON_BUTTON, 'dt-tool', tool === null && cx(ICON_BUTTON_ON, 'is-on'))}
          aria-label="Pointer"
          aria-pressed={tool === null}
          onClick={() => setTool(null)}
        >
          <Icon name="crosshair" className="text-inherit" />
        </button>
      </Tooltip>
      <span className="dt-sep" />
      {TOOL_GROUPS.map((g) => (
        <GroupButton key={g.id} group={g} />
      ))}
      <span className="dt-sep" />
      <Tooltip content="Magnet" side="right">
        <button
          type="button"
          className={cx(ICON_BUTTON, 'dt-tool', magnet && cx(ICON_BUTTON_ON, 'is-on'))}
          aria-label="Magnet"
          aria-pressed={magnet}
          onClick={() => setMagnet(!magnet)}
        >
          <Icon name="magnet" className="text-inherit" />
        </button>
      </Tooltip>
      <Tooltip
        content={count ? `Remove ${String(count)} drawing${count === 1 ? '' : 's'}` : 'No drawings'}
        side="right"
      >
        <button
          type="button"
          className={cx(ICON_BUTTON, 'dt-tool')}
          aria-label="Remove all drawings"
          disabled={count === 0}
          onClick={() => removeAllDrawings(chart, instrument)}
        >
          <Icon name="trash" className="text-inherit" />
        </button>
      </Tooltip>
      <span className="dt-fill" />
      <Tooltip content="Hide drawing tools" side="right">
        <button
          type="button"
          className={cx(ICON_BUTTON, 'dt-tool')}
          aria-label="Hide drawing tools"
          onClick={() => setCollapsed(true)}
        >
          <Icon name="chevron-left" className="text-inherit" />
        </button>
      </Tooltip>
    </div>
  );
}
