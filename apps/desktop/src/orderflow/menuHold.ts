export class MenuHold {
  private open = false;
  private pending: ((e: PointerEvent) => void) | null = null;

  constructor(
    private readonly zone: HTMLElement,
    private readonly left: () => void,
  ) {}

  get active(): boolean {
    return this.open;
  }

  opened(): void {
    this.cancel();
    this.open = true;
  }

  closed(): void {
    if (!this.open) return;
    this.open = false;
    this.cancel();
    const doc = this.zone.ownerDocument;
    const check = (e: PointerEvent): void => {
      this.cancel();
      const r = this.zone.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
      if (!inside) this.left();
    };
    this.pending = check;
    doc.addEventListener('pointermove', check, true);
  }

  dispose(): void {
    this.cancel();
    this.open = false;
  }

  private cancel(): void {
    if (!this.pending) return;
    this.zone.ownerDocument.removeEventListener('pointermove', this.pending, true);
    this.pending = null;
  }
}
