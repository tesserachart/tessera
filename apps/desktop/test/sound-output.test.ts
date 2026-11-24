import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TONES } from '../src/sound/tones.ts';
import { WebKitAudio } from './support/webAudio.ts';

const HOUR = 3_600_000;
const SETTLE_MS = 5_000;
const LINE_GAP_MS = 2_300;

async function session(world = new WebKitAudio()) {
  world.install();
  vi.resetModules();
  const rs = await import('../src/state/runtimeSettings.ts');
  rs.putRuntimeSettings({ sounds: {} }, true);
  const speaker = await import('../src/sound/voice/speaker.ts');
  const sound = await import('../src/sound/index.ts');
  const otherListeners = world.gestureListenerCount();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  speaker.primeVoice();
  await world.pass(500);
  const tones = () => world.heard.filter((h) => h === 'tone').length;
  const clips = () => world.heard.filter((h) => h.startsWith('clip ')).length;
  const fill = async () => {
    const before = tones();
    sound.playSound('fill');
    await world.pass(1_000);
    return tones() - before;
  };
  const line = async () => {
    const before = clips();
    speaker.announce('limit_filled');
    await world.pass(LINE_GAP_MS);
    return clips() - before;
  };
  const listeners = () => world.gestureListenerCount() - otherListeners;
  return { world, sound, speaker, tones, clips, fill, line, listeners };
}

const mainWindow = (file: string) =>
  (
    JSON.parse(readFileSync(join(import.meta.dirname, '../src-tauri', file), 'utf8')) as {
      app: { windows: { label: string; backgroundThrottling?: string }[] };
    }
  ).app.windows.find((w) => w.label === 'main');

type Mishap = readonly [string, (w: WebKitAudio) => void];

const MISHAPS: readonly Mishap[] = [
  ['the Mac sleeps and the context wakes running', (w) => w.sleep(8 * HOUR, 'running')],
  ['the Mac sleeps and the context wakes suspended', (w) => w.sleep(8 * HOUR, 'suspended')],
  ['the Mac sleeps and the context wakes running on a clock that stands still', (w) => w.sleep(8 * HOUR, 'stalled')],
  ['the Mac sleeps and the context stays interrupted however often it is resumed', (w) => w.sleep(HOUR, 'stuck')],
  ['the output device changes and the context clock stops', (w) => w.unplugOutput()],
  ['the context is closed', (w) => w.closeContext()],
  ['WebKit suspends the hidden window for five minutes and its output dies', (w) => w.suspendHiddenPage(300_000)],
];

beforeAll(async () => {
  await import('../src/sound/voice/speaker.ts');
}, 60_000);

let world: WebKitAudio | null = null;

afterEach(() => {
  vi.useRealTimers();
  world?.uninstall();
  world = null;
});

