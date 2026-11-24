import { audioContext, bestEffort, whenRunning } from '../context.ts';
import { playSound, previewSound, soundsNow } from '../index.ts';
import { audible, previewGain, type SoundSettings } from '../settings.ts';
import { TONES, toneLength } from '../tones.ts';
import { BUNDLED_PACKS } from './bundled.ts';
import { VoiceDirector } from './director.ts';
import { VOICE_LINES, type VoiceLineId } from './lines.ts';
import { clipFor, packFor, type VoiceClip, type VoicePack } from './packs.ts';

const VOICE_LUFS = -22;
const MAX_GAIN = 1.25;

const director = new VoiceDirector();
let timer: ReturnType<typeof setTimeout> | null = null;
const decoded = new Map<string, AudioBuffer | null>();
const decoding = new Map<string, Promise<AudioBuffer | null>>();
let preview: AudioBufferSourceNode | null = null;

export const voicePack = (s: SoundSettings = soundsNow()): VoicePack | null => packFor(s.voice, BUNDLED_PACKS);

export const voicePacks = (): readonly VoicePack[] => BUNDLED_PACKS;

function dataBytes(url: string): ArrayBuffer | null {
  const m = /^data:[^;,]*;base64,(.*)$/.exec(url);
  if (!m) return null;
  const bin = atob(m[1]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function load(clip: VoiceClip): Promise<AudioBuffer | null> {
  const ready = decoded.get(clip.url);
  if (ready !== undefined) return Promise.resolve(ready);
  const going = decoding.get(clip.url);
  if (going) return going;
  const c = audioContext();
  if (!c) return Promise.resolve(null);
  const p = (async () => {
    try {
      const bytes = dataBytes(clip.url) ?? (await (await fetch(clip.url)).arrayBuffer());
      return await c.decodeAudioData(bytes);
    } catch {
      return null;
    }
  })().then((buf) => {
    decoded.set(clip.url, buf);
    decoding.delete(clip.url);
    return buf;
  });
  decoding.set(clip.url, p);
  return p;
}

export function primeVoice(s: SoundSettings = soundsNow()): void {
  bestEffort(() => {
    const pack = voicePack(s);
    if (pack) for (const clip of Object.values(pack.clips)) void load(clip);
  });
}

export function clipGain(clip: VoiceClip, volume: number): number {
  return Math.min(MAX_GAIN, 10 ** ((VOICE_LUFS - clip.lufs) / 20)) * volume;
}

function start(c: AudioContext, buf: AudioBuffer, gain: number): AudioBufferSourceNode {
  const src = c.createBufferSource();
  const out = c.createGain();
  src.buffer = buf;
  out.gain.value = gain;
  src.connect(out);
  out.connect(c.destination);
  src.onended = () => {
    src.disconnect();
    out.disconnect();
  };
  src.start();
  return src;
}

function sayFirst(pack: VoicePack, lines: readonly VoiceLineId[], s: SoundSettings): number | null {
  for (const line of lines) {
    const gain = audible(s, VOICE_LINES[line].event);
    if (gain <= 0) continue;
    const found = clipFor(pack, line);
    const buf = found ? decoded.get(found.clip.url) : undefined;
    if (found && buf) {
      const g = clipGain(found.clip, gain);
      whenRunning((c) => void start(c, buf, g));
      return buf.duration * 1000;
    }
    if (found && buf === undefined) void load(found.clip);
  }
  for (const line of lines) {
    const tone = VOICE_LINES[line].tone;
    if (tone && audible(s, VOICE_LINES[line].event) > 0) {
      playSound(tone);
      return toneLength(TONES[tone]) * 1000;
    }
  }
  return null;
}

function turn(): void {
  timer = null;
  bestEffort(() => {
    const now = performance.now();
    const lines = director.take(now);
    if (lines.length > 0) {
      const s = soundsNow();
      const pack = voicePack(s);
      const ms = pack ? sayFirst(pack, lines, s) : null;
      if (ms !== null) director.said(lines, now, ms);
    }
  });
  wake();
}

function wake(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const at = director.wakeAt();
  if (at !== null) timer = setTimeout(turn, Math.max(0, at - performance.now()));
}

export function announce(line: VoiceLineId): void {
  bestEffort(() => {
    const s = soundsNow();
    const def = VOICE_LINES[line];
    if (audible(s, def.event) <= 0) return;
    if (!voicePack(s)) {
      if (def.tone) playSound(def.tone);
      return;
    }
    director.offer(line, performance.now());
    wake();
  });
}

export function previewLine(line: VoiceLineId, packId?: string): void {
  bestEffort(() => {
    const s = soundsNow();
    const pack = packId === undefined ? voicePack(s) : (packFor(packId, BUNDLED_PACKS) ?? null);
    const found = pack ? clipFor(pack, line) : null;
    const tone = VOICE_LINES[line].tone;
    const gain = previewGain(s);
    if (!found) {
      if (tone) previewSound(tone);
      return;
    }
    if (gain <= 0) return;
    void load(found.clip).then((buf) => {
      if (!buf) {
        if (tone) previewSound(tone);
        return;
      }
      whenRunning((c) => {
        bestEffort(() => preview?.stop());
        preview = start(c, buf, clipGain(found.clip, gain));
      });
    });
  });
}
