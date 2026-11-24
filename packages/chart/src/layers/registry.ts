import type { LayerInfo, SurfaceKind } from '../types.ts';
import type { Layer } from './types.ts';

interface Entry {
  layer: Layer;
  info: LayerInfo;
  seq: number;
}

export class LayerRegistry {
  private readonly entries = new Map<string, Entry>();
  private seq = 0;
  private ordered: Record<SurfaceKind, Layer[]> | null = null;

  add(layer: Layer): LayerInfo {
    if (this.entries.has(layer.id)) throw new Error(`layer "${layer.id}" already exists`);
    const info: LayerInfo = {
      id: layer.id,
      kind: layer.kind,
      provider: layer.provider ?? null,
      owner: layer.owner ?? null,
      surface: layer.surface,
      pane: layer.pane ?? 'main',
      z: layer.z ?? 0,
      visible: layer.visible ?? true,
      settingsSchema: layer.settingsSchema ?? null,
    };
    this.entries.set(layer.id, { layer, info, seq: this.seq++ });
    this.ordered = null;
    return info;
  }

  remove(id: string): Layer | null {
    const e = this.entries.get(id);
    if (!e) return null;
    this.entries.delete(id);
    this.ordered = null;
    return e.layer;
  }

  get(id: string): Layer | null {
    return this.entries.get(id)?.layer ?? null;
  }

  info(id: string): LayerInfo | null {
    const e = this.entries.get(id);
    return e ? { ...e.info } : null;
  }

  setVisible(id: string, visible: boolean): boolean {
    const e = this.entries.get(id);
    if (!e || e.info.visible === visible) return false;
    e.info = { ...e.info, visible };
    this.ordered = null;
    return true;
  }

  setZ(id: string, z: number): boolean {
    const e = this.entries.get(id);
    if (!e || e.info.z === z) return false;
    e.info = { ...e.info, z };
    this.ordered = null;
    return true;
  }

  isVisible(id: string): boolean {
    return this.entries.get(id)?.info.visible ?? false;
  }

  drawList(surface: SurfaceKind): readonly Layer[] {
    if (!this.ordered) {
      const lists: Record<SurfaceKind, Entry[]> = { gpu: [], underlay: [], main: [], overlay: [] };
      for (const e of this.entries.values()) if (e.info.visible) lists[e.info.surface].push(e);
      const sort = (a: Entry, b: Entry) => a.info.z - b.info.z || a.seq - b.seq;
      this.ordered = {
        gpu: lists.gpu.sort(sort).map((e) => e.layer),
        underlay: lists.underlay.sort(sort).map((e) => e.layer),
        main: lists.main.sort(sort).map((e) => e.layer),
        overlay: lists.overlay.sort(sort).map((e) => e.layer),
      };
    }
    return this.ordered[surface];
  }

  list(): LayerInfo[] {
    const order: Record<SurfaceKind, number> = { gpu: 0, underlay: 1, main: 2, overlay: 3 };
    return [...this.entries.values()]
      .sort((a, b) => order[a.info.surface] - order[b.info.surface] || a.info.z - b.info.z || a.seq - b.seq)
      .map((e) => ({ ...e.info }));
  }

  all(): Layer[] {
    return [...this.entries.values()].map((e) => e.layer);
  }

  surfaceOf(id: string): SurfaceKind | null {
    return this.entries.get(id)?.info.surface ?? null;
  }
}
