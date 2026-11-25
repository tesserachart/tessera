import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe('one guard for every send a trader makes', () => {
  it('resolves approvals only through the guarded send, the card, the analyst’s ask and a chart drag alike', () => {
    const callers = sources(SRC)
      .filter((path) => /\bapprove\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split('\\').join('/'));
    expect(callers.sort()).toEqual(['app/tools.ts', 'shell/tradeActions.ts']);
  });
});
