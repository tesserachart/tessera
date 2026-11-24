import { crisp } from '../render/draw.ts';
import type { Layer, LayerHost, RenderContext } from './types.ts';

export interface StepLine {
  id: string;
  steps: readonly { t: number; price: number | null }[];
  end: number;
  color: string;
  width?: number;
  dash?: readonly number[];
  include?: boolean;
  marks?: boolean;
}

export interface StepGeometry {
  runs: { x0: number; x1: number; y: number }[];
  joins: { x: number; y0: number; y1: number }[];
  dots: { x: number; y: number }[];
}

export function stepGeometry(
  line: StepLine,
  xOf: (ms: number) => number,
  yOf: (price: number) => number,
): StepGeometry {
  const out: StepGeometry = { runs: [], joins: [], dots: [] };
  const s = line.steps;
  for (let i = 0; i < s.length; i++) {
    const step = s[i]!;
    if (step.price === null) continue;
    const x0 = xOf(step.t);
    const x1 = xOf(i + 1 < s.length ? s[i + 1]!.t : line.end);
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
    const y = yOf(step.price);
    out.runs.push({ x0, x1: Math.max(x0, x1), y });
    const next = s[i + 1];
    if (next && next.price !== null && next.price !== step.price) out.joins.push({ x: x1, y0: y, y1: yOf(next.price) });
    const prev = i > 0 ? s[i - 1]! : null;
    if (prev && prev.price !== null && prev.price !== step.price) out.dots.push({ x: x0, y });
  }
  return out;
}

export interface StepLinesLayerOptions {
  id: string;
  z?: number;
}

export class StepLinesLayer implements Layer {
  readonly id: string;
  readonly kind = 'overlay' as const;
  readonly surface = 'overlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = null;
  readonly owner = null;
  private lines: StepLine[] = [];
  private host: LayerHost | null = null;

  constructor(options: StepLinesLayerOptions) {
    this.id = options.id;
    this.z = options.z ?? 22;
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  setLines(lines: readonly StepLine[]): void {
    this.lines = [...lines];
    this.host?.invalidate();
  }

  getLines(): readonly StepLine[] {
    return this.lines;
  }

  autoscaleRange(): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of this.lines) {
      if (!l.include) continue;
      for (const s of l.steps) {
        if (s.price === null) continue;
        if (s.price < lo) lo = s.price;
        if (s.price > hi) hi = s.price;
      }
    }
    return hi >= lo ? [lo, hi] : null;
  }

  draw(rc: RenderContext): void {
    const { ctx, dpr, pane, price, time } = rc;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    for (const l of this.lines) {
      const g = stepGeometry(
        l,
        (ms) => time.xOfTime(ms),
        (p) => price.yOf(p),
      );
      ctx.strokeStyle = l.color;
      ctx.fillStyle = l.color;
      ctx.lineWidth = l.width ?? 1.5;
      ctx.setLineDash(l.dash ? [...l.dash] : []);
      ctx.beginPath();
      for (const r of g.runs) {
        const y = crisp(r.y, dpr);
        ctx.moveTo(r.x0, y);
        ctx.lineTo(r.x1, y);
      }
      for (const j of g.joins) {
        const x = crisp(j.x, dpr);
        ctx.moveTo(x, crisp(j.y0, dpr));
        ctx.lineTo(x, crisp(j.y1, dpr));
      }
      ctx.stroke();
      if (l.marks ?? true) {
        ctx.setLineDash([]);
        for (const d of g.dots) {
          ctx.beginPath();
          ctx.arc(d.x, crisp(d.y, dpr), 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }
}
