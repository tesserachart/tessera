import { render } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon, iconLabel, type IconName } from '../src/components/Icon.tsx';
import { GLYPHS, ICON_CUT_SIZES } from '../src/icons/glyphs.gen.ts';
import { cut, rectPath, subpaths } from '../scripts/icon-cuts.ts';

const SIBLINGS: readonly (readonly [IconName, IconName])[] = [
  ['lock', 'unlock'],
  ['shown', 'hidden'],
  ['pop-out', 'dock-back'],
  ['trend-line', 'ray'],
  ['profile-range', 'profile-anchored'],
  ['plus', 'cross-line'],
];
const LOOKALIKE = 0.7;
const GRID = 20;

function pixels(cut: string): Set<number> {
  const lit = new Set<number>();
  for (const m of cut.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)/g)) {
    const [x, y, w, h] = m.slice(1).map(Number) as [number, number, number, number];
    for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) lit.add(j * GRID + i);
  }
  return lit;
}

function softened(lit: Set<number>): Float64Array {
  const v = new Float64Array(GRID * GRID);
  for (const p of lit) {
    const x = p % GRID;
    const y = Math.floor(p / GRID);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const X = x + dx;
        const Y = y + dy;
        if (X >= 0 && X < GRID && Y >= 0 && Y < GRID) v[Y * GRID + X]! += ((dx ? 1 : 2) * (dy ? 1 : 2)) / 16;
      }
    }
  }
  return v;
}

function overlap(a: IconName, b: IconName): number {
  const va = softened(pixels(GLYPHS[a].cuts[20]));
  const vb = softened(pixels(GLYPHS[b].cuts[20]));
  let low = 0;
  let high = 0;
  for (let i = 0; i < va.length; i++) {
    low += Math.min(va[i]!, vb[i]!);
    high += Math.max(va[i]!, vb[i]!);
  }
  return low / high;
}

const isSibling = (a: IconName, b: IconName) => SIBLINGS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.css'))
    .map((f) => join(dir, f));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(css|tsx?)$/.test(f))
    .map((f) => join(dir, f));
}

const repo = join(import.meta.dirname, '../../..');
const uiStyles = join(import.meta.dirname, '../src/styles');
const appSrc = join(repo, 'apps/desktop/src');

