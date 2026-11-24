import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

function quotedIn(text: string, start: string, end: string, quote: string): string[] {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const list = text.slice(from + start.length, text.indexOf(end, from));
  return list.split(quote).filter((_, i) => i % 2 === 1);
}

describe('what a workspace counts as a change', () => {
  it('leaves out every pixel key the desk strips from its dock shape', () => {
    const desk = quotedIn(read('apps/desktop/src/workspace/layouts.ts'), 'const PIXEL_KEYS = new Set([', ']);', "'");
    const runtime = quotedIn(
      read('crates/tessera-runtime/src/layout/document.rs'),
      'pub const VIEW_STATE_KEYS',
      '];',
      '"',
    );
    expect(desk.length).toBeGreaterThan(0);
    for (const key of desk) expect(runtime, key).toContain(key);
  });
});
