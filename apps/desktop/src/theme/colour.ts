export type Rgba = readonly [number, number, number, number];

export function parseHex(s: string): Rgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1]!.length <= 4 ? m[1]!.replace(/./g, (d) => d + d) : m[1]!;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
}

export function hexOf(c: Rgba): string {
  const two = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${two(c[0])}${two(c[1])}${two(c[2])}${c[3] === 255 ? '' : two(c[3])}`;
}

export function cssOf(c: Rgba): string {
  if (c[3] === 255) return hexOf(c);
  return `rgba(${String(c[0])},${String(c[1])},${String(c[2])},${String(Math.round((c[3] / 255) * 1000) / 1000)})`;
}

export const TRANSPARENT = cssOf([0, 0, 0, 0]);

export const timesAlpha = (c: Rgba, k: number): Rgba => [
  c[0],
  c[1],
  c[2],
  Math.round(c[3] * Math.min(1, Math.max(0, k))),
];

export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return [0, 1, 2, 3].map((i) => a[i]! + (b[i]! - a[i]!) * t) as unknown as Rgba;
}

function over(fg: Rgba, ground: Rgba): Rgba {
  const a = fg[3] / 255;
  return [0, 1, 2].map((i) => Math.round(fg[i]! * a + ground[i]! * (1 - a))).concat(255) as unknown as Rgba;
}

export function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

export function contrast(fg: Rgba, ground: Rgba): number {
  const g: Rgba = [ground[0], ground[1], ground[2], 255];
  const [x, y] = [luminance(over(fg, g)), luminance(g)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
