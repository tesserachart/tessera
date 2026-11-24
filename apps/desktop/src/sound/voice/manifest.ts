import { VOICE_LINE_IDS, type VoiceLineId } from './lines.ts';

export const MANIFEST_SCHEMA = 1;

export interface PackClip {
  file: string;
  text: string;
  durationMs: number;
  lufs: number;
}

interface PackVendor {
  id: string;
  voiceId: string;
  model: string;
  /** A free plan's clips are not licensed for a product that is sold. */
  plan: string;
  commercialUse: boolean;
  credit: string;
}

export interface PackManifest {
  schema: typeof MANIFEST_SCHEMA;
  id: string;
  name: string;
  about: string;
  vendor: PackVendor;
  generated: string;
  lines: Partial<Record<VoiceLineId, PackClip>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const KNOWN: ReadonlySet<string> = new Set(VOICE_LINE_IDS);

function clipOf(v: unknown): PackClip | null {
  if (!isRecord(v) || !str(v.file) || !str(v.text) || !num(v.durationMs) || !num(v.lufs)) return null;
  if (!/^[a-z0-9_]+\.(mp3|m4a|ogg|wav)$/.test(v.file)) return null;
  return { file: v.file, text: v.text, durationMs: v.durationMs, lufs: v.lufs };
}

function vendorOf(v: unknown): PackVendor | null {
  if (!isRecord(v) || !str(v.id) || !str(v.voiceId) || !str(v.model) || !str(v.plan) || !str(v.credit)) return null;
  if (typeof v.commercialUse !== 'boolean') return null;
  return {
    id: v.id,
    voiceId: v.voiceId,
    model: v.model,
    plan: v.plan,
    commercialUse: v.commercialUse,
    credit: v.credit,
  };
}

export function parseManifest(v: unknown): PackManifest | null {
  if (!isRecord(v) || v.schema !== MANIFEST_SCHEMA) return null;
  if (!str(v.id) || !/^[a-z0-9-]+$/.test(v.id) || !str(v.name) || typeof v.about !== 'string') return null;
  const vendor = vendorOf(v.vendor);
  if (!vendor || typeof v.generated !== 'string' || !isRecord(v.lines)) return null;
  const lines: Partial<Record<VoiceLineId, PackClip>> = {};
  for (const [line, raw] of Object.entries(v.lines)) {
    if (!KNOWN.has(line)) continue;
    const clip = clipOf(raw);
    if (clip) lines[line as VoiceLineId] = clip;
  }
  return { schema: MANIFEST_SCHEMA, id: v.id, name: v.name, about: v.about, vendor, generated: v.generated, lines };
}
