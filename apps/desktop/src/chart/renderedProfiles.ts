import { MarketProfileLayer, VolumeProfileLayer, type ChartApi } from '@tessera/chart';
import { msToNs, type ChartLayer, type RenderedProfile } from '@tessera/protocol';
import { indicatorLayerId } from './layers/indicators.ts';

export function renderedProfiles(chart: ChartApi, layers: readonly ChartLayer[]): RenderedProfile[] {
  const out: RenderedProfile[] = [];
  for (const l of layers) {
    if ((l.kind !== 'volume_profile' && l.kind !== 'market_profile') || !l.visible) continue;
    const id = indicatorLayerId(l.id);
    const layer =
      l.kind === 'volume_profile' ? chart.getLayer(id, VolumeProfileLayer) : chart.getLayer(id, MarketProfileLayer);
    for (const p of layer?.rendered() ?? [])
      out.push({
        source: 'layer',
        id: l.id,
        label: p.label,
        from: msToNs(p.from),
        to: msToNs(p.to),
        poc: p.poc,
        vah: p.vah,
        val: p.val,
        volume: p.volume,
        delta: p.delta,
        partial: p.partial,
      });
  }
  return out;
}

export function profilesKey(profiles: readonly RenderedProfile[]): string {
  return profiles.map((p) => `${p.id}|${p.label}|${String(p.from)}|${String(p.poc)}|${String(p.volume)}`).join(';');
}
