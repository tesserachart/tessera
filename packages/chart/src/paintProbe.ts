import { FlowState } from './layers/flowReadout.ts';
import type { Ctx2D, Layer } from './layers/types.ts';
import type { SeriesStore } from './store.ts';
import type { LayerKind } from './types.ts';

interface PaintedLayer {
  readonly id: string;
  readonly kind: LayerKind;
  readonly ops: number;
  readonly print: number;
  readonly data: number;
  readonly reading: boolean;
  readonly notice: string | null;
  readonly stopped: boolean;
}

interface PaintedBars {
  readonly count: number;
  readonly first: number | null;
  readonly last: number | null;
}

export interface PaintFrame {
  readonly chart: number;
  readonly at: number;
  readonly bars: PaintedBars;
  readonly layers: readonly PaintedLayer[];
}

export type PaintHook = (frame: PaintFrame) => void;

declare global {
  var __TESSERA_PAINT_HOOK__: PaintHook | undefined;
}

const PAINTS = new Set<PropertyKey>([
  'fill',
  'fillRect',
  'stroke',
  'strokeRect',
  'fillText',
  'strokeText',
  'drawImage',
  'putImageData',
]);

const SHAPES = new Set<PropertyKey>([
  'moveTo',
  'lineTo',
  'rect',
  'roundRect',
  'arc',
  'arcTo',
  'ellipse',
  'quadraticCurveTo',
  'bezierCurveTo',
]);

const STYLES = new Set<PropertyKey>(['fillStyle', 'strokeStyle', 'font', 'globalAlpha', 'lineWidth']);

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const QUARTER_PIXELS = 4;

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), FNV_PRIME) >>> 0;
}

function mixText(h: number, s: string): number {
  let out = h;
  for (let i = 0; i < s.length; i++) out = mix(out, s.charCodeAt(i));
  return out;
}

function mixValue(h: number, v: unknown): number {
  if (typeof v === 'number') return mix(h, Math.round(v * QUARTER_PIXELS));
  if (typeof v === 'string') return mixText(h, v);
  if (typeof v === 'boolean') return mix(h, v ? 1 : 2);
  return h;
}

interface Tally {
  ops: number;
  print: number;
}

let charts = 0;

export class PaintCensus {
  readonly chart = ++charts;
  private readonly hook: PaintHook;
  private readonly wrapped = new WeakMap<Ctx2D, Ctx2D>();
  private readonly dataSeen = new WeakMap<Layer, number>();
  private readonly painted = new Map<Layer, Tally>();
  private current: Tally | null = null;

  private constructor(hook: PaintHook) {
    this.hook = hook;
  }

  static installed(): PaintCensus | null {
    const hook = globalThis.__TESSERA_PAINT_HOOK__;
    return typeof hook === 'function' ? new PaintCensus(hook) : null;
  }

  dataChanged(layer: Layer): void {
    this.dataSeen.set(layer, (this.dataSeen.get(layer) ?? 0) + 1);
  }

  wrap(ctx: Ctx2D): Ctx2D {
    let proxy = this.wrapped.get(ctx);
    if (proxy) return proxy;
    const bound = new Map<PropertyKey, unknown>();
    proxy = new Proxy(ctx, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        let fn = bound.get(key);
        if (fn) return fn;
        const method = value as (...args: unknown[]) => unknown;
        fn =
          PAINTS.has(key) || SHAPES.has(key)
            ? (...args: unknown[]) => {
                this.note(String(key), args, PAINTS.has(key));
                return method.apply(target, args);
              }
            : method.bind(target);
        bound.set(key, fn);
        return fn;
      },
      set: (target, key, value) => {
        if (STYLES.has(key)) this.note(String(key), [value], false);
        return Reflect.set(target, key, value, target);
      },
    });
    this.wrapped.set(ctx, proxy);
    return proxy;
  }

  begin(layer: Layer): void {
    const tally = { ops: 0, print: FNV_OFFSET };
    this.painted.set(layer, tally);
    this.current = tally;
  }

  end(): void {
    this.current = null;
  }

  flush(at: number, store: SeriesStore): void {
    if (this.painted.size === 0) return;
    const layers: PaintedLayer[] = [];
    for (const [layer, tally] of this.painted) {
      const state = (layer as { state?: unknown }).state;
      const flow = state instanceof FlowState ? state : null;
      layers.push({
        id: layer.id,
        kind: layer.kind,
        ops: tally.ops,
        print: tally.print,
        data: this.dataSeen.get(layer) ?? 0,
        reading: flow?.reading ?? false,
        notice: flow?.notice?.text ?? null,
        stopped: flow?.stopped ?? false,
      });
    }
    this.painted.clear();
    const count = store.length;
    try {
      this.hook({
        chart: this.chart,
        at,
        bars: {
          count,
          first: count > 0 ? store.time[0]! : null,
          last: count > 0 ? store.time[count - 1]! : null,
        },
        layers,
      });
    } catch (err) {
      console.error('[chart] the paint hook failed', err);
    }
  }

  private note(op: string, args: readonly unknown[], paints: boolean): void {
    const tally = this.current;
    if (!tally) return;
    if (paints) tally.ops++;
    let h = mixText(tally.print, op);
    for (const a of args) h = mixValue(h, a);
    tally.print = h;
  }
}
