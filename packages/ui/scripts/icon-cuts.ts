const GRID = 20;
const CAP = 0.75;
const AXIAL_HALF_PX = 0.5;
const MITRE_LIMIT = 4;
const TIE_NUDGE_X_PX = 0.01;
const TIE_NUDGE_Y_PX = 0.0137;
const ARC_STEP = Math.PI / 32;
const EPS = 1e-9;

interface PathPoint {
  x: number;
  y: number;
  corner: boolean;
}

export interface Subpath {
  pts: PathPoint[];
  closed: boolean;
}

export interface Shape {
  d: string;
  fill: boolean;
}

export type Rect = [number, number, number, number];

interface Vec {
  x: number;
  y: number;
}

interface Segment {
  a: Vec;
  b: Vec;
  ux: number;
  uy: number;
  len: number;
  axial: boolean;
}

type Join = { poly: Vec[] } | { disc: Vec; r: number };

type Inside = (x: number, y: number) => boolean;

function arcPoints(from: Vec, radii: Vec, rot: number, large: number, sweep: number, to: Vec): PathPoint[] {
  let rx = radii.x;
  let ry = radii.y;
  const phi = (rot * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * yp) / ry;
  const cyp = (-k * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (from.x + to.x) / 2;
  const cy = sin * cxp + cos * cyp + (from.y + to.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t0 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(2, Math.ceil(Math.abs(dt) / ARC_STEP));
  const pts: PathPoint[] = [];
  for (let i = 1; i <= n; i++) {
    const t = t0 + (dt * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    pts.push({ x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy, corner: i === n });
  }
  return pts;
}

function distinct(pts: readonly PathPoint[], closed: boolean): PathPoint[] {
  const out: PathPoint[] = [];
  for (const p of pts) {
    const q = out.at(-1);
    if (q && Math.abs(q.x - p.x) < EPS && Math.abs(q.y - p.y) < EPS) q.corner ||= p.corner;
    else out.push({ ...p });
  }
  const first = out[0];
  const last = out.at(-1);
  if (
    closed &&
    first &&
    last &&
    out.length > 2 &&
    Math.abs(first.x - last.x) < EPS &&
    Math.abs(first.y - last.y) < EPS
  ) {
    out.pop();
  }
  return out;
}

export function subpaths(d: string): Subpath[] {
  const t = [...d.matchAll(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g)].map((m) => m[0]);
  const out: Subpath[] = [];
  let cur: Subpath | null = null;
  let x = 0;
  let y = 0;
  let i = 0;
  let cmd = '';
  const num = () => Number(t[i++]);
  const open = (): Subpath => {
    if (!cur) throw new Error(`icon path: drawing before the first M: ${d}`);
    return cur;
  };
  const to = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    open().pts.push({ x, y, corner: true });
  };
  while (i < t.length) {
    if (/[A-Za-z]/.test(t[i]!)) cmd = t[i++]!;
    if (cmd === 'M') {
      x = num();
      y = num();
      cur = { pts: [{ x, y, corner: true }], closed: false };
      out.push(cur);
      cmd = 'L';
    } else if (cmd === 'L') to(num(), num());
    else if (cmd === 'H') to(num(), y);
    else if (cmd === 'V') to(x, num());
    else if (cmd === 'A') {
      const radii = { x: num(), y: num() };
      const [rot, large, sweep] = [num(), num(), num()];
      const end = { x: num(), y: num() };
      open().pts.push(...arcPoints({ x, y }, radii, rot, large, sweep, end));
      x = end.x;
      y = end.y;
    } else if (cmd === 'Z') {
      const sub = open();
      sub.closed = true;
      x = sub.pts[0]!.x;
      y = sub.pts[0]!.y;
      cmd = '';
    } else throw new Error(`icon path: ${cmd} is not supported (absolute M, L, H, V, A and Z only): ${d}`);
  }
  return out.map((s) => ({ ...s, pts: distinct(s.pts, s.closed) })).filter((s) => s.pts.length > 1);
}

export function rectPath([x, y, w, h]: Rect): string {
  return `M${String(x)} ${String(y)}H${String(x + w)}V${String(y + h)}H${String(x)}Z`;
}

function winding(px: number, py: number, poly: readonly Vec[]): number {
  let wind = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y);
    if (a.y <= py) {
      if (b.y > py && cross > 0) wind++;
    } else if (b.y <= py && cross < 0) wind--;
  }
  return wind;
}

