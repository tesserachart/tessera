import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..');

function rustSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'target' ? [] : rustSources(path);
    return entry.name.endsWith('.rs') ? [path] : [];
  });
}

describe('the Rust tests', () => {
  it('have no doctests, which cargo nextest does not run: an example in a doc comment is ```text', () => {
    const fence = /^\s*\/\/[/!]\s*```(.*)$/;
    const found: string[] = [];
    for (const file of ['crates', 'apps/desktop/src-tauri/src'].flatMap((root) => rustSources(join(repo, root)))) {
      let open = false;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const info = fence.exec(line)?.[1]?.trim();
          if (info === undefined) return;
          if (!open && info !== 'text') found.push(`${relative(repo, file)}:${String(i + 1)}`);
          open = !open;
        });
    }
    expect(found).toEqual([]);
  });
});
