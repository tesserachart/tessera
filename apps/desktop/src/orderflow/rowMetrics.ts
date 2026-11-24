/** Reading a computed style after a write to the page forces a style recalculation. */
export class RowMetrics {
  private h: number;
  private readonly observer: MutationObserver | null;

  constructor(
    private readonly el: HTMLElement,
    private readonly onChange: () => void = () => undefined,
    private readonly fallback = 20,
  ) {
    this.h = this.read();
    const root = el.ownerDocument.documentElement;
    const Observer = el.ownerDocument.defaultView?.MutationObserver;
    this.observer = Observer
      ? new Observer(() => {
          if (this.refresh()) this.onChange();
        })
      : null;
    this.observer?.observe(root, { attributes: true, attributeFilter: ['data-density'] });
  }

  get rowH(): number {
    return this.h;
  }

  refresh(): boolean {
    const h = this.read();
    if (h === this.h) return false;
    this.h = h;
    return true;
  }

  dispose(): void {
    this.observer?.disconnect();
  }

  private read(): number {
    const view = this.el.ownerDocument.defaultView;
    const n = Number.parseFloat(
      view ? view.getComputedStyle(this.el).getPropertyValue('--spacing-row-ladder').trim() : '',
    );
    return Number.isFinite(n) && n > 0 ? n : this.fallback;
  }
}
