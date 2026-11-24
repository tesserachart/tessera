import { formatPrice } from '@tessera/ui';
import { tapeSize, type TapeClock, type TapeList, type TapeRow } from './tapeModel.ts';

export interface TapePaint {
  highlight: number | null;
  byRule?: boolean;
  focus: string | null;
  marked: string | null;
  millis: boolean;
  aggregate: boolean;
  decimals: number;
}

export interface TapeCells {
  el: HTMLDivElement;
  time: HTMLElement;
  ms: HTMLElement;
  bar: HTMLElement;
  price: HTMLElement;
  size: HTMLElement;
  count: HTMLElement;
  key: string | null;
  sig: string;
  pos: number;
  last: Record<string, string | number>;
}

function span(cls: string, parent: HTMLElement, tag = 'span'): HTMLElement {
  const el = parent.ownerDocument.createElement(tag);
  el.className = cls;
  parent.appendChild(el);
  return el;
}

export function tapeRow(doc: Document): TapeCells {
  const el = doc.createElement('div');
  el.className = 'r';
  el.setAttribute('role', 'listitem');
  const t = span('c t', el);
  const time = span('hms', t);
  const ms = span('ms', t);
  const pz = span('c pz', el);
  const bar = span('bar', pz, 'i');
  const price = span('px', pz);
  const size = span('sz', pz);
  const count = span('c n', el);
  return { el, time, ms, bar, price, size, count, key: null, sig: '', pos: -1, last: {} };
}

export class TapeView {
  readonly viewport: HTMLElement;
  readonly content: HTMLElement;
  private readonly pool: TapeCells[] = [];
  private byKey = new Map<string, TapeCells>();
  private first = -1;
  private height: number;
  private scrollY: number;
  private contentH = -1;
  private rowH = 0;

  constructor(viewport: HTMLElement, content: HTMLElement) {
    this.viewport = viewport;
    this.content = content;
    this.height = viewport.clientHeight;
    this.scrollY = viewport.scrollTop;
    viewport.addEventListener('scroll', this.onScroll, { passive: true });
  }

  dispose(): void {
    this.viewport.removeEventListener('scroll', this.onScroll);
  }

  private readonly onScroll = (): void => {
    this.scrollY = this.viewport.scrollTop;
  };

  measureAfterResize(): void {
    this.height = this.viewport.clientHeight;
    this.scrollY = this.viewport.scrollTop;
  }

  get viewHeight(): number {
    return this.height;
  }

  get scroll(): number {
    return this.scrollY;
  }

  scrollTo(y: number): void {
    const max = this.contentH >= 0 ? Math.max(0, this.contentH - this.height) : y;
    const to = Math.max(0, Math.min(max, y));
    this.scrollY = to;
    this.viewport.scrollTop = to;
  }

  private makeRow(): TapeCells {
    const c = tapeRow(this.content.ownerDocument);
    this.content.appendChild(c.el);
    this.pool.push(c);
    return c;
  }

  render(list: TapeList, rowH: number, clock: TapeClock, paint: TapePaint): void {
    const n = list.length;
    if (rowH !== this.rowH) {
      this.rowH = rowH;
      for (const c of this.pool) c.pos = -1;
    }
    const contentH = n * rowH;
    if (contentH !== this.contentH) {
      this.contentH = contentH;
      this.content.style.height = `${String(contentH)}px`;
    }
    const first = Math.max(0, Math.floor(this.scrollY / rowH));
    const count = Math.min(Math.max(0, n - first), Math.ceil(this.height / rowH) + 1);
    this.first = first;
    const rows: TapeRow[] = [];
    const want = new Set<string>();
    for (let k = 0; k < count; k++) {
      const r = list.row(first + k);
      if (!r) break;
      rows.push(r);
      want.add(r.key);
    }
    const next = new Map<string, TapeCells>();
    const free: TapeCells[] = [];
    for (const c of this.pool) {
      if (c.key !== null && want.has(c.key) && !next.has(c.key)) next.set(c.key, c);
      else free.push(c);
    }
    const paintSig = `${String(paint.highlight)}|${paint.byRule ? 'rule' : ''}|${String(paint.focus)}|${String(paint.marked)}|${paint.millis ? 'ms' : ''}|${paint.aggregate ? 'agg' : ''}|${String(paint.decimals)}`;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k]!;
      const pos = first + k;
      const c = next.get(r.key) ?? free.pop() ?? this.makeRow();
      next.set(r.key, c);
      if (c.key === null) c.el.style.display = '';
      c.key = r.key;
      if (c.pos !== pos) {
        c.pos = pos;
        c.el.style.transform = `translateY(${String(pos * rowH)}px)`;
        c.el.dataset.pos = String(pos);
      }
      const sig = `${r.key}|${String(r.size)}|${String(r.price)}|${String(r.prints)}|${String(r.side)}|${String(r.big)}|${paintSig}`;
      if (c.sig === sig) continue;
      c.sig = sig;
      this.write(c, r, clock, paint);
    }
    for (const c of free) {
      if (c.key === null) continue;
      c.key = null;
      c.sig = '';
      c.pos = -1;
      c.el.style.display = 'none';
      delete c.el.dataset.pos;
      this.text(c, 'hms', c.time, '');
      this.text(c, 'ms', c.ms, '');
      this.text(c, 'px', c.price, '');
      this.text(c, 'sz', c.size, '');
      this.text(c, 'n', c.count, '');
    }
    this.byKey = next;
  }

  private write(c: TapeCells, r: TapeRow, clock: TapeClock, paint: TapePaint): void {
    const big = paint.highlight !== null && (paint.byRule && r.big !== undefined ? r.big : r.size >= paint.highlight);
    const side = r.side > 0 ? 'is-buy' : r.side < 0 ? 'is-sell' : '';
    let cls = 'r';
    if (side) cls += ` ${side}`;
    if (big) cls += ' is-big';
    if (paint.focus === r.key) cls += ' is-focus';
    if (paint.marked === r.key) cls += ' is-marked';
    this.set(c, 'cls', cls, () => (c.el.className = cls));
    const [hms, ms] = clock.parts(r.ns);
    this.text(c, 'hms', c.time, hms);
    this.text(c, 'ms', c.ms, paint.millis ? ms : '');
    this.text(c, 'px', c.price, formatPrice(r.price, paint.decimals));
    this.text(c, 'sz', c.size, tapeSize(r.size));
    this.text(c, 'n', c.count, paint.aggregate && r.prints > 1 ? `×${String(r.prints)}` : '');
    const v = paint.highlight ? Math.min(1, r.size / paint.highlight) : 0;
    const q = Math.round(v * 128) / 128;
    this.set(c, 'bar', q, () => (c.bar.style.transform = `scaleX(${String(q)})`));
  }

  private set(c: TapeCells, key: string, value: string | number, write: () => void): void {
    if (c.last[key] === value) return;
    c.last[key] = value;
    write();
  }

  private text(c: TapeCells, key: string, el: HTMLElement, s: string): void {
    this.set(c, key, s, () => (el.textContent = s));
  }

  posAt(target: EventTarget | null): number | null {
    const el = target instanceof Element ? target.closest<HTMLElement>('.r[data-pos]') : null;
    if (!el || !this.content.contains(el)) return null;
    const pos = Number(el.dataset.pos);
    return Number.isFinite(pos) ? pos : null;
  }

  rowEl(pos: number): HTMLElement | null {
    for (const c of this.byKey.values()) if (c.pos === pos) return c.el;
    return null;
  }

  get firstRow(): number {
    return this.first;
  }

  get poolSize(): number {
    return this.pool.length;
  }
}
