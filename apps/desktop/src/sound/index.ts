import { readSetting } from '../state/runtimeSettings.ts';
import { audioContext, bestEffort, whenRunning } from './context.ts';
import type { SoundEvent } from './events.ts';
import { audible, previewGain, SOUNDS, type SoundSettings } from './settings.ts';
import { TONES, type Note, type SoundName } from './tones.ts';

export type { SoundName } from './tones.ts';

const STACK_MS = 60;
const ATTACK = 0.008;
const FLOOR = 0.0001;

const lastAt = new Map<SoundName, number>();

function schedule(c: AudioContext, notes: readonly Note[], gain: number): void {
  const out = c.createGain();
  out.gain.value = gain;
  out.connect(c.destination);
  const t0 = c.currentTime + 0.005;
  let left = notes.length;
  for (const n of notes) {
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = n.wave;
    osc.frequency.value = n.freq;
    const start = t0 + n.at;
    const end = start + n.dur;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(n.gain, start + Math.min(ATTACK, n.dur / 4));
    env.gain.exponentialRampToValueAtTime(FLOOR, end);
    env.gain.linearRampToValueAtTime(0, end + 0.01);
    osc.connect(env);
    env.connect(out);
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
      if (--left === 0) out.disconnect();
    };
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

function play(name: SoundName, gain: number): void {
  if (gain <= 0) return;
  bestEffort(() => {
    if (!audioContext()) return;
    const now = performance.now();
    const last = lastAt.get(name);
    if (last !== undefined && now - last < STACK_MS) return;
    lastAt.set(name, now);
    whenRunning((c) => schedule(c, TONES[name], gain));
  });
}

export const soundsNow = (): SoundSettings => readSetting(SOUNDS);

const EVENT_OF: Readonly<Record<SoundName, SoundEvent>> = {
  fill: 'fill',
  stop: 'stop',
  target: 'target',
  rejected: 'rejected',
  alert: 'alert',
  alertAsk: 'alert',
  alertBid: 'alert',
};

export function playSound(name: SoundName): void {
  play(name, audible(soundsNow(), EVENT_OF[name]));
}

export function previewSound(name: SoundName): void {
  play(name, previewGain(soundsNow()));
}
