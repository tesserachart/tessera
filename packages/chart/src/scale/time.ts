export class TimeScale {
  barSpacing = 6;
  rightEdgeSlot = 0;
  width = 1;
  minSpacing = 0.002;
  maxSpacing = 80;

  setWidth(width: number): void {
    this.width = Math.max(1, width);
  }

  xOfSlot(slot: number): number {
    return this.width - (this.rightEdgeSlot - slot) * this.barSpacing;
  }

  slotOfX(x: number): number {
    return this.rightEdgeSlot - (this.width - x) / this.barSpacing;
  }

  get visibleSlots(): number {
    return this.width / this.barSpacing;
  }

  get leftEdgeSlot(): number {
    return this.rightEdgeSlot - this.visibleSlots;
  }

  zoom(factor: number, anchorX: number): void {
    const anchorSlot = this.slotOfX(anchorX);
    this.barSpacing = clamp(this.barSpacing * factor, this.minSpacing, this.maxSpacing);
    this.rightEdgeSlot = anchorSlot + (this.width - anchorX) / this.barSpacing;
  }

  panPixels(dx: number): void {
    this.rightEdgeSlot -= dx / this.barSpacing;
  }

  clampTo(firstSlot: number, lastSlot: number, minVisible: number): void {
    const maxRight = lastSlot + Math.max(minVisible, this.visibleSlots - minVisible);
    const minRight = firstSlot + Math.min(minVisible, this.visibleSlots);
    this.rightEdgeSlot = clamp(this.rightEdgeSlot, minRight, Math.max(minRight, maxRight));
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
