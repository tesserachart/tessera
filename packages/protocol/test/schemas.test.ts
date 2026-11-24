import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as S from '../src/schemas.gen.ts';

const decode = <T>(schema: z.ZodType<T>, input: unknown) => schema.parse(input);

describe('generated schemas', () => {
  it('decode an internally tagged union by its tag', () => {
    const agent = { kind: 'agent', sessionId: 's1', provider: 'codex' };
    expect(decode(S.Origin, agent)).toEqual(agent);
    expect(decode(S.Origin, { kind: 'user' })).toEqual({ kind: 'user' });
    expect(() => decode(S.Origin, { kind: 'agent', provider: 'codex' })).toThrow(/sessionId/);
    expect(() => decode(S.Origin, { kind: 'nope' })).toThrow();
  });

  it('decode nested JSON values', () => {
    const value = { a: [1, 'x', true, null, { b: [] }] };
    expect(decode(S.JsonValue, value)).toEqual(value);
    expect(() => decode(S.JsonValue, { a: undefined })).toThrow();
  });

  it('leave serde-skipped fields out and reject wrong types', () => {
    const money = { amount: 12.5, currency: 'USD' };
    expect(decode(S.Money, money)).toEqual(money);
    expect(() => decode(S.Money, { amount: '12.5', currency: 'USD' })).toThrow();
  });

  it('read an optional field the same absent or null, as serde writes None', () => {
    const style = decode(S.StyleHint, { color: 'mist', on: null });
    expect(style).toEqual({ color: 'mist' });
    expect('on' in style).toBe(false);
    expect('on' in decode(S.StyleHint, { color: 'mist' })).toBe(false);
    expect(decode(S.StyleHint, { on: false })).toEqual({ on: false });
  });

  it('read a nullable field left out (skip_serializing_if) as null', () => {
    const result = decode(S.ToolResult, { ok: true, status: 'ok', callId: 'c', durationMs: 1, deduped: false });
    expect(result).toMatchObject({ output: null, error: null, approval: null });
  });

  it('accept the empty input ts-rs writes as Record<symbol, never>', () => {
    expect(decode(S.WatchlistsListInput, {})).toEqual({});
  });

  it('cover every tool and topic in the generated maps', () => {
    expect(Object.keys(S.ToolOutputs).length).toBeGreaterThan(100);
    expect(Object.keys(S.TopicEvents)).toContain('orders');
  });
});

describe('the wire', () => {
  const samples = JSON.parse(readFileSync(new URL('./fixtures/wire-samples.json', import.meta.url), 'utf8')) as Record<
    string,
    unknown[]
  >;
  it.each(Object.entries(samples))('decodes %s', (label, values) => {
    const [kind, name] = label.split(' ') as ['topic' | 'tool', string];
    const schemas: Partial<Record<string, z.ZodType>> = kind === 'topic' ? S.TopicEvents : S.ToolOutputs;
    const schema = schemas[name];
    expect(schema).toBeDefined();
    for (const value of values) expect(() => schema!.parse(value)).not.toThrow();
  });
});
