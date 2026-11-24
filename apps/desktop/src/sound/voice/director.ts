import { VOICE_LINES, type VoiceGroup, type VoiceLineId } from './lines.ts';

export interface DirectorTiming {
  gatherMs: number;
  holdMs: number;
  gapMs: number;
  staleMs: number;
}

export const TIMING: DirectorTiming = { gatherMs: 150, holdMs: 1000, gapMs: 150, staleMs: 3000 };

interface Waiting {
  lines: Set<VoiceLineId>;
  at: number;
}

const rankOf = (line: VoiceLineId) => VOICE_LINES[line].rank;
const byRank = (a: VoiceLineId, b: VoiceLineId) => rankOf(b) - rankOf(a);

export class VoiceDirector {
  private readonly waiting = new Map<VoiceGroup, Waiting>();
  private burstAt: number | null = null;
  private busyUntil = 0;
  private readonly held = new Map<VoiceGroup, { rank: number; until: number }>();

  constructor(private readonly t: DirectorTiming = TIMING) {}

  offer(line: VoiceLineId, now: number): void {
    const { group, rank } = VOICE_LINES[line];
    const h = this.held.get(group);
    if (h && now < h.until && rank <= h.rank) return;
    const w = this.waiting.get(group);
    if (w) w.lines.add(line);
    else this.waiting.set(group, { lines: new Set([line]), at: now });
    this.burstAt ??= now;
  }

  wakeAt(): number | null {
    if (this.burstAt === null) return null;
    return Math.max(this.burstAt + this.t.gatherMs, this.busyUntil);
  }

  take(now: number): VoiceLineId[] {
    for (const [g, w] of this.waiting) if (now - w.at > this.t.staleMs) this.waiting.delete(g);
    if (this.waiting.size === 0) {
      this.burstAt = null;
      return [];
    }
    const wake = this.wakeAt();
    if (wake === null || now < wake) return [];
    let best: VoiceGroup | null = null;
    let top = -Infinity;
    for (const [g, w] of this.waiting) {
      const r = Math.max(...[...w.lines].map(rankOf));
      if (r > top) {
        top = r;
        best = g;
      }
    }
    const w = this.waiting.get(best!)!;
    this.waiting.delete(best!);
    if (this.waiting.size === 0) this.burstAt = null;
    return [...w.lines].sort(byRank);
  }

  said(lines: readonly VoiceLineId[], now: number, durationMs: number): void {
    if (lines.length === 0) return;
    const { group } = VOICE_LINES[lines[0]!];
    const end = now + durationMs;
    this.busyUntil = end + this.t.gapMs;
    this.held.set(group, { rank: Math.max(...lines.map(rankOf)), until: end + this.t.holdMs });
  }
}
