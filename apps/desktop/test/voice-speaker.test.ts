import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

interface Played {
  tones: number;
  clips: string[];
}

function fakeAudio(played: Played, decodes: boolean, decoding: Promise<unknown>[]) {
  const param = () => ({
    value: 0,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
    exponentialRampToValueAtTime: () => undefined,
  });
  const node = () => ({ gain: param(), connect: () => undefined, disconnect: () => undefined });
  return class {
    state = 'running';
    currentTime = 0;
    destination = {};
    createGain = node;
    createOscillator = () => ({
      ...node(),
      type: 'sine',
      frequency: param(),
      onended: null,
      start: () => {
        played.tones += 1;
      },
      stop: () => undefined,
    });
    createBufferSource = () => {
      const src = {
        ...node(),
        buffer: null as { url: string } | null,
        onended: null,
        start: () => played.clips.push(src.buffer?.url ?? '?'),
        stop: () => undefined,
      };
      return src;
    };
    decodeAudioData = (bytes: ArrayBuffer) => {
      const decoded = decodes
        ? Promise.resolve({ duration: 1.2, url: new TextDecoder().decode(bytes) })
        : Promise.reject(new Error('cannot decode'));
      decoding.push(decoded);
      return decoded;
    };
    resume = () => Promise.resolve();
  };
}

const g = globalThis as { AudioContext?: unknown; fetch: typeof fetch };
const had = { AudioContext: g.AudioContext, fetch: g.fetch };

const broken = (): never => {
  throw new Error('the audio failed');
};

async function load(settings: Record<string, unknown>, decodes = true, fails = false) {
  const played: Played = { tones: 0, clips: [] };
  const decoding: Promise<unknown>[] = [];
  const Audio = fakeAudio(played, decodes, decoding);
  g.AudioContext = fails
    ? class extends Audio {
        override createOscillator = broken;
        override createBufferSource = broken;
      }
    : Audio;
  g.fetch = ((url: string) => Promise.resolve(new Response(url))) as typeof fetch;
  vi.resetModules();
  const rs = await import('../src/state/runtimeSettings.ts');
  rs.putRuntimeSettings({ sounds: settings }, true);
  const speaker = await import('../src/sound/voice/speaker.ts');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const primed = async () => {
    const clips = new Set(Object.values(speaker.voicePack()?.clips ?? {}).map((clip) => clip.url));
    await vi.waitFor(() => expect(decoding).toHaveLength(clips.size));
    await Promise.allSettled(decoding);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { played, speaker, primed };
}

async function warmModuleGraph(): Promise<void> {
  await import('../src/sound/voice/speaker.ts');
}

beforeAll(warmModuleGraph, 60_000);

afterEach(() => {
  vi.useRealTimers();
  g.AudioContext = had.AudioContext;
  g.fetch = had.fetch;
});

describe('the speaker', () => {
  it('with tones alone plays a line’s tone at once, as always, and nothing for a line without one', async () => {
    const { played, speaker } = await load({ voice: 'off' });
    speaker.announce('limit_filled');
    expect(played.tones).toBe(1);
    speaker.announce('order_cancelled');
    speaker.announce('position_closed');
    await vi.advanceTimersByTimeAsync(5000);
    expect(played).toEqual({ tones: 1, clips: [] });
  });

  it('with a voice says a burst’s best line once, after a moment, in the default voice', async () => {
    const { played, speaker, primed } = await load({});
    speaker.primeVoice();
    await primed();
    speaker.announce('limit_filled');
    speaker.announce('order_cancelled');
    speaker.announce('position_closed');
    expect(played.clips).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(played.clips).toHaveLength(1);
    expect(played.clips[0]).toMatch(/packs\/daniel\/position_closed\.mp3/);
    await vi.advanceTimersByTimeAsync(5000);
    expect(played).toMatchObject({ tones: 0 });
    expect(played.clips).toHaveLength(1);
  });

  it('falls back to the tone when the voice’s clip will not decode', async () => {
    const { played, speaker, primed } = await load({ voice: 'sarah' }, false);
    speaker.primeVoice();
    await primed();
    speaker.announce('stop_hit');
    await vi.advanceTimersByTimeAsync(200);
    expect(played).toEqual({ tones: 2, clips: [] });
  });

  it('never throws for a sound the audio fails to make', async () => {
    const { speaker, primed } = await load({}, true, true);
    const sound = await import('../src/sound/index.ts');
    speaker.primeVoice();
    await primed();
    expect(() => speaker.announce('limit_filled')).not.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(() => sound.playSound('fill')).not.toThrow();
    expect(() => sound.previewSound('fill')).not.toThrow();
  });

  it('says nothing muted or with the event switched off', async () => {
    const { played, speaker } = await load({ muted: true });
    speaker.announce('limit_filled');
    await vi.advanceTimersByTimeAsync(500);
    expect(played).toEqual({ tones: 0, clips: [] });
    vi.useRealTimers();
    const off = await load({ events: { cancelled: false } });
    off.speaker.announce('order_cancelled');
    await vi.advanceTimersByTimeAsync(500);
    expect(off.played).toEqual({ tones: 0, clips: [] });
  });
});
