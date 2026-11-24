export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GAP = 10;
const EDGE = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, v), hi);

export const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function styleBarAt(
  box: Box,
  bar: { w: number; h: number },
  plot: Box,
  legend: Box | null,
): { x: number; y: number } {
  const [left, right] = [plot.x + EDGE, plot.x + plot.w - bar.w - EDGE];
  const [top, bottom] = [plot.y + EDGE, plot.y + plot.h - bar.h - EDGE];
  const x = clamp(box.x + box.w / 2 - bar.w / 2, left, right);
  let y = box.y - bar.h - GAP;
  if (y < top) y = box.y + box.h + GAP;
  y = clamp(y, top, bottom);
  if (!legend || !overlaps({ x, y, ...bar }, legend)) return { x, y };
  const beside = legend.x + legend.w + EDGE;
  if (beside <= right) return { x: beside, y };
  const under = box.y + box.h + GAP;
  if (under <= bottom && !overlaps({ x, y: under, ...bar }, legend)) return { x, y: under };
  return { x, y: clamp(legend.y + legend.h + EDGE, top, bottom) };
}
