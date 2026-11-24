import { MARK_VEC } from '../icons/glyphs.gen.ts';

export const SPLASH_INTRO_MS = 1440;

export const SPLASH_SEAM = (() => {
  const m = /^M([\d.]+) 0V([\d.]+)H([\d.]+)V/.exec(MARK_VEC.seam);
  if (!m) throw new Error('the keyed T has no seam');
  return { topX: Number(m[1]) / MARK_VEC.w, jogY: Number(m[2]) / MARK_VEC.hgt, botX: Number(m[3]) / MARK_VEC.w };
})();

export const SPLASH_MARK_CLASS =
  't-intro block flex-none not-italic leading-[0] text-mist h-(--sp-t) [&_svg]:block [&_svg]:h-full [&_svg]:w-auto';

export function splashMarkSvg(): string {
  const v = MARK_VEC;
  const seam = (cls: string) => `<path class="${cls}" d="${v.seam}" fill="none" stroke-width="13" pathLength="1"/>`;
  return (
    `<svg class="block" viewBox="0 0 ${String(v.w)} ${String(v.hgt)}" overflow="visible" aria-hidden="true">` +
    `<path class="h" fill="currentColor" d="${v.h}"/>` +
    `<path class="a" style="--drop:${String(v.drop)}px" d="${v.a}"/>` +
    seam('seam') +
    seam('seam loop') +
    `</svg>`
  );
}
