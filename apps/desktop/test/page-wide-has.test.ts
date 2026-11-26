import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '../../..');
const ROOTS = ['apps/desktop/src', 'packages/ui/src'];

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

describe('style rules', () => {
  it('hang no :has() on the whole page, which would restyle the page on every text a live number writes', () => {
    const anchored = /(^|[\s,>+~(])(body|html|:root)(\[[^\]]*\]|\.[\w-]+)*:has\(/m;
    const found = ROOTS.flatMap((root) => stylesheets(join(repo, root)))
      .filter((path) => anchored.test(readFileSync(path, 'utf8')))
      .map((path) => relative(repo, path));
    expect(found).toEqual([]);
  });
});
