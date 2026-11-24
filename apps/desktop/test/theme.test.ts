import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { THEME_TABLES } from '@tessera/protocol';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { read } from '../src/app/store.ts';
import { chartThemeOf } from '../src/chart/chartTheme.ts';
import { THEME_CSS_VARS, cssVarsOf, type ThemeCssVar } from '../src/theme/cssVars.ts';
import { contrast, parseHex } from '../src/theme/colour.ts';
import { BUILT_INS, effectiveTheme, resolveTheme } from '../src/theme/resolve.ts';
import { installTheme, installWindowAppearance, setThemeSettings, themeStore } from '../src/theme/store.ts';
import {
  changeFor,
  choiceOf,
  readThemeFile,
  themeFile,
  themeOptions,
  themeRefusal,
  themeWords,
  upDownOwnWords,
} from '../src/areas/settings/themes.ts';
import { appCss } from './support/appCss.ts';

const repo = join(import.meta.dirname, '../../..');
const tokensCss = readFileSync(join(repo, 'packages/ui/src/styles/tokens.css'), 'utf8');
const themeBlock = /@theme static\s*\{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? '';
const declared = new Map(
  [...themeBlock.matchAll(/^\s*(--color-[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]),
);

function rgba(v: string): number[] {
  const hex = parseHex(v);
  if (hex) return [hex[0], hex[1], hex[2], Math.round((hex[3] / 255) * 100) / 100];
  const n = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(v);
  if (!n) return [Number.NaN];
  return [Number(n[1]), Number(n[2]), Number(n[3]), Math.round(Number(n[4] ?? 1) * 100) / 100];
}

const html = document.documentElement;
const custom = (name: string) => html.style.getPropertyValue(name).trim();

afterEach(() => setThemeSettings({ active: {}, saved: {} }));

describe('one theme for the whole app', () => {
  it('declares every colour token from the theme, and the stylesheet’s own values are Tessera’s', () => {
    const tessera = cssVarsOf(resolveTheme({}));
    expect([...declared.keys()].filter((name) => !(name in THEME_CSS_VARS))).toEqual([]);
    expect(Object.keys(THEME_CSS_VARS).filter((name) => !declared.has(name))).toEqual([]);
    for (const [name, value] of declared) {
      const own = value.startsWith('var(') ? (declared.get(value.slice(4, -1)) ?? value) : value;
      expect(rgba(own), name).toEqual(rgba(tessera[name as ThemeCssVar]));
    }
  });

  it('puts no colour in a stylesheet or a component that the theme does not give it', () => {
    const allowed = new Map([
      ['packages/ui/src/styles/tokens.css', 'Tessera’s values, pinned to the theme above'],
      ['packages/ui/src/tokens.ts', 'the token table, pinned to tokens.css'],
      ['packages/ui/src/styles/color.css', 'the colour picker’s hue and shade planes'],
      ['packages/ui/src/components/ColorPicker.tsx', 'colours offered to pick'],
      ['apps/desktop/src/areas/journal/sections/Settings.tsx', 'colours offered for a journal tag'],
      [
        'apps/desktop/src/areas/journal/sections/samples.ts',
        'stand-in records: a tag’s and a setup’s own stored colour',
      ],
      ['apps/desktop/src/analyst/imageShrink.ts', 'the white a pasted image is flattened onto'],
    ]);
    const literal = /#[0-9a-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/i;
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(css|tsx?)$/.test(name)) {
          const rel = relative(repo, path);
          if (allowed.has(rel)) continue;
          readFileSync(path, 'utf8')
            .split('\n')
            .forEach((line, i) => {
              const code = line.replace(/\b(?:href|src|url)=?\s*['"(][^'")]*['")]/g, '');
              if (literal.test(code) && !/&#x?[0-9a-f]+;/i.test(code)) found.push(`${rel}:${String(i + 1)}`);
            });
        }
      }
    };
    walk(join(repo, 'apps/desktop/src'));
    walk(join(repo, 'packages/ui/src'));
    expect(found).toEqual([]);
  });

  it('keeps Tessera the default and lists the five built-in families first', () => {
    expect(read(themeStore).resolved.preset).toBe('tessera');
    expect(BUILT_INS.map((t) => t.id)).toEqual([
      'tessera',
      'tessera-light',
      'solarized-dark',
      'solarized-light',
      'night-owl',
      'nord',
      'gruvbox-dark',
      'gruvbox-light',
    ]);
    expect(new Set(BUILT_INS.map((t) => t.family)).size).toBe(5);
    const options = themeOptions([{ id: 'th-1', name: 'Night Desk', theme: { preset: 'nord' } }]);
    expect(options.map((o) => o.group)).toEqual([...BUILT_INS.map(() => 'Built-in'), 'Saved']);
    expect(options.at(-1)).toEqual({ value: 'saved:th-1', label: 'Night Desk', group: 'Saved', hint: 'Dark' });
  });

  it('inks a light axis tag dark and a dark one light, whichever the ground', () => {
    const light = chartThemeOf(resolveTheme({ preset: 'solarized-light' }));
    expect([light.tagInk, light.tagInkLight]).toEqual(['#073642', '#fdf6e3']);
    const dark = chartThemeOf(resolveTheme({}));
    expect([dark.tagInk, dark.tagInkLight]).toEqual(['#05080b', '#e8eef3']);
  });

  it('gives every built-in readable text on every surface, and a mode that follows its colours', () => {
    for (const t of BUILT_INS) {
      const r = resolveTheme({ preset: t.id });
      expect(r.mode, t.id).toBe(t.mode);
      for (const fg of THEME_TABLES.textKeys)
        for (const bg of THEME_TABLES.textSurfaces)
          expect(contrast(r.colors[fg]!, r.colors[bg]!), `${t.id} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('a theme switch', () => {
  beforeAll(async () => {
    const style = document.createElement('style');
    style.textContent = await appCss();
    document.head.append(style);
  });

  it('repaints every themed property and the page’s colour scheme at once, no reload', () => {
    const off = installTheme(html);
    expect(custom('--color-ink')).toBe('#05080b');
    expect(html.style.colorScheme).toBe('dark');
    setThemeSettings({ active: { preset: 'solarized-light' } });
    const light = cssVarsOf(resolveTheme({ preset: 'solarized-light' }));
    for (const name of Object.keys(THEME_CSS_VARS) as ThemeCssVar[]) expect(custom(name), name).toBe(light[name]);
    expect(custom('--color-ink')).toBe('#fdf6e3');
    expect(custom('--color-t1')).toBe('#073642');
    expect([html.style.colorScheme, html.dataset.mode]).toEqual(['light', 'light']);
    const menu = document.createElement('div');
    menu.className = 't-menu';
    document.body.append(menu);
    expect(getComputedStyle(menu).backgroundColor).toBe(light['--color-menu']);
    menu.remove();
    setThemeSettings({ active: { preset: 'night-owl' } });
    expect(custom('--color-ink')).toBe('#011627');
    expect(html.style.colorScheme).toBe('dark');
    off();
  });

  it('shows a saved theme, and every change it takes shows too', () => {
    const off = installTheme(html);
    const saved = {
      themes: [{ id: 'th-1', name: 'Night Desk', theme: { preset: 'nord', surfaces: { ground: '#20242c' } } }],
    };
    setThemeSettings({ saved, active: { saved: 'th-1' } });
    expect(custom('--color-ink')).toBe('#20242c');
    expect(custom('--color-panel')).toBe('#333a47');
    const s = read(themeStore);
    expect(s.link?.name).toBe('Night Desk');
    expect(choiceOf(s.resolved, s.link)).toBe('saved:th-1');
    expect(themeWords(s.resolved, s.link)).toBe('Dark · from Nord · 1 colour of your own');
    expect(effectiveTheme({ saved: 'gone', ink: { t1: '#ffffff' } }, saved).value).toEqual({ ink: { t1: '#ffffff' } });
    off();
  });

  it('tells the window frame its mode and ground', async () => {
    const calls: [string | null, string][] = [];
    const off = installWindowAppearance({
      setAppearance: (mode, bg) => {
        calls.push([mode, bg]);
        return Promise.resolve();
      },
    });
    setThemeSettings({ active: { preset: 'gruvbox-light' } });
    await Promise.resolve();
    expect(calls).toEqual([
      ['dark', '#05080b'],
      ['light', '#fbf1c7'],
    ]);
    off();
  });
});

describe('the Appearance page’s words', () => {
  it('picks a built-in or a saved theme in one change', () => {
    expect(changeFor('builtin:solarized-light')).toEqual({ preset: 'solarized-light' });
    expect(changeFor('saved:th-1')).toEqual({ saved: 'th-1' });
  });

  it('says an unreadable pair in plain words, by the colour being changed', () => {
    const m =
      'appearance.theme: unreadable text: ink.t3 #7c8b99 on surfaces.raise #7c8b99 (1.0:1), ink.t4 #7c8b99 on surfaces.raise #7c8b99 (1.0:1). Text must keep at least 4.5:1';
    expect(themeRefusal(m, 'surfaces.raise')).toBe('Too close to Quiet text to read (1.0:1; text needs 4.5:1).');
    expect(themeRefusal(m)).toBe('Quiet text would not read on Raised, and 1 more. Change Quiet text first.');
    expect(themeRefusal('appearance.theme: saved: no saved theme "x"')).toBe('Saved: no saved theme "x"');
  });

  it('exports a theme as a file that imports as it was', () => {
    const f = themeFile('Night Desk', { preset: 'nord' });
    expect(f.name).toBe('Night Desk.json');
    expect(readThemeFile(f.text, f.name)).toEqual({ name: 'Night Desk', theme: { preset: 'nord' } });
    expect(readThemeFile('{"preset":"nord"}', 'Shared.json')).toEqual({ name: 'Shared', theme: { preset: 'nord' } });
    expect(readThemeFile('not json', 'x.json')).toEqual({ problem: 'That file is not a theme.' });
  });

  it('says why the up and down choice is locked under a theme with its own pair', () => {
    expect(upDownOwnWords(resolveTheme({}))).toBeNull();
    expect(upDownOwnWords(resolveTheme({ preset: 'nord' }))).toBe('Nord has its own up and down colours.');
  });
});
