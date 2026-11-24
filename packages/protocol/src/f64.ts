const F64_BYTES = 8;
const ENCODE_CHUNK = 0x8000;

export function decodeF64(base64: string): Float64Array {
  const text = atob(base64);
  if (text.length % F64_BYTES !== 0) throw new RangeError(`${String(text.length)} bytes are not whole f64 values`);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return new Float64Array(bytes.buffer, 0, bytes.length / F64_BYTES);
}

export function encodeF64(values: Float64Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let text = '';
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + ENCODE_CHUNK));
  }
  return btoa(text);
}
