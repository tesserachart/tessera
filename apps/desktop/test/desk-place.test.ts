import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const DESK_PLACE = 'workspace/deskPlace.ts';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

function filesMatching(pattern: RegExp): string[] {
  return sources(SRC)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path).split('\\').join('/'));
}

describe('one way for a chart or pane to reach the desk', () => {
  it('adds dock panels only through the desk placement module', () => {
    expect(filesMatching(/\.addPanel\b/)).toEqual([DESK_PLACE]);
  });

  it('arranges charts into a preset’s columns only in the desk placement module', () => {
    expect(filesMatching(/\bpresetColumns\(/).filter((f) => f !== 'workspace/presets.ts')).toEqual([DESK_PLACE]);
  });
});
