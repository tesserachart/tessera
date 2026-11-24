import { useEffect } from 'react';
import { read, watch } from '../app/store.ts';
import { runtimeSettingsStore } from '../state/runtimeSettings.ts';
import { writeFlip } from './actions.ts';
import { flipTo, type Flip } from './scheme.ts';
import { themeStore, type ThemeState } from './store.ts';
import type { ThemeMode } from './resolve.ts';

const flipOf = (s: ThemeState): Flip | null =>
  flipTo(s.wanted, { mode: s.resolved.mode, value: s.value, link: s.link, savedThemes: s.savedThemes }, s.scheme);

export function followScheme(write: (flip: Flip) => Promise<void>): () => void {
  let last: ThemeMode | null = null;
  let running = false;
  let asked = 0;
  const run = async () => {
    asked += 1;
    if (running) return;
    running = true;
    try {
      for (let done = 0; done !== asked;) {
        done = asked;
        const flip = flipOf(read(themeStore));
        if (flip) await write(flip);
      }
    } catch (error: unknown) {
      console.warn('[theme] stayed in its mode', error);
    } finally {
      running = false;
    }
  };
  const heard = (s: ThemeState) => {
    if (s.wanted === last) return;
    last = s.wanted;
    void run();
  };
  heard(read(themeStore));
  return watch(themeStore, heard);
}

export function useFollowScheme(): void {
  useEffect(() => {
    let off: () => void = () => undefined;
    let stopped = false;
    const begin = () => {
      if (!stopped) off = followScheme(writeFlip);
    };
    const offLoaded = watch(runtimeSettingsStore, (s) => {
      if (!s.loaded) return;
      offLoaded();
      queueMicrotask(begin);
    });
    if (read(runtimeSettingsStore).loaded) {
      offLoaded();
      queueMicrotask(begin);
    }
    return () => {
      stopped = true;
      offLoaded();
      off();
    };
  }, []);
}
