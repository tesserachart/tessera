export const ROW_STEPS: readonly number[] = [1, 2, 4, 5, 10, 20, 25, 50, 100];
const DECADE_STEPS: readonly number[] = [2, 2.5, 5, 10];
const MAX_ROW_TICKS = 100_000;

function roundRowSteps(): readonly number[] {
  const steps = [...ROW_STEPS];
  for (let decade = 100; decade < MAX_ROW_TICKS; decade *= 10) for (const s of DECADE_STEPS) steps.push(s * decade);
  return steps;
}

const ROUND_ROW_STEPS = roundRowSteps();

export function decimalsOf(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  for (let d = 0; d <= 12; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return 12;
}

export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export class TickGrid {
  readonly tick: number;
  readonly decimals: number;
  private readonly scale: number;

  constructor(tick: number, decimals: number = decimalsOf(tick)) {
    if (!(tick > 0) || !Number.isFinite(tick))
      throw new Error(`[chart] tick size must be positive, got ${String(tick)}`);
    this.tick = tick;
    this.decimals = Math.max(0, Math.min(12, decimals));
    this.scale = 10 ** this.decimals;
  }

  toTick(price: number): number {
    return Math.round(price / this.tick);
  }

  toPrice(tick: number): number {
    return Math.round(tick * this.tick * this.scale) / this.scale;
  }

  rowOf(tick: number, rowTicks: number): number {
    return rowTicks <= 1 ? tick : floorDiv(tick, rowTicks) * rowTicks;
  }

  equals(other: TickGrid): boolean {
    return other.tick === this.tick && other.decimals === this.decimals;
  }
}

export function autoRowTicks(tickPx: number, minRowPx: number, baseTicks = 1): number {
  const base = Math.max(1, Math.round(baseTicks));
  let last = base;
  for (const step of ROUND_ROW_STEPS) {
    if (step < base || step % base !== 0) continue;
    last = step;
    if (step * tickPx >= minRowPx) return step;
  }
  return last;
}
