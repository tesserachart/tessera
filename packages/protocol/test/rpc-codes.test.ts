import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES } from '../src/maps.ts';

describe('RPC_ERROR_CODES', () => {
  it('are tessera_protocol::rpc::codes, one for one', () => {
    const rust = readFileSync(join(import.meta.dirname, '../../../crates/tessera-protocol/src/rpc.rs'), 'utf8');
    const runtime = Object.fromEntries(
      [...rust.matchAll(/pub const (\w+): i32 = (-?\d+);/g)].map(([, name, code]) => [name, Number(code)]),
    );
    const client = Object.fromEntries(
      Object.entries(RPC_ERROR_CODES).map(([name, code]) => [
        name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase(),
        code,
      ]),
    );
    expect(client).toEqual(runtime);
  });
});
