export class PriceScale {
  mode: 'auto' | 'manual' = 'auto';
  min = 0;
  max = 1;
  hasRange = false;
  top = 0;
  height = 1;
  padTop = 0.08;
  padBottom = 0.08;

  setPane(top: number, height: number): void {
    this.top = top;
    this.height = Math.max(1, height);
  }

  yOf(price: number): number {
    const span = this.max - this.min || 1;
    return this.top + ((this.max - price) / span) * this.height;
  }

  priceOf(y: number): number {
    const span = this.max - this.min || 1;
    return this.max - ((y - this.top) / this.height) * span;
  }

  autoFit(lo: number, hi: number, minSpan: number): void {
    if (this.mode !== 'auto') return;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    let a = lo;
    let b = hi;
    if (b - a < minSpan) {
      const mid = (a + b) / 2;
      a = mid - minSpan / 2;
      b = mid + minSpan / 2;
    }
    const usable = 1 - this.padTop - this.padBottom;
    const span = (b - a) / usable;
    this.max = b + span * this.padTop;
    this.min = a - span * this.padBottom;
    this.hasRange = true;
  }

  setRange(min: number, max: number): void {
    if (!(max > min)) return;
    this.mode = 'manual';
    this.min = min;
    this.max = max;
    this.hasRange = true;
  }

  scaleAround(factor: number, anchor: number): void {
    const f = Math.min(50, Math.max(0.02, factor));
    this.mode = 'manual';
    this.min = anchor - (anchor - this.min) * f;
    this.max = anchor + (this.max - anchor) * f;
  }

  panPixels(dy: number): void {
    const span = this.max - this.min;
    const dp = (dy / this.height) * span;
    this.mode = 'manual';
    this.min += dp;
    this.max += dp;
  }

  tickStep(minPx: number, minMove: number): number {
    const span = this.max - this.min;
    if (!(span > 0)) return minMove || 1;
    const raw = (span * minPx) / this.height;
    const exp = 10 ** Math.floor(Math.log10(raw));
    let step = exp * 10;
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (exp * m >= raw) {
        step = exp * m;
        break;
      }
    }
    if (minMove > 0) step = Math.max(minMove, Math.ceil(step / minMove - 1e-9) * minMove);
    return step;
  }

  ticks(step: number, decimals: number): number[] {
    if (!this.hasRange || !(step > 0)) return [];
    const k0 = Math.ceil(this.min / step - 1e-9);
    const k1 = Math.floor(this.max / step + 1e-9);
    const out: number[] = [];
    const f = 10 ** Math.min(10, decimals + 2);
    for (let k = k0; k <= k1 && out.length < 500; k++) out.push(Math.round(k * step * f) / f);
    return out;
  }
}
