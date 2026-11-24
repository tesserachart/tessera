import { DrawingEditor, type NewDrawingStyle } from '../drawings/editor.ts';
import { drawingAxes, type DrawingAxes } from '../drawings/geometry.ts';
import { drawShape, labelFont, lineHeightOf } from '../drawings/render.ts';
import { shapeOf, type LabelMetrics, type Shape } from '../drawings/shape.ts';
import type { DrawingEvent, DrawingPoint, DrawingSpec, PlaceKind } from '../drawings/types.ts';
import { crisp, font, TextMeasurer } from '../render/draw.ts';
import type { Rect } from '../types.ts';
import type { Layer, LayerHost, LayerPointerEvent, RenderContext } from './types.ts';

export interface AnnotationPoint {
  t: number | null;
  price: number | null;
}

export interface AnnotationSpec {
  id: string;
  kind: 'box' | 'arrow' | 'zone' | 'marker' | 'hline' | 'text';
  points: readonly AnnotationPoint[];
  label?: string | null;
  agent: boolean;
}

const HIT_PX = 5;

export class AnnotationLayer implements Layer {
  readonly id: string;
  readonly kind = 'annotation' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = null;
  readonly owner = null;
  private annotations: AnnotationSpec[] = [];
  private host: LayerHost | null = null;
  private readonly measurer = new TextMeasurer();
  private metricsRc: RenderContext | null = null;
  readonly metrics: LabelMetrics = {
    width: (text, note) => {
      const rc = this.metricsRc;
      return rc ? this.measurer.measure(rc.ctx, labelFont(rc, note), text) : text.length * 7;
    },
    lineHeight: (note) => (this.metricsRc ? lineHeightOf(this.metricsRc, note) : note ? 19 : 17),
    text: (f, text) => {
      const rc = this.metricsRc;
      return rc ? this.measurer.measure(rc.ctx, f, text) : text.length * 7;
    },
  };
  private readonly editor: DrawingEditor;
  private shapes = new WeakMap<DrawingSpec, { key: string; shape: Shape | null }>();
  private boxes = new Map<string, Rect>();
  private labelSlots = new Map<string, { x: number; y: number }>();
  onDrawing: ((e: DrawingEvent) => void) | null = null;

  constructor(options: { id?: string; z?: number } = {}) {
    this.id = options.id ?? 'annotations';
    this.z = options.z ?? 30;
    this.editor = new DrawingEditor({
      shape: (d, axes) => this.shapeOn(d, axes),
      metrics: this.metrics,
      emit: (e) => this.onDrawing?.(e),
      invalidate: () => this.host?.invalidate(),
    });
  }

  private shapeOn(d: DrawingSpec, axes: DrawingAxes): Shape | null {
    const rc = this.metricsRc;
    const key = `${axes.key}|${rc?.theme.agent ?? ''}|${String(rc?.theme.fontSize ?? 0)}|${rc?.theme.background ?? ''}|${rc?.theme.font ?? ''}`;
    const hit = this.shapes.get(d);
    if (hit?.key === key) return hit.shape;
    const shape = shapeOf(d, axes, this.metrics, {
      agentColor: rc?.theme.agent ?? '#8ed1fc',
      upColor: rc?.theme.upFill ?? '#2fd3b4',
      downColor: rc?.theme.downFill ?? '#e0523f',
      ...(rc ? { background: rc.theme.background, family: rc.theme.font } : {}),
    });
    this.shapes.set(d, { key, shape });
    return shape;
  }

  setDrawings(drawings: readonly DrawingSpec[]): void {
    this.editor.setDrawings(drawings);
  }

  getDrawings(): readonly DrawingSpec[] {
    return this.editor.drawings();
  }

  setDrawingTool(kind: PlaceKind | null): void {
    this.editor.setTool(kind);
  }

  get drawingTool(): PlaceKind | null {
    return this.editor.tool;
  }

  setMagnet(on: boolean): void {
    this.editor.magnet = on;
  }

  setNewDrawingStyle(style: NewDrawingStyle): void {
    this.editor.newStyle = style;
  }

  selectDrawing(id: string | null): void {
    this.editor.select(id);
  }

  get selectedDrawing(): string | null {
    return this.editor.selected;
  }

  get drawingBusy(): boolean {
    return this.editor.isPlacing || this.editor.isDragging;
  }

