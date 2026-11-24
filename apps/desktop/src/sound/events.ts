export type SoundEvent = 'fill' | 'stop' | 'target' | 'rejected' | 'alert' | 'cancelled' | 'connection';

export const SOUND_EVENTS: readonly SoundEvent[] = [
  'fill',
  'stop',
  'target',
  'rejected',
  'cancelled',
  'connection',
  'alert',
];

export const VOICE_ONLY_EVENTS: ReadonlySet<SoundEvent> = new Set<SoundEvent>(['cancelled', 'connection']);
