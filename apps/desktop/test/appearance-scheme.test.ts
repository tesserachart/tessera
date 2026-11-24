import { afterEach, describe, expect, it } from 'vitest';
import { read } from '../src/app/store.ts';
import { keptChoice, modeRows, shownNowWords, themeOptions, whenShownWords } from '../src/areas/settings/themes.ts';
import { followScheme } from '../src/theme/follow.ts';
import { resolveTheme } from '../src/theme/resolve.ts';
import { flipTo, readScheme, showChange, themeFor, wantedMode, type Flip } from '../src/theme/scheme.ts';
import {
  installSystemMode,
  installWindowAppearance,
  setSystemMode,
  setThemeSettings,
  themeStore,
} from '../src/theme/store.ts';

const NIGHT = { id: 'th-1', name: 'Night Desk', theme: { preset: 'nord', surfaces: { ground: '#20242c' } } };
const DAY = { id: 'th-2', name: 'Day Desk', theme: { preset: 'solarized-light' } };

afterEach(() => {
  setThemeSettings({ active: {}, saved: {}, scheme: {} });
  setSystemMode('dark');
});

function fakeQuery(dark: boolean) {
  const heard = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => heard.add(fn),
    removeEventListener: (_: string, fn: () => void) => heard.delete(fn),
  };
  return {
    query: query as unknown as MediaQueryList,
    flip(next: boolean) {
      query.matches = next;
      for (const fn of heard) fn();
    },
    listeners: () => heard.size,
  };
}

