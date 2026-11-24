import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Quota, SpeakRequest, Speech, TtsVendor } from './vendor.ts';

/*
 * ElevenLabs' free plan speaks its premade voices only, as MP3 at 44.1 kHz and 128 kbps at most, two requests at a time.
 */

const API = 'https://api.elevenlabs.io';
export const OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_KEY_FILE = '~/.config/tessera/elevenlabs.env';
const RETRIES = 4;

const expand = (p: string) => (p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p));

export function keyIn(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (m) return m[1]!;
  }
  const bare = text.trim();
  return /^[A-Za-z0-9_-]{20,}$/.test(bare) ? bare : null;
}

function readKey(): string {
  const file = expand(process.env.ELEVENLABS_KEY_FILE ?? DEFAULT_KEY_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`No ElevenLabs key file at ${file} (set ELEVENLABS_KEY_FILE to its path).`);
  }
  const key = keyIn(text);
  if (!key) throw new Error(`${file} holds no ElevenLabs key.`);
  return key;
}

async function failure(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const j = JSON.parse(body) as { detail?: { message?: string; status?: string } | string };
    const d = j.detail;
    const said = typeof d === 'string' ? d : (d?.message ?? d?.status);
    if (said) return `ElevenLabs ${String(res.status)}: ${said}`;
  } catch {}
  return `ElevenLabs ${String(res.status)}: ${body.slice(0, 200)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function elevenLabs(): TtsVendor {
  let key: string | null = null;
  const headers = () => {
    key ??= readKey();
    return { 'xi-api-key': key };
  };
  let rates: Promise<Map<string, number>> | null = null;
  const multipliers = () =>
    (rates ??= (async () => {
      const res = await fetch(`${API}/v1/models`, { headers: headers() });
      if (!res.ok) throw new Error(await failure(res));
      const models = (await res.json()) as { model_id: string; model_rates?: { character_cost_multiplier?: number } }[];
      return new Map(models.map((m) => [m.model_id, m.model_rates?.character_cost_multiplier ?? 1]));
    })());

  return {
    id: 'elevenlabs',
    credit: 'Voices by ElevenLabs',

    async quota(): Promise<Quota> {
      const res = await fetch(`${API}/v1/user/subscription`, { headers: headers() });
      if (!res.ok) throw new Error(await failure(res));
      const s = (await res.json()) as {
        tier: string;
        character_count: number;
        character_limit: number;
        next_character_count_reset_unix?: number | null;
      };
      return {
        plan: s.tier,
        used: s.character_count,
        limit: s.character_limit,
        resetsAt: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000) : null,
      };
    },

    async costOf(text: string, model: string): Promise<number> {
      const m = (await multipliers()).get(model);
      if (m === undefined) throw new Error(`ElevenLabs has no model ${model}.`);
      return text.length * m;
    },

    async speak(req: SpeakRequest): Promise<Speech> {
      const url = `${API}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}?output_format=${OUTPUT_FORMAT}`;
      const body = JSON.stringify({
        text: req.text,
        model_id: req.model,
        voice_settings: req.settings,
        seed: req.seed,
        language_code: req.language,
      });
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { ...headers(), 'content-type': 'application/json', accept: 'audio/mpeg' },
          body,
        });
        if (res.status === 429 && attempt < RETRIES) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        if (!res.ok) throw new Error(await failure(res));
        const charged = res.headers.get('character-cost') ?? res.headers.get('x-character-count');
        return {
          audio: new Uint8Array(await res.arrayBuffer()),
          ext: 'mp3',
          charged: charged !== null && Number.isFinite(Number(charged)) ? Number(charged) : null,
          requestId: res.headers.get('request-id') ?? res.headers.get('x-request-id'),
        };
      }
    },
  };
}
