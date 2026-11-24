import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cx } from '../src/cx.ts';
import { THEME_KEYS } from '../src/theme.ts';
import { EASE, MOTION, TOKENS, TOKEN_VARS, type TokenName } from '../src/tokens.ts';

const stylesDir = join(import.meta.dirname, '../src/styles');
const read = (f: string) => readFileSync(join(stylesDir, f), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokensCss = strip(read('tokens.css'));
const themeBlock = /@theme static\s*\{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? '';
const rootBlock = themeBlock + (/\n:root\s*\{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? '');
const aliasBlock = strip(read('legacy-tokens.css'));

function decl(name: string, css = rootBlock): string | undefined {
  return new RegExp(`(?:^|[;\\s{])${name}:\\s*([^;]+);`).exec(css)?.[1]?.replace(/\s+/g, ' ').trim();
}
const norm = (v: string) =>
  v.replace(/\s+/g, ' ').replace(/"/g, "'").replace(/\b0\./g, '.').replace(/,\s*/g, ', ').toLowerCase();
const px = (v: string | undefined) => Number.parseFloat(v ?? 'NaN');

function luminance(v: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(v)?.[1];
  if (!hex) throw new Error(`not a hex colour: ${v}`);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

describe('tokens', () => {
  it('TOKENS mirrors tokens.css, so the canvas paints what the stylesheets paint', () => {
    for (const name of Object.keys(TOKENS) as TokenName[]) {
      expect(norm(decl(TOKEN_VARS[name]) ?? '(missing)'), name).toBe(norm(TOKENS[name]));
    }
  });

  it('MOTION and EASE mirror tokens.css, so scripted motion keeps time with CSS motion', () => {
    for (const [k, v] of [
      ['armMs', '--dur-arm'],
      ['riseMs', '--dur-rise'],
      ['seamMs', '--dur-seam'],
      ['litMs', '--dur-lit'],
      ['drainMs', '--dur-drain'],
      ['fadeMs', '--dur-fade'],
      ['panelInMs', '--dur-panel-in'],
      ['panelOutMs', '--dur-panel-out'],
      ['menuMs', '--dur-menu'],
      ['menuOutMs', '--dur-menu-out'],
      ['pressMs', '--dur-press'],
      ['tipMs', '--dur-tip'],
    ] as const) {
      expect(MOTION[k], k).toBe(px(decl(v)));
    }
    expect(EASE.out).toBe(decl('--ease-out'));
    expect(EASE.outStrong).toBe(decl('--ease-out-strong'));
    expect(EASE.inOut).toBe(decl('--ease-in-out'));
  });

  it('keeps text readable: 4.5:1 on every surface, candles 3:1 on the ground', () => {
    const surfaces = [TOKENS.ink, TOKENS.panel, TOKENS.raise];
    for (const ground of surfaces)
      for (const name of ['t1', 't2', 't3', 'up', 'down', 'aqua', 'brass'] as const)
        expect(contrast(TOKENS[name], ground), `${name} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(TOKENS.t1, TOKENS.teal), 'primary button label').toBeGreaterThanOrEqual(4.5);
    expect(contrast(TOKENS.t1, TOKENS.petrol), 'text on teal deep').toBeGreaterThanOrEqual(4.5);
    for (const name of ['up', 'down'] as const)
      expect(contrast(TOKENS[name], TOKENS.ink), name).toBeGreaterThanOrEqual(3);
  });

  it('defines every variable the stylesheets read', () => {
    const files = [
      'tokens.css',
      'legacy-tokens.css',
      'legacy.css',
      'base.css',
      'components.css',
      'primitives.css',
      'controls.css',
      'color.css',
      'legacy-components.css',
    ];
    const defined = new Set(
      files.flatMap((f) => [...strip(read(f)).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!)),
    );
    const inline = new Set(['--at', '--lo', '--hi', '--used', '--lad-cols', '--chars', '--c', '--hue']);
    for (const f of files) {
      for (const m of strip(read(f)).matchAll(/var\((--[a-z0-9-]+)\)/g)) {
        expect(defined.has(m[1]!) || inline.has(m[1]!), `${f}: ${m[1]!}`).toBe(true);
      }
    }
  });

  it('maps every v4 name the unported screens read onto a v5 role, and never shadows one', () => {
    const legacy = strip(read('legacy.css'));
    const v5 = new Set([...(tokensCss + aliasBlock).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    for (const m of legacy.matchAll(/(--[a-z0-9-]+):\s*var\((--[a-z0-9-]+)\)/g)) {
      expect(v5.has(m[2]!), `${m[1]!} → ${m[2]!}`).toBe(true);
    }
    const root = new Set([...rootBlock.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    for (const m of legacy.matchAll(/(--[a-z0-9-]+)\s*:/g)) expect(root.has(m[1]!), m[1]).toBe(false);
  });
});

describe('the Tailwind theme', () => {
  it('lists every theme name for class merging', () => {
    const names = [...themeBlock.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]!).filter((n) => !n.includes('--'));
    const prefix = {
      color: 'color-',
      text: 'text-',
      spacing: 'spacing-',
      font: 'font-',
      fontWeight: 'font-weight-',
      tracking: 'tracking-',
      radius: 'radius-',
      shadow: 'shadow-',
      ease: 'ease-',
    } as const;
    for (const [group, start] of Object.entries(prefix) as [keyof typeof prefix, string][]) {
      const longer = Object.values(prefix).filter((p) => p.length > start.length && p.startsWith(start));
      const own = names.filter((n) => n.startsWith(start) && !longer.some((p) => n.startsWith(p)));
      expect([...THEME_KEYS[group]], group).toEqual(own.map((n) => n.slice(start.length)));
    }
  });

  it('merges classes by what they set, so a caller’s class wins over the component’s', () => {
    expect(cx('text-body text-t1', 'text-meta')).toBe('text-t1 text-meta');
    expect(cx('h-row', 'h-control')).toBe('h-control');
    expect(cx('font-sans font-em', 'font-serif')).toBe('font-em font-serif');
    expect(cx('shadow-ring', 'shadow-fall-off')).toBe('shadow-fall-off');
    expect(cx('bg-ink', false, 'bg-raise')).toBe('bg-raise');
  });
});

describe('assets', () => {
  it('ships every font the sheets load, with its licence', () => {
    for (const m of read('fonts.css').matchAll(/url\('([^']+)'\)/g))
      expect(existsSync(join(stylesDir, m[1]!)), m[1]).toBe(true);
    const fontsDir = join(import.meta.dirname, '../fonts');
    for (const ofl of [
      'InstrumentSerif-OFL.txt',
      'InstrumentSans-OFL.txt',
      'TesseraFigures-OFL.txt',
      'TesseraKeys-OFL.txt',
    ]) {
      expect(readFileSync(join(fontsDir, ofl), 'utf8'), ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
    }
  });

  it('generates the icons from the lab’s sprite, and the generated file is fresh', () => {
    const root = join(import.meta.dirname, '..');
    expect(() =>
      execFileSync(process.execPath, [join(root, 'scripts/build-icons.mjs'), '--check'], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});

describe('the press', () => {
  const css = strip(read('base.css'));
  const at = css.indexOf('):where(:active:not(:focus-visible))');
  const from = css.lastIndexOf('}', at) + 1;
  const resting = css
    .slice(from, at + 1)
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim();
  const make = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild!;
  };

  it('gives a button under the pointer, never a row, a row-like button or a place in a set', () => {
    expect(resting.startsWith(':where(button')).toBe(true);
    expect(make('<button type="button">Save</button>').matches(resting)).toBe(true);
    for (const html of [
      '<button type="button" role="row">Session</button>',
      '<button type="button" role="treeitem">Folder</button>',
      '<button type="button" role="tab">Trade</button>',
      '<button type="button" role="option">QQQ</button>',
      '<button type="button" role="menuitemradio">5m</button>',
      '<button type="button" data-press="none">Paper</button>',
      '<button type="button" aria-current="true">Here</button>',
      '<button type="button" disabled>Off</button>',
    ]) {
      expect(make(html).matches(resting), html).toBe(false);
    }
  });
});
