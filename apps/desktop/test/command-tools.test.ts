import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import { CommandRegistry } from '../src/commands/registry.ts';
import { COMMAND_TOOLS, reachOf } from '../src/commands/toolMap.ts';
import { registerBuiltinWindowCommands } from '../src/commands/windowCommands.ts';
import '../src/workspace/tiles/index.ts';

function declaredTools(): Set<string> {
  const src = readFileSync(join(import.meta.dirname, '../../../packages/protocol/src/gen/ToolMap.ts'), 'utf8');
  return new Set([...src.matchAll(/^ {2}"([a-z_]+\.[a-z_]+)"/gm)].map((m) => m[1]!));
}

function everyCommand(): string[] {
  const main = new CommandRegistry();
  registerBuiltinCommands(main, {
    runtime: true,
    focusComposer: () => undefined,
  });
  const window = new CommandRegistry();
  registerBuiltinWindowCommands(window);
  return [...new Set([...main.all(), ...window.all()].map((c) => c.id))];
}

describe('every command has its tools', () => {
  it('maps each command, hidden and window ones included, to tools or a reason', () => {
    const ids = everyCommand();
    expect(ids.length).toBeGreaterThan(60);
    const missing = ids.filter((id) => reachOf(id) === null);
    expect(missing, 'commands with no entry in src/commands/toolMap.ts').toEqual([]);
  });

  it('names only tools the runtime declares, and each reason in words', () => {
    const tools = declaredTools();
    expect(tools.size).toBeGreaterThan(100);
    for (const [id, reach] of Object.entries(COMMAND_TOOLS)) {
      if ('tools' in reach) {
        expect(reach.tools.length, id).toBeGreaterThan(0);
        for (const t of reach.tools) expect(tools.has(t), `${id} names ${t}`).toBe(true);
      } else {
        const why = 'user' in reach ? reach.user : reach.ephemeral;
        expect(why.length, id).toBeGreaterThan(10);
      }
    }
  });

  it('keeps no entry for a command that is gone', () => {
    const ids = everyCommand();
    const stale = Object.keys(COMMAND_TOOLS).filter((key) =>
      key.endsWith('.*') ? !ids.some((id) => id.startsWith(key.slice(0, -1))) : !ids.includes(key),
    );
    expect(stale).toEqual([]);
  });
});
