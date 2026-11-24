import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const SCANNED = ['apps/desktop/src', 'packages/ui/src', 'packages/chart/src', 'packages/bridge/src'];
const FORMATTER = 'packages/ui/src/format.ts';

const HAND_ROLLED: readonly { why: string; re: RegExp }[] = [
  { why: 'a `$${…}` template builds money by hand', re: /\$\$\{/ },
  { why: "'$' + … builds money by hand", re: /['"]\$['"]\s*\+/ },
  { why: 'Intl currency style bypasses formatMoney', re: /style:\s*['"]currency['"]/ },
  { why: 'a dollar amount without exactly two decimals', re: /(?<![\w$])[+−-]?\$\d[\d,]*(?![\d,]|\.\d\d(?!\d))/ },
];

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => relative(root, join(e.parentPath, e.name)));
}

function offences(): string[] {
  const found: string[] = [];
  for (const file of SCANNED.flatMap(sources)) {
    if (file === FORMATTER) continue;
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.includes('.replace(')) return;
        for (const { why, re } of HAND_ROLLED) if (re.test(line)) found.push(`${file}:${String(i + 1)} ${why}`);
      });
  }
  return found;
}

describe('money has one formatter', () => {
  it('formats every dollar value through formatMoney', () => {
    expect(offences()).toEqual([]);
  });

  it('catches the hand-rolled shapes it guards against', () => {
    const caught = (line: string) => HAND_ROLLED.some(({ re }) => re.test(line));
    expect(caught('return `+$${abs.toFixed(0)}`;')).toBe(true);
    expect(caught("return '$' + v;")).toBe(true);
    expect(caught("new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })")).toBe(true);
    expect(caught('<ReadoutRow value="+$7,317" />')).toBe(true);
    expect(caught("note: '$340.5 left'")).toBe(true);
    expect(caught("note: '$340.50 left'")).toBe(false);
    expect(caught('formatMoney(pnl, { signed: true })')).toBe(false);
  });
});
