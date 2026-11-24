import type { SeriesStore } from '../store.ts';
import type { ChartTheme, TimeSpan } from '../types.ts';
import type { ChartLayout, Ctx2D, TimeView } from './types.ts';

export interface BarsInView {
  readonly from: number;
  readonly to: number;
  readonly store: Pick<SeriesStore, 'time' | 'length'>;
  readonly timeframeMs: number;
}

export interface BarRun {
  readonly from: number;
  readonly to: number;
}

const MISSING_PRINTS_MARK = { height: 2, alpha: 0.5, minWidth: 2 } as const;

function joinTimeSpans(gaps: readonly TimeSpan[]): TimeSpan[] {
  const joined: TimeSpan[] = [];
  for (const g of [...gaps].filter((s) => s.to > s.from).sort((a, b) => a.from - b.from)) {
    const last = joined.at(-1);
    if (last && g.from <= last.to) joined[joined.length - 1] = { from: last.from, to: Math.max(last.to, g.to) };
    else joined.push(g);
  }
  return joined;
}

export function barsMissingPrints(bars: BarsInView, gaps: readonly TimeSpan[]): BarRun[] {
  const spans = joinTimeSpans(gaps);
  const runs: BarRun[] = [];
  if (spans.length === 0) return runs;
  const last = Math.min(bars.to, bars.store.length - 1);
  let g = 0;
  for (let i = Math.max(0, bars.from); i <= last; i++) {
    const start = bars.store.time[i]!;
    const end = start + bars.timeframeMs;
    while (g < spans.length && spans[g]!.to <= start) g++;
    if (g === spans.length) break;
    if (spans[g]!.from >= end) continue;
    const run = runs.at(-1);
    if (run?.to === i - 1) runs[runs.length - 1] = { from: run.from, to: i };
    else runs.push({ from: i, to: i });
  }
  return runs;
}

export function valueHoles(bars: BarsInView, length: number, has: (index: number) => boolean): TimeSpan[] {
  const last = Math.min(bars.to, length - 1, bars.store.length - 1);
  const holes: TimeSpan[] = [];
  let i = Math.max(0, bars.from);
  while (i <= last) {
    if (has(i)) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < length && !has(end + 1)) end++;
    if (valueBefore(i, has) && end + 1 < length) {
      const to = Math.min(end, bars.store.length - 1);
      holes.push({ from: bars.store.time[i]!, to: bars.store.time[to]! + bars.timeframeMs });
    }
    i = end + 1;
  }
  return holes;
}

function valueBefore(index: number, has: (index: number) => boolean): boolean {
  for (let k = index - 1; k >= 0; k--) if (has(k)) return true;
  return false;
}

export interface DrawnRun extends BarRun {
  readonly x: number;
  readonly w: number;
}

export function drawMissingPrints(
  ctx: Ctx2D,
  layout: Pick<ChartLayout, 'timeAxis'>,
  time: Pick<TimeView, 'xOfIndex' | 'barSpacing'>,
  theme: Pick<ChartTheme, 'mutedText'>,
  runs: readonly BarRun[],
): DrawnRun[] {
  const drawn: DrawnRun[] = [];
  if (runs.length === 0) return drawn;
  const { timeAxis } = layout;
  const half = time.barSpacing / 2;
  ctx.save();
  ctx.globalAlpha = MISSING_PRINTS_MARK.alpha;
  ctx.fillStyle = theme.mutedText;
  for (const r of runs) {
    const left = Math.max(timeAxis.x, time.xOfIndex(r.from) - half);
    const right = Math.min(timeAxis.x + timeAxis.w, time.xOfIndex(r.to) + half);
    if (right <= left) continue;
    const w = Math.max(MISSING_PRINTS_MARK.minWidth, right - left);
    ctx.fillRect(left, timeAxis.y + 1, w, MISSING_PRINTS_MARK.height);
    drawn.push({ ...r, x: left, w });
  }
  ctx.restore();
  return drawn;
}

export function runAt(runs: readonly DrawnRun[], x: number): DrawnRun | null {
  return runs.find((r) => x >= r.x && x <= r.x + r.w) ?? null;
}
