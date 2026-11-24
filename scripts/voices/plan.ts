import { createHash } from 'node:crypto';
import { VOICE_LINES, VOICE_LINE_IDS, type VoiceLineId } from '../../apps/desktop/src/sound/voice/lines.ts';
import { MANIFEST_SCHEMA, type PackClip, type PackManifest } from '../../apps/desktop/src/sound/voice/manifest.ts';
import type { VoiceConfig } from './voices.ts';

export const LANGUAGE = 'en';

export interface Job {
  voice: VoiceConfig;
  line: VoiceLineId;
  text: string;
  seed: number;
  key: string;
}

export function takeKey(voice: VoiceConfig, text: string, seed: number, format: string): string {
  const what = JSON.stringify([voice.vendor, voice.voiceId, voice.model, voice.settings, seed, LANGUAGE, format, text]);
  return createHash('sha256').update(what).digest('hex').slice(0, 12);
}

export function planJobs(voices: readonly VoiceConfig[], format: string, lines?: readonly VoiceLineId[]): Job[] {
  const which = lines?.length ? lines : VOICE_LINE_IDS;
  return voices.flatMap((voice) =>
    which.map((line) => {
      const text = VOICE_LINES[line].text;
      const seed = voice.retakes?.[line] ?? voice.seed;
      return { voice, line, text, seed, key: takeKey(voice, text, seed, format) };
    }),
  );
}

export function spendOf(jobs: readonly Job[], made: (j: Job) => boolean, costOf: (j: Job) => number): number {
  return jobs.filter((j) => !made(j)).reduce((sum, j) => sum + costOf(j), 0);
}

export function refusal(spend: number, maxChars: number, left: number | null): string | null {
  if (spend > maxChars)
    return `This run would spend ${String(spend)} characters, over --max-chars ${String(maxChars)}.`;
  if (left !== null && spend > left)
    return `This run would spend ${String(spend)} characters; ${String(left)} are left.`;
  return null;
}

/** ElevenLabs licenses clips for a product that is sold on paid plans only. */
export const commercialPlan = (plan: string) => plan !== 'free';

export function manifestFor(
  voice: VoiceConfig,
  vendor: { plan: string; credit: string },
  clips: Partial<Record<VoiceLineId, PackClip>>,
  generated: string,
  previous?: PackManifest | null,
): PackManifest {
  const keepsPreviousLines =
    previous?.vendor.voiceId === voice.voiceId &&
    previous.vendor.model === voice.model &&
    previous.vendor.plan === vendor.plan;
  const lines: Partial<Record<VoiceLineId, PackClip>> = { ...(keepsPreviousLines ? previous.lines : {}), ...clips };
  const ordered: Partial<Record<VoiceLineId, PackClip>> = {};
  for (const id of VOICE_LINE_IDS) if (lines[id]) ordered[id] = lines[id];
  return {
    schema: MANIFEST_SCHEMA,
    id: voice.id,
    name: voice.name,
    about: voice.about,
    vendor: {
      id: voice.vendor,
      voiceId: voice.voiceId,
      model: voice.model,
      plan: vendor.plan,
      commercialUse: commercialPlan(vendor.plan),
      credit: vendor.credit,
    },
    generated,
    lines: ordered,
  };
}
