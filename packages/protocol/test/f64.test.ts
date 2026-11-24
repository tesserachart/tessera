import { describe, expect, it } from 'vitest';
import { decodeF64, encodeF64 } from '../src/f64.ts';

const bits = (values: Float64Array) => [...new Uint8Array(values.buffer, values.byteOffset, values.byteLength)];

describe('f64 columns on the wire', () => {
  it('reads little-endian IEEE 754 doubles from base64', () => {
    expect([...decodeF64('AAAAAAAA8D8=')]).toEqual([1]);
    expect([...decodeF64('AAAAAAAA8D8AAAAAAAAAwA==')]).toEqual([1, -2]);
    expect(decodeF64('')).toHaveLength(0);
  });

  it('round-trips every double bit for bit, NaN, its payload, signed zero and infinities included', () => {
    const payloadNan = new Uint8Array([1, 0, 0, 0, 0, 0, 0xf8, 0x7f]);
    const values = new Float64Array([
      0,
      -0,
      1.5,
      -29_712.25,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      Infinity,
      -Infinity,
      Number.NaN,
      1_761_000_000_000,
      0,
    ]);
    new Uint8Array(values.buffer).set(payloadNan, 10 * 8);
    const back = decodeF64(encodeF64(values));
    expect(bits(back)).toEqual(bits(values));
    expect(Object.is(back[1], -0)).toBe(true);
    expect(back[8]).toBeNaN();
    expect(back[10]).toBeNaN();
  });

  it('encodes a view of a larger buffer as only the values it shows', () => {
    const all = new Float64Array([7, 8, 9, 10]);
    expect([...decodeF64(encodeF64(all.subarray(1, 3)))]).toEqual([8, 9]);
  });

  it('encodes columns longer than one chunk of characters', () => {
    const values = Float64Array.from({ length: 50_000 }, (_, i) => i * 0.25 - 1_000);
    const back = decodeF64(encodeF64(values));
    expect(back).toHaveLength(values.length);
    expect(Buffer.from(back.buffer, back.byteOffset, back.byteLength).equals(Buffer.from(values.buffer))).toBe(true);
  });

  it('refuses bytes that are not whole doubles', () => {
    expect(() => decodeF64('AAAA')).toThrow(RangeError);
  });
});
