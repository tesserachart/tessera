import { describe, expect, it } from 'vitest';
import { VOICE_LINES, VOICE_LINE_IDS } from '../../apps/desktop/src/sound/voice/lines.ts';
import { parseManifest } from '../../apps/desktop/src/sound/voice/manifest.ts';
import { gainFor } from './audio.ts';
import { keyIn } from './elevenlabs.ts';
import { commercialPlan, manifestFor, planJobs, refusal, spendOf, takeKey } from './plan.ts';
import { VOICES, type VoiceConfig } from './voices.ts';

const voice: VoiceConfig = {
  id: 'test',
  name: 'Test',
  about: 'a test',
  why: 'tests',
  vendor: 'elevenlabs',
  voiceId: 'abc',
  model: 'eleven_v4',
  settings: { stability: 0.7 },
  seed: 1,
  retakes: { stop_hit: 2 },
};

describe('the voices', () => {
  it('are four packs with ids fit for a setting, each a distinct premade voice', () => {
    expect(
      VOICES.map((v) => v.id),
      'user settings keep a pack id: add packs, never rename one',
    ).toEqual(['daniel', 'sarah', 'alice', 'eric']);
    for (const v of VOICES) expect(v.id).toMatch(/^[a-z0-9-]+$/);
    expect(new Set(VOICES.map((v) => v.voiceId)).size).toBe(VOICES.length);
  });
});

describe('a run’s plan', () => {
  it('takes every line of every voice, a retake with its own seed', () => {
    const jobs = planJobs([voice], 'mp3_44100_128');
    expect(jobs).toHaveLength(VOICE_LINE_IDS.length);
    expect(jobs.find((j) => j.line === 'stop_hit')?.seed).toBe(2);
    expect(jobs.find((j) => j.line === 'alert')?.seed).toBe(1);
    expect(jobs.find((j) => j.line === 'alert')?.text).toBe(VOICE_LINES.alert.text);
    expect(planJobs([voice], 'mp3_44100_128', ['alert']).map((j) => j.line)).toEqual(['alert']);
  });

  it('keys a take by everything that changes it, so a take made is never paid for twice', () => {
    const k = takeKey(voice, 'Alert.', 1, 'mp3_44100_128');
    expect(takeKey(voice, 'Alert.', 1, 'mp3_44100_128')).toBe(k);
    expect(takeKey(voice, 'Alert!', 1, 'mp3_44100_128')).not.toBe(k);
    expect(takeKey(voice, 'Alert.', 2, 'mp3_44100_128')).not.toBe(k);
    expect(takeKey({ ...voice, settings: { stability: 0.5 } }, 'Alert.', 1, 'mp3_44100_128')).not.toBe(k);
    expect(takeKey({ ...voice, model: 'eleven_v3' }, 'Alert.', 1, 'mp3_44100_128')).not.toBe(k);
    expect(takeKey(voice, 'Alert.', 1, 'pcm_24000')).not.toBe(k);
  });

  it('costs only the takes not yet made, and refuses past the cap or what is left', () => {
    const jobs = planJobs([voice], 'mp3_44100_128', ['alert', 'stop_hit']);
    const made = (j: { line: string }) => j.line === 'alert';
    expect(spendOf(jobs, made, (j) => j.text.length)).toBe(VOICE_LINES.stop_hit.text.length);
    expect(
      spendOf(
        jobs,
        () => false,
        (j) => j.text.length / 2,
      ),
    ).toBe((VOICE_LINES.stop_hit.text.length + VOICE_LINES.alert.text.length) / 2);
    expect(refusal(100, 200, 500)).toBeNull();
    expect(refusal(300, 200, 500)).toMatch(/over --max-chars 200/);
    expect(refusal(100, 200, 50)).toMatch(/50 are left/);
    expect(refusal(100, 200, null)).toBeNull();
  });
});

describe('a pack’s manifest', () => {
  const clip = { file: 'alert.mp3', text: 'Alert.', durationMs: 700, lufs: -20.4 };

  it('says the plan its clips were made on: the free plan’s are not for a product that is sold', () => {
    const m = manifestFor(voice, { plan: 'free', credit: 'Voices by ElevenLabs' }, { alert: clip }, '2026-10-19');
    expect(m.vendor).toEqual({
      id: 'elevenlabs',
      voiceId: 'abc',
      model: 'eleven_v4',
      plan: 'free',
      commercialUse: false,
      credit: 'Voices by ElevenLabs',
    });
    expect(parseManifest(JSON.parse(JSON.stringify(m)))).toEqual(m);
    expect(commercialPlan('creator')).toBe(true);
  });

  it('keeps the lines a run did not take, unless the voice, model or plan changed under them', () => {
    const before = manifestFor(voice, { plan: 'free', credit: 'c' }, { alert: clip }, '2026-10-18');
    const stop = { ...clip, file: 'stop_hit.mp3', text: VOICE_LINES.stop_hit.text };
    const after = manifestFor(voice, { plan: 'free', credit: 'c' }, { stop_hit: stop }, '2026-10-19', before);
    expect(Object.keys(after.lines)).toEqual(['stop_hit', 'alert']);
    const paid = manifestFor(voice, { plan: 'creator', credit: 'c' }, { stop_hit: stop }, '2026-10-19', before);
    expect(Object.keys(paid.lines)).toEqual(['stop_hit']);
  });
});

describe('the ElevenLabs key file', () => {
  it('holds the key alone or as ELEVENLABS_API_KEY', () => {
    const key = 'sk_0123456789abcdef0123456789abcdef';
    expect(keyIn(`${key}\n`)).toBe(key);
    expect(keyIn(`# mine\nELEVENLABS_API_KEY=${key}\n`)).toBe(key);
    expect(keyIn(`export ELEVENLABS_API_KEY="${key}"`)).toBe(key);
    expect(keyIn('OTHER=1\n')).toBeNull();
    expect(keyIn('')).toBeNull();
  });
});

describe('post-processing', () => {
  it('brings a clip to the target unless its peak would cross the ceiling', () => {
    const o = { targetLufs: -20, ceilingDbtp: -1.5, bitrateKbps: 64 };
    expect(gainFor({ lufs: -24, truePeakDbtp: -8 }, o)).toBe(4);
    expect(gainFor({ lufs: -24, truePeakDbtp: -3 }, o)).toBe(1.5);
    expect(gainFor({ lufs: -18, truePeakDbtp: -1 }, o)).toBe(-2);
  });
});
