import { magnetPrice, type DrawingAxes, type Pt } from './geometry.ts';
import { channelOffset, hitShape, type Handle, type Shape, type ShapeHit, type LabelMetrics } from './shape.ts';
import {
  DRAWING_ANCHORS,
  defaultLevels,
  type DrawingDash,
  type DrawingEvent,
  type PlaceKind,
  type DrawingPoint,
  type DrawingSpec,
  type PointerMods,
  takesWords,
} from './types.ts';

export interface EditorHost {
  shape(d: DrawingSpec, axes: DrawingAxes): Shape | null;
  readonly metrics: LabelMetrics;
  emit(e: DrawingEvent): void;
  invalidate(): void;
}

export interface NewDrawingStyle {
  color: string;
  width: number;
  dash: DrawingDash;
}

const CLICK_SLOP = 4;
const PREVIEW_ID = '__drawing-preview__';

const LINES: ReadonlySet<PlaceKind> = new Set(['trend_line', 'ray', 'extended_line', 'trend_angle']);

export function defaultExtend(kind: PlaceKind): DrawingSpec['extend'] {
  return kind === 'ray' || kind === 'fib_fan' ? 'right' : kind === 'extended_line' ? 'both' : 'none';
}

interface Placing {
  kind: PlaceKind;
  points: DrawingPoint[];
  cursor: DrawingPoint | null;
  down: Pt | null;
}

interface Drag {
  id: string;
  handle: Handle | null;
  x: number;
  y: number;
  orig: readonly DrawingPoint[];
  points: DrawingPoint[];
  moved: boolean;
}

export class DrawingEditor {
  private list: DrawingSpec[] = [];
  private index = new Map<string, DrawingSpec>();
  tool: PlaceKind | null = null;
  magnet = false;
  selected: string | null = null;
  hovered: { id: string; handle: number | null } | null = null;
  newStyle: NewDrawingStyle = { color: '#e8eef3', width: 1, dash: 'solid' };
  private placing: Placing | null = null;
  private drag: Drag | null = null;
  magnetAt: Pt | null = null;

  constructor(private readonly host: EditorHost) {}

  drawings(): readonly DrawingSpec[] {
    const d = this.drag;
    if (!d) return this.list;
    return this.list.map((x) => (x.id === d.id ? { ...x, points: d.points } : x));
  }

  preview(): DrawingSpec | null {
    const p = this.placing;
    if (!p) return null;
    const points = p.cursor ? [...p.points, p.cursor] : p.points;
    if (points.length < 2 && DRAWING_ANCHORS[p.kind] > 1) return null;
    return {
      id: PREVIEW_ID,
      kind: p.kind,
      points,
      color: this.newStyle.color,
      width: this.newStyle.width,
      dash: this.newStyle.dash,
      extend: defaultExtend(p.kind),
      levels: defaultLevels(p.kind),
      text: null,
      locked: false,
      agent: false,
    };
  }

  get isPlacing(): boolean {
    return this.placing !== null;
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  setDrawings(list: readonly DrawingSpec[]): void {
    this.list = [...list];
    this.index = new Map(this.list.map((d) => [d.id, d]));
    if (this.drag && !this.index.has(this.drag.id)) this.drag = null;
    if (this.hovered && !this.index.has(this.hovered.id)) this.hovered = null;
    if (this.selected && !this.index.has(this.selected)) {
      this.selected = null;
      this.host.emit({ type: 'select', id: null });
    }
    this.host.invalidate();
  }

  setTool(kind: PlaceKind | null): void {
    if (kind === this.tool) return;
    this.tool = kind;
    this.placing = null;
    this.magnetAt = null;
    if (kind && this.selected) {
      this.selected = null;
      this.host.emit({ type: 'select', id: null });
    }
    this.host.invalidate();
  }

  select(id: string | null): void {
    if (id === this.selected) return;
    this.selected = id;
    this.host.invalidate();
  }

  hitTest(x: number, y: number, axes: DrawingAxes): ShapeHit | null {
    const list = this.drawings();
    let best: ShapeHit | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = this.host.shape(list[i]!, axes);
      if (!s) continue;
      const h = hitShape(s, x, y, true, this.host.metrics);
      if (h && (!best || h.distance < best.distance)) best = h;
      if (best?.distance === 0) break;
    }
    return best;
  }