describe('the sound output', { timeout: 120_000 }, () => {
  it('plays two thousand tones and a thousand voice lines on one context and keeps nothing behind', async () => {
    const s = await session();
    world = s.world;
    for (let i = 0; i < 2_000; i++) {
      s.sound.playSound(i % 2 === 0 ? 'fill' : 'alert');
      await s.world.pass(100);
    }
    await s.world.pass(1_000);
    expect(s.tones()).toBe(1_000 * (TONES.fill.length + TONES.alert.length));
    for (let i = 0; i < 1_000; i++) {
      s.speaker.announce(i % 2 === 0 ? 'limit_filled' : 'market_filled');
      await s.world.pass(LINE_GAP_MS, 100);
    }
    expect(s.clips()).toBe(1_000);
    expect(s.world.made).toHaveLength(1);
    expect(s.world.liveNodes()).toBe(0);
    expect(s.listeners()).toBeLessThanOrEqual(2);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });

  it.each(MISHAPS)('plays tones and voice lines again after %s', async (_, mishap) => {
    const s = await session();
    world = s.world;
    expect(await s.fill()).toBe(1);
    expect(await s.line()).toBe(1);
    mishap(s.world);
    await s.world.pass(SETTLE_MS);
    for (let i = 0; i < 20; i++) expect(await s.fill()).toBe(1);
    for (let i = 0; i < 5; i++) expect(await s.line()).toBe(1);
    expect(s.world.open).toHaveLength(1);
    expect(s.world.made.length).toBeLessThanOrEqual(2);
    expect(s.world.liveNodes()).toBe(0);
    expect(s.listeners()).toBeLessThanOrEqual(2);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });

  it.each(MISHAPS.filter(([what]) => what.startsWith('the Mac sleeps')))(
    'plays the first fill after %s',
    async (_, mishap) => {
      const s = await session();
      world = s.world;
      expect(await s.fill()).toBe(1);
      mishap(s.world);
      expect(await s.fill()).toBe(1);
    },
  );

  it('keeps playing through every mishap in turn over a long session, with one context open', async () => {
    const s = await session();
    world = s.world;
    let asked = 0;
    let heard = 0;
    for (let round = 0; round < 20; round++) {
      for (const [, mishap] of MISHAPS) {
        mishap(s.world);
        await s.world.pass(SETTLE_MS);
        for (let i = 0; i < 10; i++) {
          asked++;
          heard += await s.fill();
        }
        asked++;
        heard += await s.line();
        await s.world.pass(10 * 60_000, 1_000);
      }
    }
    expect(heard).toBe(asked);
    expect(s.world.open).toHaveLength(1);
    expect(s.world.liveNodes()).toBe(0);
    expect(s.world.made.length).toBeLessThanOrEqual(1 + 20 * MISHAPS.length);
    expect(s.listeners()).toBeLessThanOrEqual(2);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });

  it('keeps a new context whose clock takes seconds to start moving, as Chromium’s does on a busy machine', async () => {
    const w = new WebKitAudio();
    w.warmupMs = 2_500;
    const s = await session(w);
    world = s.world;
    await s.world.pass(SETTLE_MS);
    expect(s.world.made).toHaveLength(1);
    for (let i = 0; i < 5; i++) expect(await s.fill()).toBe(1);
    expect(s.world.made).toHaveLength(1);
  });

  it('replaces a context that says it is running but whose clock never starts', async () => {
    const w = new WebKitAudio();
    w.warmupMs = HOUR;
    const s = await session(w);
    world = s.world;
    w.warmupMs = 0;
    await s.world.pass(2 * SETTLE_MS);
    for (let i = 0; i < 5; i++) expect(await s.fill()).toBe(1);
    expect(s.world.made).toHaveLength(2);
  });

  it('replaces a new context that never starts once the page has had a press', async () => {
    const s = await session();
    world = s.world;
    s.world.press();
    expect(await s.fill()).toBe(1);
    s.world.brokenStarts = 1;
    s.world.closeContext();
    await s.world.pass(SETTLE_MS);
    for (let i = 0; i < 5; i++) expect(await s.fill()).toBe(1);
    expect(s.world.open).toHaveLength(1);
    expect(s.world.made).toHaveLength(3);
  });

  it('backs off while WebKit holds every new context interrupted, and plays once it lets go', async () => {
    const s = await session();
    world = s.world;
    expect(await s.fill()).toBe(1);
    s.world.holdInterruption();
    await s.world.pass(10 * 60_000, 1_000);
    expect(s.world.made.length).toBeLessThanOrEqual(20);
    s.world.endInterruption();
    await s.world.pass(SETTLE_MS);
    for (let i = 0; i < 5; i++) expect(await s.fill()).toBe(1);
    expect(await s.line()).toBe(1);
    expect(s.world.open).toHaveLength(1);
    expect(s.listeners()).toBeLessThanOrEqual(2);
  });

  it('keeps the main window’s page running while it is hidden, so WebKit never suspends the page that sounds', () => {
    expect(mainWindow('tauri.conf.json')?.backgroundThrottling).toBe('disabled');
    expect(mainWindow('tauri.macos.conf.json')?.backgroundThrottling).toBe('disabled');
  });

  it('waits at the browser’s autoplay rule for a press without making new contexts, then plays', async () => {
    const w = new WebKitAudio();
    w.autoplay = false;
    const s = await session(w);
    world = s.world;
    expect(await s.fill()).toBe(0);
    await s.world.pass(HOUR, 1_000);
    expect(s.world.made).toHaveLength(1);
    expect(s.listeners()).toBe(2);
    s.world.press();
    await s.world.pass(500);
    expect(s.listeners()).toBe(0);
    expect(await s.fill()).toBe(1);
    expect(await s.line()).toBe(1);
  });
});
