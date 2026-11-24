import type { HealthStatus, ProviderHealth } from '@tessera/protocol';
import type { VoiceLineId } from './voice/lines.ts';

const WATCHED: ReadonlySet<ProviderHealth['kind']> = new Set(['broker', 'market_data']);
const LOST: ReadonlySet<HealthStatus> = new Set(['degraded', 'down']);

export class ConnectionSoundTracker {
  private readonly status = new Map<string, HealthStatus>();
  private readonly lost = new Set<string>();
  private active = false;

  activate(): void {
    this.active = true;
  }

  reset(): void {
    this.status.clear();
    this.lost.clear();
  }

  restart(): void {
    this.reset();
    this.active = false;
  }

  see(providers: readonly ProviderHealth[], seq: number): VoiceLineId | null {
    const live = this.active && seq > 0;
    let lost = false;
    let restored = false;
    const here = new Set<string>();
    for (const p of providers) {
      if (!WATCHED.has(p.kind)) continue;
      here.add(p.providerId);
      const prev = this.status.get(p.providerId);
      this.status.set(p.providerId, p.status);
      if (prev === 'ok' && LOST.has(p.status)) {
        if (live) {
          this.lost.add(p.providerId);
          lost = true;
        }
      } else if (p.status === 'ok' && this.lost.delete(p.providerId)) restored = true;
      else if (p.status === 'disconnected' || p.status === 'disabled') this.lost.delete(p.providerId);
    }
    for (const id of this.status.keys())
      if (!here.has(id)) {
        this.status.delete(id);
        this.lost.delete(id);
      }
    if (lost) return 'connection_lost';
    return restored ? 'connection_restored' : null;
  }
}
