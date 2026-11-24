import type { ChartApi, LevelSpec } from '@tessera/chart';
import type {
  ChartLayer,
  ContractSpec,
  DrawnLayerKind,
  Level,
  PrintBars,
  SessionFilter,
  Timeframe,
} from '@tessera/protocol';
import type { FlowHub } from '../../market/flow/hub.ts';
import type { LevelSettings } from '../levelSettings.ts';

export interface LevelsSink {
  set(layerId: string, specs: readonly LevelSpec[]): void;
  remove(layerId: string): void;
}

export interface LayerContext {
  readonly chart: ChartApi;
  readonly levels: readonly Level[];
  readonly levelsSink: LevelsSink;
  readonly levelSettings?: LevelSettings;
  readonly instrument?: string;
  readonly tf?: Timeframe;
  readonly printBars?: PrintBars | null;
  readonly session?: SessionFilter;
  readonly spec?: ContractSpec | null;
  readonly flow?: FlowHub | null;
}

export interface LayerBinding {
  update(layer: ChartLayer, ctx: LayerContext, order: number): void;
  dispose(): void;
}

export interface LayerFactory {
  label(layer: ChartLayer): string;
  create(layer: ChartLayer, ctx: LayerContext): LayerBinding;
}

const factories = new Map<DrawnLayerKind, LayerFactory>();

export function registerLayerFactory(kind: DrawnLayerKind, factory: LayerFactory): void {
  factories.set(kind, factory);
}

export function layerFactory(kind: string): LayerFactory | null {
  return factories.get(kind as DrawnLayerKind) ?? null;
}

export function registeredLayerKinds(): DrawnLayerKind[] {
  return [...factories.keys()].sort();
}

export function paramsOf<T extends object>(layer: ChartLayer): Partial<T> {
  const p = layer.params;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Partial<T>) : {};
}

export class LayerReconciler {
  private readonly bindings = new Map<string, { kind: string; binding: LayerBinding }>();

  reconcile(layers: readonly ChartLayer[], ctx: LayerContext): void {
    const seen = new Set<string>();
    for (const [order, layer] of layers.entries()) {
      const factory = layerFactory(layer.kind);
      if (!factory) continue;
      seen.add(layer.id);
      let entry = this.bindings.get(layer.id);
      if (entry && entry.kind !== layer.kind) {
        entry.binding.dispose();
        entry = undefined;
      }
      if (!entry) {
        entry = { kind: layer.kind, binding: factory.create(layer, ctx) };
        this.bindings.set(layer.id, entry);
      }
      entry.binding.update(layer, ctx, order);
    }
    for (const [id, entry] of this.bindings) {
      if (seen.has(id)) continue;
      entry.binding.dispose();
      this.bindings.delete(id);
    }
  }

  drawn(): string[] {
    return [...this.bindings.keys()];
  }

  dispose(): void {
    for (const entry of this.bindings.values()) entry.binding.dispose();
    this.bindings.clear();
  }
}
