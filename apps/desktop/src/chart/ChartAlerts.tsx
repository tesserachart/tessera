import type { ChartApi } from '@tessera/chart';
import type { Alert } from '@tessera/protocol';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Icon,
  Tooltip,
  cx,
  formatPrice,
  PRICE_TEXT,
} from '@tessera/ui';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { deleteAlert, moveAlert, pauseAlert } from '../alerts/actions.ts';
import { editAlert } from '../alerts/formStore.ts';
import { draggable, markPrice, markersOn, useAlerts } from '../alerts/store.ts';
import { priceWords } from '../alerts/words.ts';
import { noteOnChart } from './chartNotice.ts';
import { SETTLE_MS } from '../app/settle.ts';
import { revealTile } from '../workspace/dock/open.ts';

const MARK_H = 18;
const CLICK_PX = 3;

function useCoords(chart: ChartApi | null) {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!chart) return;
    let key = '';
    const check = () => {
      const c = chart.coords();
      const k = [c.plot.y, c.plot.h, c.plot.w, c.priceAxis.x, c.yOfPrice(0), c.yOfPrice(1)].map((v) => v.toFixed(2));
      if (k.join('|') !== key) {
        key = k.join('|');
        setVersion((v) => v + 1);
      }
    };
    check();
    const offFrame = chart.on('frame', check);
    const offView = chart.on('viewport', check);
    return () => {
      offFrame();
      offView();
    };
  }, [chart]);
  return chart?.coords() ?? null;
}

interface Drag {
  id: string;
  startY: number;
  price: number;
  moved: boolean;
  sending: boolean;
  settleUntil?: number;
}

export function ChartAlerts({
  chart,
  ids,
  decimals,
  tick,
  target,
}: {
  chart: ChartApi | null;
  ids: ReadonlySet<string>;
  decimals: number;
  tick: number;
  target: { layoutId: string; tileId: string };
}) {
  const coords = useCoords(chart);
  const alerts = useAlerts((s) => s.alerts);
  const notes = useAlerts((s) => s.notes);
  const [held, setDrag] = useState<Drag | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const hostRef = useRef<HTMLDivElement>(null);
  const marks = markersOn(alerts, ids);
  const settling = held?.settleUntil !== undefined ? held : null;
  const settled = settling ? alerts?.get(settling.id) : undefined;
  const at = settled ? markPrice(settled) : null;
  const caughtUp = settling !== null && at !== null && Math.abs(at - settling.price) < tick / 2;
  const drag = caughtUp ? null : held;
  useEffect(() => {
    if (!settling) return;
    const wait = caughtUp ? 0 : Math.max(0, (settling.settleUntil ?? 0) - Date.now());
    const t = setTimeout(() => setDrag((cur) => (cur === settling ? null : cur)), wait);
    return () => clearTimeout(t);
  }, [settling, caughtUp]);
  const fired = notes.filter((n) => ids.has(n.fire.instrument) && n.until > now).map((n) => n.fire);
  const next = Math.min(...notes.filter((n) => n.until > now).map((n) => n.until));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [next]);

  if (!coords || !chart) return null;
  const { plot, priceAxis } = coords;
  const inside = (y: number) => y >= plot.y && y <= plot.y + plot.h;
  const snap = (p: number) => Math.round(p / tick) * tick;

  const down = (a: Alert, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: a.id, startY: e.clientY, price: markPrice(a) ?? 0, moved: false, sending: false });
  };
  const move = (a: Alert, e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag?.id !== a.id || drag.sending) return;
    const moved = drag.moved || Math.abs(e.clientY - drag.startY) >= CLICK_PX;
    if (!moved || !draggable(a)) return;
    const r = hostRef.current?.getBoundingClientRect();
    if (!r) return;
    setDrag({ ...drag, moved, price: snap(coords.priceOfY(e.clientY - r.top)) });
  };
  const up = (a: Alert, e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag?.id !== a.id) return;
    if (!drag.moved) {
      setDrag(null);
      editAlert(a, { decimals, tick }, { x: e.clientX, y: e.clientY });
      return;
    }
    if (!draggable(a) || drag.price === markPrice(a)) {
      setDrag(null);
      return;
    }
    const sending = { ...drag, sending: true };
    setDrag(sending);
    void moveAlert(a.id, Number(drag.price.toFixed(decimals))).then((why) => {
      if (why) noteOnChart(target, { tone: 'err', text: why });
      const next = why ? null : { ...sending, settleUntil: Date.now() + SETTLE_MS };
      setDrag((cur) => (cur === sending ? next : cur));
    });
  };

  const said = (go: Promise<string | null>) =>
    void go.then((why) => {
      if (why) noteOnChart(target, { tone: 'err', text: why });
    });

  return (
    <div className="al-layer" ref={hostRef} aria-label="Alerts on the chart">
      {marks.map((a) => {
        const moving = drag?.id === a.id && drag.moved;
        const price = moving ? drag.price : (markPrice(a) ?? 0);
        const y = coords.yOfPrice(price);
        if (!inside(y)) return null;
        return (
          <div key={a.id} className={cx('al-mark', a.status === 'paused' && 'is-paused', moving && 'is-moving')}>
            <div className="al-line" style={{ left: plot.x, top: Math.round(y), width: plot.w }} />
            <ContextMenu>
              <Tooltip content={`${a.title}${a.message ? ` · ${a.message}` : ''}`} side="left">
                <ContextMenuTrigger asChild>
                  <div
                    className={cx('al-tag', draggable(a) && 'is-drag')}
                    style={{ left: priceAxis.x, top: y - MARK_H / 2, width: priceAxis.w }}
                    role="button"
                    tabIndex={-1}
                    aria-label={`Alert: ${a.title}`}
                    onPointerDown={(e) => down(a, e)}
                    onPointerMove={(e) => move(a, e)}
                    onPointerUp={(e) => up(a, e)}
                    onPointerCancel={() => setDrag(null)}
                    onContextMenu={(e) => e.stopPropagation()}
                  >
                    <Icon name="alert" />
                    <span className={PRICE_TEXT}>{formatPrice(price, decimals)}</span>
                  </div>
                </ContextMenuTrigger>
              </Tooltip>
              <ContextMenuContent aria-label={`Alert: ${a.title}`}>
                <ContextMenuItem
                  onSelect={() => {
                    const box = hostRef.current?.getBoundingClientRect();
                    editAlert(
                      a,
                      { decimals, tick },
                      box ? { x: box.left + priceAxis.x, y: box.top + y + MARK_H / 2 } : null,
                    );
                  }}
                >
                  Edit…
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => said(pauseAlert(a.id, a.status === 'active'))}>
                  {a.status === 'active' ? 'Pause' : 'Resume'}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void revealTile('alerts', { via: 'pointer', focus: true })}>
                  All alerts
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem destructive onSelect={() => said(deleteAlert(a.id))}>
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        );
      })}
      {fired.map((f) => {
        const at = f.target ?? f.price;
        const y = coords.yOfPrice(at);
        if (!inside(y)) return null;
        return (
          <div
            key={f.id}
            className="al-fired"
            style={{ right: `calc(100% - ${String(plot.x + plot.w - 8)}px)`, top: y }}
          >
            Fired · {priceWords(f.price, decimals)}
          </div>
        );
      })}
    </div>
  );
}
