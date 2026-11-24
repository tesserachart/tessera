import { VOICE_OFF } from '../settings.ts';
import { fallbackChain, type VoiceLineId } from './lines.ts';
import { parseManifest, type PackClip, type PackManifest } from './manifest.ts';

export const DEFAULT_VOICE = 'daniel';

export interface VoiceClip extends PackClip {
  url: string;
}

export interface VoicePack {
  manifest: PackManifest;
  clips: Partial<Record<VoiceLineId, VoiceClip>>;
}

export function packsFrom(
  manifests: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): VoicePack[] {
  const out: VoicePack[] = [];
  for (const [path, raw] of Object.entries(manifests)) {
    const dir = /\/packs\/([^/]+)\/manifest\.json$/.exec(path)?.[1];
    const manifest = parseManifest(raw);
    if (!manifest || manifest.id !== dir) continue;
    const clips: Partial<Record<VoiceLineId, VoiceClip>> = {};
    for (const [line, clip] of Object.entries(manifest.lines) as [VoiceLineId, PackClip][]) {
      const url = files[path.replace(/manifest\.json$/, clip.file)];
      if (url) clips[line] = { ...clip, url };
    }
    if (Object.keys(clips).length > 0) out.push({ manifest, clips });
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function packFor(voice: string | null, packs: readonly VoicePack[]): VoicePack | null {
  if (voice === VOICE_OFF || packs.length === 0) return null;
  const find = (id: string | null) => packs.find((p) => p.manifest.id === id);
  return find(voice) ?? find(DEFAULT_VOICE) ?? packs[0]!;
}

export function clipFor(pack: VoicePack, line: VoiceLineId): { line: VoiceLineId; clip: VoiceClip } | null {
  for (const id of fallbackChain(line)) {
    const clip = pack.clips[id];
    if (clip) return { line: id, clip };
  }
  return null;
}

export function creditsOf(packs: readonly VoicePack[]): string[] {
  return [...new Set(packs.map((p) => p.manifest.vendor.credit))];
}