function crossesSquare(a: Vec, b: Vec, cx: number, cy: number, s: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sides: [number, number][] = [
    [-dx, a.x - (cx - s)],
    [dx, cx + s - a.x],
    [-dy, a.y - (cy - s)],
    [dy, cy + s - a.y],
  ];
  for (const [p, q] of sides) {
    if (Math.abs(p) < EPS) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

function toPixelEdge(p: Vec, g: Segment, sign: 1 | -1, pixel: number): Vec {
  const alongX = Math.abs(g.ux) >= Math.abs(g.uy);
  const d = (alongX ? g.ux : g.uy) * sign;
  const c = (alongX ? p.x : p.y) / pixel - (alongX ? TIE_NUDGE_X_PX : TIE_NUDGE_Y_PX);
  const edge = d > 0 ? Math.ceil(c) - EPS : Math.floor(c) + EPS;
  const t = ((edge - c) * pixel) / d;
  return { x: p.x + g.ux * sign * t, y: p.y + g.uy * sign * t };
}

function axialJoin(s1: Segment, s2: Segment, v: PathPoint, half: number): Join | null {
  const cross = s1.ux * s2.uy - s1.uy * s2.ux;
  const dot = s1.ux * s2.ux + s1.uy * s2.uy;
  if ((Math.abs(cross) < EPS && dot > 0) || !s1.axial || !s2.axial) return null;
  if (!v.corner) return { disc: v, r: half };
  const side = cross > 0 ? -1 : 1;
  const n1 = { x: -s1.uy * side * half, y: s1.ux * side * half };
  const n2 = { x: -s2.uy * side * half, y: s2.ux * side * half };
  const ratio = 1 / Math.sin(Math.acos(Math.max(-1, Math.min(1, -dot))) / 2);
  const p1 = { x: v.x + n1.x, y: v.y + n1.y };
  const p2 = { x: v.x + n2.x, y: v.y + n2.y };
  if (ratio > MITRE_LIMIT) return { poly: [v, p1, p2] };
  const bl = Math.hypot(n1.x + n2.x, n1.y + n2.y);
  const m = { x: v.x + ((n1.x + n2.x) / bl) * half * ratio, y: v.y + ((n1.y + n2.y) / bl) * half * ratio };
  return { poly: [v, p1, m, p2] };
}

function strokeOf({ pts, closed }: Subpath, axialHalf: number, pixel: number): Inside {
  const segs: Segment[] = [];
  const count = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    segs.push({ a, b, ux, uy, len, axial: Math.abs(ux) < EPS || Math.abs(uy) < EPS });
  }
  const joins: Join[] = [];
  for (let i = 1; i < segs.length; i++) {
    const j = axialJoin(segs[i - 1]!, segs[i]!, pts[i]!, axialHalf);
    if (j) joins.push(j);
  }
  if (closed && segs.length > 1) {
    const j = axialJoin(segs.at(-1)!, segs[0]!, pts[0]!, axialHalf);
    if (j) joins.push(j);
  }
  const cap = closed ? 0 : CAP;
  const square = pixel / 2 - EPS;
  const last = segs.length - 1;
  return (x, y) => {
    for (const [i, g] of segs.entries()) {
      if (!g.axial) {
        const from = i === 0 && !closed ? toPixelEdge(g.a, g, -1, pixel) : g.a;
        const to = i === last && !closed ? toPixelEdge(g.b, g, 1, pixel) : g.b;
        if (crossesSquare(from, to, x, y, square)) return true;
        continue;
      }
      const along = (x - g.a.x) * g.ux + (y - g.a.y) * g.uy;
      const across = -(x - g.a.x) * g.uy + (y - g.a.y) * g.ux;
      const lo = i === 0 ? -cap : 0;
      const hi = g.len + (i === last ? cap : 0);
      if (Math.abs(across) <= axialHalf && along >= lo && along <= hi) return true;
    }
    return joins.some((j) =>
      'poly' in j ? winding(x, y, j.poly) !== 0 : Math.hypot(x - j.disc.x, y - j.disc.y) <= j.r,
    );
  };
}

function insideOf(shape: Shape, scale: number): { subs: Subpath[]; inside: Inside } {
  const subs = subpaths(shape.d);
  if (shape.fill) return { subs, inside: (x, y) => subs.reduce((w, s) => w + winding(x, y, s.pts), 0) !== 0 };
  const strokes = subs.map((s) => strokeOf(s, AXIAL_HALF_PX * scale, scale));
  return { subs, inside: (x, y) => strokes.some((t) => t(x, y)) };
}

function mergeRects(lit: boolean[][]): Rect[] {
  const size = lit.length;
  const used = lit.map((row) => row.map(() => false));
  const free = (x: number, y: number) => lit[y]![x]! && !used[y]![x]!;
  const rects: Rect[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!free(x, y)) continue;
      let w = 1;
      while (x + w < size && free(x + w, y)) w++;
      let h = 1;
      while (y + h < size && Array.from({ length: w }, (_, i) => free(x + i, y + h)).every(Boolean)) h++;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) used[yy]![xx] = true;
      rects.push([x, y, w, h]);
    }
  }
  return rects;
}

export function cut(shapes: readonly Shape[], size: number): Rect[] {
  const scale = GRID / size;
  const lit = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  for (const shape of shapes) {
    const { subs, inside } = insideOf(shape, scale);
    let any = false;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        if (!inside((px + 0.5 + TIE_NUDGE_X_PX) * scale, (py + 0.5 + TIE_NUDGE_Y_PX) * scale)) continue;
        lit[py]![px] = true;
        any = true;
      }
    }
    if (any) continue;
    const pts = subs.flatMap((s) => s.pts);
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    lit[Math.min(size - 1, Math.floor(cy / scale))]![Math.min(size - 1, Math.floor(cx / scale))] = true;
  }
  return mergeRects(lit);
}

export function cutPath(rects: readonly Rect[]): string {
  return rects.map(([x, y, w, h]) => `M${String(x)} ${String(y)}h${String(w)}v${String(h)}h${String(-w)}z`).join('');
}