  private pointAt(x: number, y: number, mods: PointerMods, axes: DrawingAxes): DrawingPoint {
    const t = axes.timeOfX(x);
    const magnet = this.magnet !== (mods.cmdOrCtrl === true);
    const bar = magnet ? axes.barAt(x) : null;
    const price = bar ? magnetPrice(y, bar, (p) => axes.yOfPrice(p)) : axes.priceOfY(y);
    return { t, price };
  }

  private placingPoint(x: number, y: number, mods: PointerMods, axes: DrawingAxes): DrawingPoint {
    const p = this.pointAt(x, y, mods, axes);
    const first = this.placing?.points[0];
    if (mods.shift && first && this.placing && LINES.has(this.placing.kind) && this.placing.points.length === 1)
      return { t: p.t, price: first.price };
    return p;
  }

  private trackMagnet(p: DrawingPoint, mods: PointerMods, axes: DrawingAxes): void {
    const on = this.magnet !== (mods.cmdOrCtrl === true);
    this.magnetAt = on ? { x: axes.xOfTime(p.t), y: axes.yOfPrice(p.price) } : null;
  }

  down(x: number, y: number, mods: PointerMods, axes: DrawingAxes): boolean {
    if (!axes.ready) return false;
    if (this.tool) {
      const p = this.placingPoint(x, y, mods, axes);
      if (!this.placing) {
        this.placing = { kind: this.tool, points: [p], cursor: null, down: { x, y } };
      } else {
        this.placing.points.push(p);
        this.placing.down = null;
      }
      this.finishIfComplete();
      this.host.invalidate();
      return true;
    }
    const hit = this.hitTest(x, y, axes);
    if (!hit) {
      if (this.selected) {
        this.selected = null;
        this.host.emit({ type: 'select', id: null });
        this.host.invalidate();
      }
      return false;
    }
    if (this.selected !== hit.id) {
      this.selected = hit.id;
      this.host.emit({ type: 'select', id: hit.id });
    }
    const d = this.index.get(hit.id);
    if (d && !d.locked) {
      const shape = this.host.shape(d, axes);
      this.drag = {
        id: d.id,
        handle: hit.handle !== null && shape ? (shape.handles[hit.handle] ?? null) : null,
        x,
        y,
        orig: d.points,
        points: d.points.map((p) => ({ ...p })),
        moved: false,
      };
    }
    this.host.invalidate();
    return true;
  }

  move(x: number, y: number, mods: PointerMods, axes: DrawingAxes): void {
    if (this.placing) {
      this.placing.cursor = this.placingPoint(x, y, mods, axes);
      this.trackMagnet(this.placing.cursor, mods, axes);
      this.host.invalidate();
      return;
    }
    const d = this.drag;
    const spec = d ? this.index.get(d.id) : undefined;
    if (!d || !spec) return;
    if (Math.abs(x - d.x) + Math.abs(y - d.y) > 2) d.moved = true;
    if (!d.moved) return;
    d.points = d.handle
      ? this.dragHandle(spec, d, x, y, mods, axes)
      : this.dragWhole(spec, d.orig, x - d.x, y - d.y, d.y, axes);
    this.host.invalidate();
  }

  up(x: number, y: number, mods: PointerMods, axes: DrawingAxes): void {
    const p = this.placing;
    if (p) {
      if (p.down && p.points.length === 1 && Math.hypot(x - p.down.x, y - p.down.y) > CLICK_SLOP) {
        p.points.push(this.placingPoint(x, y, mods, axes));
        p.down = null;
        this.finishIfComplete();
      }
      this.host.invalidate();
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.moved) {
      this.list = this.list.map((x) => (x.id === d.id ? { ...x, points: d.points } : x));
      this.index = new Map(this.list.map((x) => [x.id, x]));
      this.host.emit({ type: 'move', id: d.id, points: d.points });
    }
    this.host.invalidate();
  }

  hover(x: number, y: number, mods: PointerMods, axes: DrawingAxes): void {
    if (this.placing) {
      this.placing.cursor = this.placingPoint(x, y, mods, axes);
      this.trackMagnet(this.placing.cursor, mods, axes);
      this.host.invalidate();
      return;
    }
    if (this.tool) {
      const p = this.pointAt(x, y, mods, axes);
      this.trackMagnet(p, mods, axes);
      if (this.hovered) this.hovered = null;
      this.host.invalidate();
      return;
    }
    const hit = this.hitTest(x, y, axes);
    const next = hit ? { id: hit.id, handle: hit.handle } : null;
    if (next?.id !== this.hovered?.id || next?.handle !== this.hovered?.handle) {
      this.hovered = next;
      this.host.invalidate();
    }
  }