function writer() {
  const flips: Flip[] = [];
  const write = (flip: Flip) => {
    flips.push(flip);
    const s = read(themeStore);
    setThemeSettings({ scheme: { ...s.scheme, appearance: s.scheme.appearance, ...flip.keep } });
    const { reset: _reset, ...shown } = flip.show;
    setThemeSettings({ active: shown });
    return Promise.resolve();
  };
  return { flips, write };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe('Light, Dark or System', () => {
  it('starts dark on Tessera, with Tessera Light kept for light', () => {
    const s = readScheme({});
    expect(s).toEqual({ appearance: 'dark', dark: {}, light: { preset: 'tessera-light' } });
    expect(resolveTheme(s.light).mode).toBe('light');
    expect(readScheme({ appearance: 'dim', dark: 'x' })).toEqual(s);
    expect(wantedMode('system', 'light')).toBe('light');
    expect(wantedMode('dark', 'light')).toBe('dark');
  });

  it('keeps the theme shown for its mode and shows the other mode’s', () => {
    const shown = { mode: 'dark' as const, value: NIGHT.theme, link: NIGHT, savedThemes: [NIGHT, DAY] };
    const scheme = readScheme({ light: { saved: 'th-2' } });
    expect(flipTo('dark', shown, scheme)).toBeNull();
    expect(flipTo('light', shown, scheme)).toEqual({ keep: { dark: { saved: 'th-1' } }, show: { saved: 'th-2' } });
    const own = { mode: 'dark' as const, value: { ink: { t2: '#c0c8d0' } }, link: null, savedThemes: [] };
    expect(flipTo('light', own, readScheme({}))).toEqual({
      keep: { dark: { ink: { t2: '#c0c8d0' } } },
      show: { reset: true, preset: 'tessera-light' },
    });
    expect(showChange({})).toEqual({ reset: true });
  });

  it('falls back to Tessera Light or Tessera when a mode’s theme is gone or not of that mode', () => {
    expect(themeFor(readScheme({ light: { saved: 'gone' } }), 'light', [DAY])).toEqual({ preset: 'tessera-light' });
    expect(themeFor(readScheme({ light: { preset: 'nord' } }), 'light', [])).toEqual({ preset: 'tessera-light' });
    expect(themeFor(readScheme({ dark: { saved: 'th-2' } }), 'dark', [DAY])).toEqual({});
    expect(themeFor(readScheme({ dark: { saved: 'th-1' } }), 'dark', [NIGHT])).toEqual({ saved: 'th-1' });
  });

  it('follows the computer live under System, and only then', async () => {
    const os = fakeQuery(true);
    const offSystem = installSystemMode(os.query);
    const { flips, write } = writer();
    const off = followScheme(write);
    expect(flips).toEqual([]);
    os.flip(false);
    await settle();
    expect(read(themeStore).resolved.mode).toBe('dark');
    setThemeSettings({ scheme: { appearance: 'system' } });
    await settle();
    expect(read(themeStore).resolved.preset).toBe('tessera-light');
    expect(read(themeStore).scheme.dark).toEqual({});
    setThemeSettings({ active: { preset: 'tessera-light', accents: { teal: '#005f8f' } } });
    os.flip(true);
    await settle();
    expect(read(themeStore).resolved.preset).toBe('tessera');
    expect(read(themeStore).scheme.light).toEqual({ preset: 'tessera-light', accents: { teal: '#005f8f' } });
    os.flip(false);
    await settle();
    expect(read(themeStore).resolved.overridden.has('accents.teal')).toBe(true);
    expect(flips).toHaveLength(3);
    off();
    offSystem();
    expect(os.listeners()).toBe(0);
  });

  it('settles on the last mode asked for when asked twice before the first write lands', async () => {
    const flips: Flip[] = [];
    let land: () => void = () => undefined;
    const off = followScheme((flip) => {
      flips.push(flip);
      return new Promise<void>((done) => {
        land = () => {
          setThemeSettings({ active: flip.show.preset ? { preset: flip.show.preset } : {} });
          done();
        };
      });
    });
    setThemeSettings({ scheme: { appearance: 'light' } });
    setThemeSettings({ scheme: { appearance: 'dark' } });
    land();
    await settle();
    land();
    await settle();
    expect(read(themeStore).resolved.mode).toBe('dark');
    expect(flips.map((f) => f.show)).toEqual([{ reset: true, preset: 'tessera-light' }, { reset: true }]);
    off();
  });

  it('lets the window frame follow the computer under System', async () => {
    const calls: (string | null)[] = [];
    const off = installWindowAppearance({
      setAppearance: (mode) => {
        calls.push(mode);
        return Promise.resolve();
      },
    });
    setThemeSettings({ scheme: { appearance: 'system' } });
    setThemeSettings({ scheme: { appearance: 'light' }, active: { preset: 'tessera-light' } });
    await Promise.resolve();
    expect(calls).toEqual(['dark', null, 'light']);
    off();
  });
});

describe('the Appearance page’s mode rows', () => {
  it('offers each row only its mode’s themes, and the shown row the theme shown', () => {
    const saved = [NIGHT, DAY];
    const light = themeOptions(saved, 'light').map((o) => o.value);
    expect(light).toEqual(['builtin:tessera-light', 'builtin:solarized-light', 'builtin:gruvbox-light', 'saved:th-2']);
    expect(themeOptions(saved, 'dark').map((o) => o.value)).not.toContain('builtin:tessera-light');
    expect(themeOptions([], 'light', 'builtin:tessera').map((o) => o.value)).toContain('builtin:tessera');
    const rows = modeRows('dark', 'saved:th-1', readScheme({ light: { saved: 'th-2' } }), saved);
    expect(rows).toEqual([
      { mode: 'dark', shown: true, choice: 'saved:th-1' },
      { mode: 'light', shown: false, choice: 'saved:th-2' },
    ]);
    expect(keptChoice({}, [])).toBe('builtin:tessera');
    expect(whenShownWords('system', 'light')).toBe('Shown while your computer is in light mode.');
    expect(whenShownWords('dark', 'light')).toBe('Shown when Appearance is Light.');
    expect(shownNowWords(resolveTheme({}), null)).toBe('Shown now');
    expect(shownNowWords(resolveTheme({ preset: 'tessera-light', ink: { t2: '#2a3f52' } }), null)).toBe(
      'Shown now · 1 colour of your own over Tessera Light',
    );
  });
});
