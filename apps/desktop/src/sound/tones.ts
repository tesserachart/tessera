export type SoundName = 'fill' | 'stop' | 'target' | 'rejected' | 'alert' | 'alertAsk' | 'alertBid';

export const SOUND_NAMES: readonly SoundName[] = [
  'fill',
  'stop',
  'target',
  'rejected',
  'alert',
  'alertAsk',
  'alertBid',
];

export interface Note {
  freq: number;
  at: number;
  dur: number;
  gain: number;
  wave: 'sine' | 'triangle';
}

export const TONES: Readonly<Record<SoundName, readonly Note[]>> = {
  fill: [{ freq: 659.25, at: 0, dur: 0.18, gain: 0.32, wave: 'sine' }],
  target: [
    { freq: 523.25, at: 0, dur: 0.14, gain: 0.28, wave: 'sine' },
    { freq: 783.99, at: 0.1, dur: 0.22, gain: 0.28, wave: 'sine' },
  ],
  stop: [
    { freq: 440, at: 0, dur: 0.14, gain: 0.3, wave: 'triangle' },
    { freq: 329.63, at: 0.11, dur: 0.22, gain: 0.3, wave: 'triangle' },
  ],
  rejected: [
    { freq: 220, at: 0, dur: 0.07, gain: 0.3, wave: 'triangle' },
    { freq: 220, at: 0.11, dur: 0.07, gain: 0.3, wave: 'triangle' },
  ],
  alert: [
    { freq: 1046.5, at: 0, dur: 0.18, gain: 0.22, wave: 'sine' },
    { freq: 1318.51, at: 0.12, dur: 0.22, gain: 0.22, wave: 'sine' },
  ],
  alertAsk: [
    { freq: 783.99, at: 0, dur: 0.1, gain: 0.22, wave: 'sine' },
    { freq: 1046.5, at: 0.08, dur: 0.1, gain: 0.22, wave: 'sine' },
    { freq: 1318.51, at: 0.16, dur: 0.18, gain: 0.22, wave: 'sine' },
  ],
  alertBid: [
    { freq: 1318.51, at: 0, dur: 0.1, gain: 0.22, wave: 'sine' },
    { freq: 1046.5, at: 0.08, dur: 0.1, gain: 0.22, wave: 'sine' },
    { freq: 783.99, at: 0.16, dur: 0.18, gain: 0.22, wave: 'sine' },
  ],
};

export function toneLength(notes: readonly Note[]): number {
  return notes.reduce((end, n) => Math.max(end, n.at + n.dur), 0);
}