describe('icons', () => {
  it('gives every meaning its own drawing and its own word', () => {
    const drawings = new Map<string, IconName>();
    const words = new Map<string, IconName>();
    for (const name of ICON_NAMES) {
      const g = GLYPHS[name];
      const drawing = `${g.stroke}|${g.fills.join('|')}`;
      expect(drawings.get(drawing), `${name} draws the same as ${String(drawings.get(drawing))}`).toBeUndefined();
      drawings.set(drawing, name);
      const word = iconLabel(name);
      expect(word.trim(), name).not.toBe('');
      expect(words.get(word), `${name} and ${String(words.get(word))} both say ${word}`).toBeUndefined();
      words.set(word, name);
    }
  });

  it('keeps every pair apart at 20 px, except siblings that differ by one mark', () => {
    const close: string[] = [];
    for (let i = 0; i < ICON_NAMES.length; i++) {
      for (let j = i + 1; j < ICON_NAMES.length; j++) {
        const a = ICON_NAMES[i]!;
        const b = ICON_NAMES[j]!;
        const o = overlap(a, b);
        if (o >= LOOKALIKE && !isSibling(a, b)) close.push(`${a} / ${b}: ${o.toFixed(2)}`);
      }
    }
    expect(close).toEqual([]);
    for (const [a, b] of SIBLINGS) expect(overlap(a, b), `${a} / ${b}`).toBeLessThan(0.9);
  });

  it('draws the 1.5 px stroke and a pixel cut for each size a screen at 1x can show sharp', () => {
    const { container } = render(<Icon name="split-chart" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 20 20');
    expect(svg.getAttribute('data-icon')).toBe('split-chart');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const stroke = svg.querySelector('.t-icon-vec > path')!;
    expect([stroke.getAttribute('stroke-width'), stroke.getAttribute('fill')]).toEqual(['1.5', 'none']);
    const cuts = [...svg.querySelectorAll('.t-icon-cut')];
    expect(cuts.map((c) => Number(c.getAttribute('data-cut')))).toEqual([...ICON_CUT_SIZES]);
    for (const c of cuts) {
      expect(c.getAttribute('transform')).toBe(`scale(${String(20 / Number(c.getAttribute('data-cut')))})`);
      expect(c.getAttribute('shape-rendering')).toBe('crispEdges');
    }
  });

  it('puts each straight stroke of a cut on whole pixels, one pixel wide', () => {
    expect(GLYPHS.minimise.cuts[20]).toBe('M4 14h12v1h-12z');
    expect(GLYPHS.remove.cuts[20]).toBe('M4 9h12v1h-12z');
    expect(GLYPHS.minimise.cuts[16]).toBe('M3 11h10v1h-10z');
    for (const name of ICON_NAMES) {
      for (const size of ICON_CUT_SIZES) {
        const cut = GLYPHS[name].cuts[size];
        expect(cut, `${name} at ${String(size)}`).toMatch(/^(M\d+ \d+h\d+v\d+h-\d+z)+$/);
        for (const p of pixels(cut)) expect(p % GRID, `${name} at ${String(size)}`).toBeLessThan(size);
      }
    }
  });

  it('draws every straight stroke of a cut as one run of pixels joined by their edges, never by corners alone', () => {
    const svg = readFileSync(join(import.meta.dirname, '../icons/icons.svg'), 'utf8');
    const strokes = [...svg.matchAll(/<(path|rect)\b([^>]*)\/>/g)]
      .filter((m) => !m[2]!.includes('fill="currentColor"'))
      .map((m) => {
        const a = Object.fromEntries([...m[2]!.matchAll(/([a-z]+)="([^"]*)"/g)].map((x) => [x[1]!, x[2]!]));
        return m[1] === 'rect' ? rectPath([Number(a.x), Number(a.y), Number(a.width), Number(a.height)]) : a.d!;
      })
      .filter((d) => !d.includes('A'));
    const broken: string[] = [];
    for (const d of strokes) {
      for (const sub of subpaths(d)) {
        const pts = sub.closed ? [...sub.pts, sub.pts[0]!] : sub.pts;
        for (let i = 0; i + 1 < pts.length; i++) {
          const segment = `M${String(pts[i]!.x)} ${String(pts[i]!.y)}L${String(pts[i + 1]!.x)} ${String(pts[i + 1]!.y)}`;
          for (const size of ICON_CUT_SIZES) {
            const lit = new Set<number>();
            for (const [x, y, w, h] of cut([{ d: segment, fill: false }], size)) {
              for (let a = x; a < x + w; a++) for (let b = y; b < y + h; b++) lit.add(b * GRID * 2 + a);
            }
            const reached = new Set<number>();
            const todo = [lit.values().next().value!];
            while (todo.length) {
              const p = todo.pop()!;
              if (reached.has(p) || !lit.has(p)) continue;
              reached.add(p);
              todo.push(p + 1, p - 1, p + GRID * 2, p - GRID * 2);
            }
            if (reached.size !== lit.size) broken.push(`${segment} at ${String(size)} px`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('draws close as a symmetric X at every cut size', () => {
    for (const size of ICON_CUT_SIZES) {
      const lit = pixels(GLYPHS.close.cuts[size]);
      const xs = [...lit].map((p) => p % GRID);
      const mirror = Math.min(...xs) + Math.max(...xs);
      for (const p of lit) {
        const x = p % GRID;
        expect(lit.has(p - x + mirror - x), `close at ${String(size)} px`).toBe(true);
      }
    }
  });

  it('shows a cut at 1x for each cut size and the stroke everywhere else', () => {
    const css = readFileSync(join(uiStyles, 'icons.css'), 'utf8');
    expect(css).toMatch(/@media \(max-resolution: 1dppx\)/);
    for (const size of ICON_CUT_SIZES) {
      const rule = new RegExp(
        `@container style\\(--icon: ${String(size)}px\\) \\{\\s*\\.t-icon-cut\\[data-cut='${String(size)}'\\] \\{\\s*display: inline;\\s*\\}\\s*\\.t-icon-vec \\{\\s*display: none;`,
      );
      expect(css, `${String(size)} px`).toMatch(rule);
    }
  });

  it('sizes every icon through --icon, and only to a size that has a cut', () => {
    const sizes = new Set<string>(ICON_CUT_SIZES.map((s) => `${String(s)}px`));
    const sources = [...sourceFiles(appSrc), ...sourceFiles(join(repo, 'packages/ui/src'))];
    const iconClasses = new Set(['t-icon']);
    for (const file of sources.filter((f) => f.endsWith('.tsx'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/<Icon\b[^>]*?className=(\{[^}]*\}|"[^"]*")/g)) {
        for (const c of m[1]!.matchAll(/['"]([^'"]+)['"]/g))
          for (const w of c[1]!.split(/\s+/)) if (/^[a-z][\w-]*$/.test(w) && !/^(is|text)-/.test(w)) iconClasses.add(w);
      }
    }
    const sizesAnIcon = (selector: string) =>
      selector.split(',').some((s) => {
        const last =
          s
            .trim()
            .split(/[\s>+~]+/)
            .at(-1) ?? '';
        return [...last.matchAll(/\.([\w-]+)/g)].some((c) => iconClasses.has(c[1]!));
      });
    for (const file of [...cssFiles(uiStyles), ...cssFiles(appSrc)]) {
      if (file.endsWith('icons.css')) continue;
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!sizesAnIcon(m[1]!)) continue;
        expect(m[2], `${file}: ${m[1]!.trim()}`).not.toMatch(/(^|[\s;])(width|height|inline-size|block-size)\s*:/);
      }
    }
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/--icon:\s*([^;\])\s]+)/g)) {
        expect(sizes.has(m[1]!), `${file}: --icon: ${m[1]!}`).toBe(true);
      }
    }
  });
});