  leave(): void {
    let changed = false;
    if (this.hovered) {
      this.hovered = null;
      changed = true;
    }
    if (this.placing?.cursor) {
      this.placing.cursor = null;
      changed = true;
    }
    if (this.magnetAt) {
      this.magnetAt = null;
      changed = true;
    }
    if (changed) this.host.invalidate();
  }

  doubleClick(x: number, y: number, axes: DrawingAxes): boolean {
    if (this.tool) return true;
    const hit = this.hitTest(x, y, axes);
    if (!hit) return false;
    const d = this.index.get(hit.id);
    if (d && (d.kind === 'text' || takesWords(d.kind))) {
      if (this.selected !== d.id) {
        this.selected = d.id;
        this.host.emit({ type: 'select', id: d.id });
      }
      this.host.emit({ type: 'edit-text', id: d.id });
    }
    return true;
  }

  key(key: string): boolean {
    if (key === 'Escape') {
      if (this.placing) {
        this.placing = null;
        this.magnetAt = null;
        this.host.invalidate();
        return true;
      }
      if (this.drag) {
        this.drag = null;
        this.host.invalidate();
        return true;
      }
      if (this.tool) {
        this.host.emit({ type: 'cancel' });
        return true;
      }
      if (this.selected) {
        this.selected = null;
        this.host.emit({ type: 'select', id: null });
        this.host.invalidate();
        return true;
      }
      return false;
    }
    if ((key === 'Delete' || key === 'Backspace') && this.selected && !this.placing) {
      const id = this.selected;
      this.drag = null;
      this.host.emit({ type: 'remove', id });
      return true;
    }
    return false;
  }

  cursor(x: number, y: number, axes: DrawingAxes): string | null {
    if (this.drag?.moved) return 'grabbing';
    if (this.tool || this.placing) return 'crosshair';
    const hit = this.hitTest(x, y, axes);
    if (!hit) return null;
    const d = this.index.get(hit.id);
    if (d?.locked) return 'pointer';
    return hit.handle !== null ? 'move' : 'grab';
  }

  private finishIfComplete(): void {
    const p = this.placing;
    if (!p || p.points.length < DRAWING_ANCHORS[p.kind]) return;
    this.placing = null;
    this.magnetAt = null;
    this.host.emit({ type: 'create', kind: p.kind, points: p.points });
  }

  private dragHandle(
    spec: DrawingSpec,
    d: Drag,
    x: number,
    y: number,
    mods: PointerMods,
    axes: DrawingAxes,
  ): DrawingPoint[] {
    const h = d.handle!;
    const q = this.pointAt(x, y, mods, axes);
    const pts = d.orig.map((p) => ({ ...p }));
    if (h.offset) {
      pts[2] = { t: d.orig[h.t]!.t, price: q.price };
      return pts;
    }
    if (spec.kind !== 'horizontal_line') pts[h.t]!.t = q.t;
    if (spec.kind !== 'vertical_line') pts[h.p]!.price = q.price;
    if (spec.kind === 'parallel_channel' && pts[2]) {
      const off = channelOffset(d.orig, axes);
      const xa = axes.xOfTime(pts[0]!.t);
      const xb = axes.xOfTime(pts[1]!.t);
      const xc = axes.xOfTime(pts[2].t);
      const base =
        xb === xa ? pts[0]!.price : pts[0]!.price + ((pts[1]!.price - pts[0]!.price) * (xc - xa)) / (xb - xa);
      pts[2] = { t: pts[2].t, price: base + off };
    }
    return pts;
  }

  private dragWhole(
    spec: DrawingSpec,
    orig: readonly DrawingPoint[],
    dx: number,
    dy: number,
    y0: number,
    axes: DrawingAxes,
  ): DrawingPoint[] {
    const bars = Math.round(dx / axes.barSpacing);
    const dPrice = axes.priceOfY(y0 + dy) - axes.priceOfY(y0);
    return orig.map((p) => ({
      t:
        spec.kind === 'horizontal_line' || !Number.isFinite(p.t) || bars === 0
          ? p.t
          : axes.timeOfX(axes.xOfTime(p.t) + bars * axes.barSpacing),
      price: spec.kind === 'vertical_line' || !Number.isFinite(p.price) ? p.price : p.price + dPrice,
    }));
  }
}