  screenOf(p: DrawingPoint): { x: number; y: number } | null {
    const rc = this.metricsRc;
    if (!rc) return null;
    const axes = drawingAxes(rc);
    const x = axes.xOfTime(p.t);
    const y = axes.yOfPrice(p.price);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  drawingBox(id: string): Rect | null {
    return this.boxes.get(id) ?? null;
  }

  drawingLabelAt(id: string): { x: number; y: number } | null {
    return this.labelSlots.get(id) ?? null;
  }

  pointer(e: LayerPointerEvent, rc: RenderContext): boolean {
    this.metricsRc = rc;
    const axes = drawingAxes(rc);
    const mods = { shift: e.shift, alt: e.alt, cmdOrCtrl: e.cmdOrCtrl };
    switch (e.type) {
      case 'down':
        return this.editor.down(e.x, e.y, mods, axes);
      case 'move':
        this.editor.move(e.x, e.y, mods, axes);
        return true;
      case 'up':
        this.editor.up(e.x, e.y, mods, axes);
        return true;
      case 'hover':
        this.editor.hover(e.x, e.y, mods, axes);
        return false;
      case 'leave':
        this.editor.leave();
        return false;
      case 'dblclick':
        return this.editor.doubleClick(e.x, e.y, axes);
    }
  }

  cursor(x: number, y: number, rc: RenderContext): string | null {
    this.metricsRc = rc;
    return this.editor.cursor(x, y, drawingAxes(rc));
  }

  keyDown(key: string): boolean {
    return this.editor.key(key);
  }

  private drawDrawings(rc: RenderContext): void {
    this.metricsRc = rc;
    const axes = drawingAxes(rc);
    const boxes = new Map<string, Rect>();
    const slots = new Map<string, { x: number; y: number }>();
    const ed = this.editor;
    for (const d of ed.drawings()) {
      const s = this.shapeOn(d, axes);
      if (!s) continue;
      const selected = ed.selected === d.id;
      drawShape(rc, d, s, { selected, hovered: ed.hovered?.id === d.id, preview: false }, this.metrics);
      boxes.set(d.id, s.box);
      if (s.labelAt) slots.set(d.id, s.labelAt);
      for (const t of s.tags) {
        if (!t.always && !selected) continue;
        if (!Number.isFinite(t.price)) continue;
        rc.addAxisTag({
          price: t.price,
          text: rc.format.grouped(t.price),
          style: 'outline',
          color: s.color,
          priority: selected ? 6 : 4,
        });
      }
    }
    const preview = ed.preview();
    if (preview) {
      const s = this.shapeOn(preview, axes);
      if (s) drawShape(rc, preview, s, { selected: false, hovered: false, preview: true }, this.metrics);
    }
    const m = ed.magnetAt;
    if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      const { ctx } = rc;
      ctx.save();
      ctx.strokeStyle = ed.newStyle.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    this.boxes = boxes;
    this.labelSlots = slots;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  getAnnotations(): readonly AnnotationSpec[] {
    return this.annotations;
  }

  setAnnotations(annotations: readonly AnnotationSpec[]): void {
    this.annotations = [...annotations];
    this.host?.invalidate();
  }

  private xOf(rc: RenderContext, t: number | null): number | null {
    if (t === null || rc.store.length === 0) return null;
    const i = rc.store.indexAtOrBefore(t);
    if (i < 0) return null;
    return rc.time.xOfIndex(i);
  }

  hitTest(x: number, y: number, rc: RenderContext): { objectId: string; distance: number } | null {
    this.metricsRc = rc;
    const drawn = this.editor.drawings().length ? this.editor.hitTest(x, y, drawingAxes(rc)) : null;
    let best: { objectId: string; distance: number } | null = drawn
      ? { objectId: drawn.id, distance: drawn.distance }
      : null;
    const consider = (id: string, d: number) => {
      if (d <= HIT_PX && (!best || d < best.distance)) best = { objectId: id, distance: d };
    };
    for (const a of this.annotations) {
      const p0 = a.points[0];
      if (!p0) continue;
      if ((a.kind === 'hline' || a.kind === 'zone') && p0.price !== null) {
        consider(a.id, Math.abs(rc.price.yOf(p0.price) - y));
      } else {
        const ax = this.xOf(rc, p0.t);
        if (ax !== null && p0.price !== null) consider(a.id, Math.hypot(ax - x, rc.price.yOf(p0.price) - y));
      }
    }
    return best;
  }

  draw(rc: RenderContext): void {
    const { ctx, theme, pane, dpr } = rc;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    this.drawDrawings(rc);
    for (const a of this.annotations) {
      const color = a.agent ? theme.agent : theme.text;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(a.agent ? [5, 3] : []);
      const [p0, p1] = a.points;
      if (!p0) continue;
      const y0 = p0.price === null ? null : rc.price.yOf(p0.price);
      const p1Price = p1?.price ?? null;
      const y1 = p1Price === null ? null : rc.price.yOf(p1Price);
      const x0 = this.xOf(rc, p0.t);
      const x1 = p1 ? this.xOf(rc, p1.t) : null;
      let labelAt: { x: number; y: number } | null = null;
      switch (a.kind) {
        case 'hline': {
          if (y0 === null) break;
          const y = crisp(y0, dpr);
          ctx.beginPath();
          ctx.moveTo(pane.x, y);
          ctx.lineTo(pane.x + pane.w, y);
          ctx.stroke();
          labelAt = { x: pane.x + 8, y: y - 4 };
          rc.addAxisTag({
            price: p0.price!,
            text: rc.format.grouped(p0.price!),
            style: 'outline',
            color,
            priority: 5,
            dashed: a.agent,
          });
          break;
        }
        case 'zone': {
          if (y0 === null || y1 === null) break;
          const top = Math.min(y0, y1);
          const h = Math.abs(y1 - y0);
          ctx.globalAlpha = 0.12;
          ctx.fillRect(pane.x, top, pane.w, Math.max(1, h));
          ctx.globalAlpha = 1;
          ctx.strokeRect(pane.x, top, pane.w, Math.max(1, h));
          labelAt = { x: pane.x + 8, y: top - 4 };
          break;
        }
        case 'box': {
          if (x0 === null || x1 === null || y0 === null || y1 === null) break;
          const left = Math.min(x0, x1);
          const top = Math.min(y0, y1);
          ctx.globalAlpha = 0.1;
          ctx.fillRect(left, top, Math.abs(x1 - x0), Math.abs(y1 - y0));
          ctx.globalAlpha = 1;
          ctx.strokeRect(left, top, Math.abs(x1 - x0), Math.abs(y1 - y0));
          labelAt = { x: left, y: top - 4 };
          break;
        }
        case 'arrow': {
          if (x0 === null || x1 === null || y0 === null || y1 === null) break;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          const ang = Math.atan2(y1 - y0, x1 - x0);
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - 8 * Math.cos(ang - 0.4), y1 - 8 * Math.sin(ang - 0.4));
          ctx.lineTo(x1 - 8 * Math.cos(ang + 0.4), y1 - 8 * Math.sin(ang + 0.4));
          ctx.closePath();
          ctx.fill();
          labelAt = { x: x0, y: y0 - 6 };
          break;
        }
        case 'marker': {
          const x = x0 ?? pane.x + pane.w - 12;
          if (y0 === null) break;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(x, y0 - 5);
          ctx.lineTo(x + 5, y0);
          ctx.lineTo(x, y0 + 5);
          ctx.lineTo(x - 5, y0);
          ctx.closePath();
          ctx.fill();
          const t = p0.t === null ? null : rc.store.time[rc.store.indexAtOrBefore(p0.t)];
          this.drawPin(rc, a, x + 10, y0, color, t ?? null);
          break;
        }
        case 'text': {
          const x = x0 ?? pane.x + 8;
          if (y0 === null) break;
          labelAt = { x, y: y0 };
          break;
        }
      }
      if (labelAt) this.drawLabel(rc, a, labelAt.x, labelAt.y, color);
    }
    ctx.restore();
  }

  private drawLabel(rc: RenderContext, a: AnnotationSpec, x: number, y: number, color: string): void {
    const { ctx, theme } = rc;
    ctx.setLineDash([]);
    if (a.label) {
      const f = font(theme.fontSize + 1, theme.font);
      const w = this.measurer.measure(ctx, f, a.label);
      ctx.fillStyle = theme.background;
      ctx.fillRect(x - 2, y - 12, w + 4, 15);
      ctx.fillStyle = color;
      ctx.font = f;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(a.label, x, y);
    }
  }

  private drawPin(
    rc: RenderContext,
    a: AnnotationSpec,
    markX: number,
    y: number,
    color: string,
    t: number | null,
  ): void {
    const { ctx, theme, session } = rc;
    const time = t === null ? null : session.clock.parts(t);
    const head = time ? `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}` : null;
    const text = a.label ?? '';
    if (!head && !text) return;
    const bold = font(theme.fontSize + 1, theme.font, 500);
    const regular = font(theme.fontSize + 1, theme.font);
    const headW = head ? this.measurer.measure(ctx, bold, head) : 0;
    const gap = head && text ? 5 : 0;
    const textW = text ? this.measurer.measure(ctx, regular, text) : 0;
    const w = headW + gap + textW + 12;
    const x = markX + w > rc.pane.x + rc.pane.w ? Math.max(rc.pane.x, markX - 20 - w) : markX;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = theme.background;
    ctx.fillRect(x, y - 11, w, 22);
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'middle';
    if (head) {
      ctx.font = bold;
      ctx.fillStyle = color;
      ctx.fillText(head, x + 6, y + 0.5);
    }
    if (text) {
      ctx.font = regular;
      ctx.fillStyle = a.agent ? theme.text : color;
      ctx.fillText(text, x + 6 + headW + gap, y + 0.5);
    }
    ctx.restore();
  }
}
