import type { FootprintStore } from '../flow/footprintStore.ts';
import { DEFAULT_IMBALANCE, type ImbalanceOptions } from '../flow/imbalance.ts';
import type { TimeSpan } from '../types.ts';
import {
  FlowState,
  NO_GAPS,
  STOPPED_ALPHA,
  type FlowReadout,
  type LegendNote,
  type LegendNotice,
  type LegendValue,
} from './flowReadout.ts';
import { paintZones, ZoneFinder } from './imbalanceZones.ts';
import type { Layer, LayerHost, RenderContext } from './types.ts';

export interface StackedImbalanceOptions extends ImbalanceOptions {
  rowTicks: number | 'auto';
  minRowTicks: number;
  tested: boolean;
}

export const DEFAULT_STACKED_IMBALANCE: Readonly<StackedImbalanceOptions> = {
  ...DEFAULT_IMBALANCE,
  rowTicks: 'auto',
  minRowTicks: 1,
  tested: true,
};

export interface StackedImbalanceLayerOptions {
  id: string;
  options?: Partial<StackedImbalanceOptions>;
  z?: number;
  owner?: string | null;
  visible?: boolean;
}

export function stackRowTicks(o: Pick<StackedImbalanceOptions, 'rowTicks' | 'minRowTicks'>): number {
  return Math.max(1, Math.round(o.rowTicks === 'auto' ? o.minRowTicks : o.rowTicks));
}

export class StackedImbalanceLayer implements Layer, FlowReadout {
  readonly id: string;
  readonly kind = 'study' as const;
  readonly surface = 'underlay' as const;
  readonly pane = 'main' as const;
  readonly z: number;
  readonly provider = 'Tessera';
  readonly owner: string | null;
  readonly visible: boolean;
  readonly state = new FlowState();
  options: StackedImbalanceOptions;
  needFrom: number | null = null;
  private store: FootprintStore | null = null;
  private host: LayerHost | null = null;
  private gaps: readonly TimeSpan[] = NO_GAPS;
  private readonly zones = new ZoneFinder();

  constructor(o: StackedImbalanceLayerOptions) {
    this.id = o.id;
    this.z = o.z ?? 6;
    this.owner = o.owner ?? null;
    this.visible = o.visible ?? true;
    this.options = { ...DEFAULT_STACKED_IMBALANCE, ...o.options };
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  detach(): void {
    this.host = null;
  }

  setStore(store: FootprintStore | null): void {
    if (store === this.store) return;
    this.store = store;
    this.zones.reset();
    this.host?.invalidate('data');
  }

  setOptions(o: Partial<StackedImbalanceOptions>): void {
    this.options = { ...this.options, ...o };
    this.zones.reset();
    this.host?.invalidate();
  }

  setGaps(gaps: readonly TimeSpan[]): void {
    if (gaps === this.gaps) return;
    this.gaps = gaps;
    this.host?.invalidate('data');
  }

  dataChanged(): void {
    this.host?.invalidate('data');
  }

  noteChanged(): void {
    this.host?.invalidate();
  }

  missingPrints(): readonly TimeSpan[] {
    return this.gaps;
  }

  legendValues(): LegendValue[] {
    return [];
  }

  legendNote(): LegendNote | null {
    return this.state.note;
  }

  legendNotice(): LegendNotice | null {
    return this.state.notice;
  }

  reading(): boolean {
    return this.state.reading;
  }

  legendSuffix(): string {
    const ticks = stackRowTicks(this.options);
    return this.options.rowTicks === 'auto' && ticks > 1 ? `${String(ticks)} ticks` : '';
  }

  aggressorNote(): string | null {
    return this.state.aggressor;
  }

  draw(rc: RenderContext): void {
    if (rc.time.to >= rc.time.from) this.needFrom = rc.store.time[rc.time.from] ?? null;
    const store = this.store;
    if (!store) return;
    const found = this.zones.inView(store, rc, this.options, stackRowTicks(this.options));
    const zones = this.options.tested ? found : found.filter((z) => z.open);
    const { ctx } = rc;
    const g = ctx.globalAlpha;
    if (this.state.stopped) ctx.globalAlpha = g * STOPPED_ALPHA;
    paintZones(rc, store.grid, zones);
    ctx.globalAlpha = g;
  }
}
