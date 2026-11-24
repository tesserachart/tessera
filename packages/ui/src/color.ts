export interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(s: string): boolean {
  return HEX.test(s.trim());
}

export function normalizeHex(s: string): string | null {
  const t = s.trim().replace(/^(?!#)/, '#');
  if (!isHexColor(t)) return null;
  const h = t.slice(1).toLowerCase();
  const long = h.length <= 4 ? h.replace(/./g, (d) => d + d) : h;
  return long.length === 8 && long.endsWith('ff') ? `#${long.slice(0, 6)}` : `#${long}`;
}

const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i;

export function hexFromCss(css: string): string | null {
  const hex = normalizeHex(css);
  if (hex) return hex;
  const m = RGB.exec(css.trim());
  if (!m) return null;
  const byte = (x: string) =>
    Math.round(Math.min(255, Math.max(0, Number(x))))
      .toString(16)
      .padStart(2, '0');
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  return withAlpha(`#${byte(m[1]!)}${byte(m[2]!)}${byte(m[3]!)}`, a);
}

export function opaqueHex(hex: string): string {
  return (normalizeHex(hex) ?? hex).slice(0, 7);
}

export function alphaOfHex(hex: string): number {
  const n = normalizeHex(hex);
  return n?.length === 9 ? parseInt(n.slice(7, 9), 16) / 255 : 1;
}

export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(clamp01(alpha) * 255);
  const base = opaqueHex(hex);
  return a === 255 ? base : `${base}${a.toString(16).padStart(2, '0')}`;
}

export function hsvaFromHex(hex: string, hueWhenGrey = 0): Hsva | null {
  const n = normalizeHex(hex);
  if (!n) return null;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  const h =
    span === 0
      ? hueWhenGrey
      : max === r
        ? 60 * (((g - b) / span + 6) % 6)
        : max === g
          ? 60 * ((b - r) / span + 2)
          : 60 * ((r - g) / span + 4);
  return { h, s: max === 0 ? 0 : span / max, v: max, a: alphaOfHex(n) };
}

export function hexFromHsva({ h, s, v, a }: Hsva): string {
  const channel = (n: number) => {
    const k = (n + mod(h, 360) / 60) % 6;
    const c = clamp01(v) - clamp01(v) * clamp01(s) * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return withAlpha(`#${channel(5)}${channel(3)}${channel(1)}`, a);
}

export function hueHex(h: number): string {
  return hexFromHsva({ h, s: 1, v: 1, a: 1 });
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function mod(x: number, m: number): number {
  return ((x % m) + m) % m;
}
