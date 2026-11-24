import type { JsonValue } from '@tessera/protocol';
import { SOUND_EVENTS, type SoundEvent } from './events.ts';

export const VOICE_OFF = 'off';

export interface SoundSettings {
  muted: boolean;
  volume: number;
  voice: string | null;
  events: Readonly<Record<SoundEvent, boolean>>;
}

export const DEFAULT_SOUNDS: SoundSettings = {
  muted: false,
  volume: 0.6,
  voice: null,
  events: { fill: true, stop: true, target: true, rejected: true, cancelled: true, connection: true, alert: true },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function soundSettings(v: unknown): SoundSettings {
  const o = isRecord(v) ? v : {};
  const ev = isRecord(o.events) ? o.events : {};
  const volume =
    typeof o.volume === 'number' && Number.isFinite(o.volume)
      ? Math.min(1, Math.max(0, o.volume))
      : DEFAULT_SOUNDS.volume;
  const events = { ...DEFAULT_SOUNDS.events };
  for (const name of SOUND_EVENTS) {
    const on = ev[name];
    if (typeof on === 'boolean') events[name] = on;
  }
  const voice = typeof o.voice === 'string' && o.voice.length > 0 ? o.voice : null;
  return { muted: typeof o.muted === 'boolean' ? o.muted : DEFAULT_SOUNDS.muted, volume, voice, events };
}

export function audible(s: SoundSettings, event: SoundEvent): number {
  return s.muted || !s.events[event] ? 0 : s.volume;
}

export function previewGain(s: SoundSettings): number {
  return s.muted ? 0 : s.volume;
}

export function soundsValue(s: SoundSettings): JsonValue {
  const events: Record<string, JsonValue> = {};
  for (const name of SOUND_EVENTS) events[name] = s.events[name];
  return { muted: s.muted, volume: s.volume, ...(s.voice === null ? {} : { voice: s.voice }), events };
}
