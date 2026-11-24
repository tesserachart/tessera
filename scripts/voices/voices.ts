import type { VoiceLineId } from '../../apps/desktop/src/sound/voice/lines.ts';

export interface VoiceConfig {
  id: string;
  name: string;
  about: string;
  why: string;
  vendor: 'elevenlabs';
  voiceId: string;
  model: string;
  settings: Readonly<Record<string, number | boolean>>;
  seed: number;
  retakes?: Partial<Record<VoiceLineId, number>>;
}

const MODEL = 'eleven_v4';
const STEADY = { stability: 0.7, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1 } as const;

export const VOICES: readonly VoiceConfig[] = [
  {
    id: 'daniel',
    name: 'Daniel',
    about: 'British, steady broadcaster',
    why: 'A newsreader’s formal, even delivery: the broadcast feel, every word distinct, never hurried.',
    vendor: 'elevenlabs',
    voiceId: 'onwK4e9ZLuTAKqWW03F9',
    model: MODEL,
    settings: STEADY,
    seed: 1001,
  },
  {
    id: 'sarah',
    name: 'Sarah',
    about: 'American, calm and confident',
    why: 'Mature and reassuring, professional rather than bright: as calm on a stop as on a target.',
    vendor: 'elevenlabs',
    voiceId: 'EXAVITQu4vr4xnSDxMaL',
    model: MODEL,
    settings: STEADY,
    seed: 1002,
  },
  {
    id: 'alice',
    name: 'Alice',
    about: 'British, clear',
    why: 'An educator’s crisp diction: hard consonants that stay clear on laptop speakers at low volume.',
    vendor: 'elevenlabs',
    voiceId: 'Xb7hH8MSUJpSbSDYk0k2',
    model: MODEL,
    settings: STEADY,
    seed: 1003,
  },
  {
    id: 'eric',
    name: 'Eric',
    about: 'American, smooth',
    why: 'A smooth, trustworthy mid-range tenor made for agents: carries without the boom of a deep voice.',
    vendor: 'elevenlabs',
    voiceId: 'cjVigY5qzO86Huf0OWal',
    model: MODEL,
    settings: STEADY,
    seed: 1004,
  },
];
