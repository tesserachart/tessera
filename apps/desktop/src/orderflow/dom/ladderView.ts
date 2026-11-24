import { tagTitle, tagWords, sizeWords, type LadderCell, type LadderRow, type LadderTag } from './ladderModel.ts';

export interface LadderHit {
  row: number;
  cell: LadderCell;
  tag: string | null;
  close: boolean;
}

export interface LadderPaint {
  hover: { row: number; cell: 'bid' | 'ask' } | null;
  press: { row: number; cell: 'bid' | 'ask' } | null;
  drag: { key: string; row: number } | null;
  volume: 'session' | 'recent' | 'off';
}

export interface LadderCells {
  el: HTMLDivElement;
  pnl: HTMLElement;
  pnlText: Text;
  psBid: HTMLElement;
  psBidText: Text;
  sold: Text;
  bidOrders: Text;
  askOrders: Text;
  lastSize: HTMLElement;
  lastSizeText: Text;
  bought: Text;
  psAsk: HTMLElement;
  psAskText: Text;
  bidBar: HTMLElement;
  /** Setting `textContent` replaces the text node on every write. */
  bidSize: Text;
  bidTags: HTMLElement;
  price: Text;
  askBar: HTMLElement;
  askSize: Text;
  askTags: HTMLElement;
  volBar: HTMLElement;
  volA: Text;
  volB: Text;
  last: Record<string, string | number>;
  low: number;
}

function span(cls: string, parent: HTMLElement, tag = 'span'): HTMLElement {
  const el = parent.ownerDocument.createElement(tag);
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function textSpan(cls: string, parent: HTMLElement): Text {
  const t = parent.ownerDocument.createTextNode('');
  span(cls, parent).appendChild(t);
  return t;
}

const CLOSE_WORD: Record<LadderTag['role'], string> = {
  position: 'Flatten',
  entry: 'Cancel',
  stop: 'Cancel stop',
  target: 'Cancel target',
};

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function tagHtml(t: LadderTag, closable: boolean, ghost: boolean): string {
  const cls = [
    'tag',
    `is-${t.role}`,
    `is-${t.state}`,
    ghost ? 'is-ghost' : '',
    t.account ? 'is-elsewhere' : '',
    t.role === 'position' ? (t.side === 'buy' ? 'is-long' : 'is-short') : '',
  ]
    .filter(Boolean)
    .join(' ');
  const x =
    closable && t.state !== 'draft' && !t.account
      ? `<button type="button" class="x" tabindex="-1" aria-label="${CLOSE_WORD[t.role]}">×</button>`
      : '';
  const ahead = t.ahead !== undefined && t.ahead !== null ? `<span class="ah">${sizeWords(t.ahead) || '0'}</span>` : '';
  const who = t.account ? `${escapeAttr(t.account.name)} · ` : '';
  const title = escapeAttr(t.account ? `Trade on ${t.account.name}` : tagTitle(t));
  return `<span class="${cls}" data-tag="${escapeAttr(t.key)}" title="${title}" aria-label="${title}"><span class="q">${who}${tagWords(t)}</span>${ahead}${x}</span>`;
}

function signed(v: number): string {
  if (v === 0) return '';
  const s = sizeWords(Math.abs(v)) || String(Math.abs(Math.round(v * 100) / 100));
  return v > 0 ? `+${s}` : `−${s}`;
}

export const BAR_STEPS = 64;
const barSheets = new WeakSet<Document>();

function ensureBarSteps(doc: Document): void {
  if (barSheets.has(doc)) return;
  barSheets.add(doc);
  let css = '';
  for (let i = 1; i <= BAR_STEPS; i++)
    css += `.t-ladder .bar.w${String(i)}{transform:scaleX(${String(i / BAR_STEPS)})}`;
  const el = doc.createElement('style');
  el.dataset.ladderBars = '';
  el.textContent = css;
  doc.head.appendChild(el);
}

export function ladderRow(doc: Document): LadderCells {
  const el = doc.createElement('div');
  el.className = 'r';
  const pnl = span('c pnl', el);
  const pnlText = textSpan('f', pnl);
  const psBid = span('c ps ps-bid', el);
  const psBidText = textSpan('f', psBid);
  const sold = textSpan('f', span('c tr sold', el));
  const bid = span('c bid', el);
  const bidBar = span('bar', bid, 'i');
  span('ice', bid, 'i');
  const bidTags = span('tags', bid);
  const bidOrders = textSpan('ord', bid);
  const bidSize = textSpan('sz', bid);
  const p = span('c p', el);
  const price = textSpan('px', p);
  const lastSize = span('ls', p);
  const lastSizeText = doc.createTextNode('');
  lastSize.appendChild(lastSizeText);
  const ask = span('c ask', el);
  const askBar = span('bar', ask, 'i');
  span('ice', ask, 'i');
  const askSize = textSpan('sz', ask);
  const askOrders = textSpan('ord', ask);
  const askTags = span('tags', ask);
  const bought = textSpan('f', span('c tr bought', el));
  const psAsk = span('c ps ps-ask', el);
  const psAskText = textSpan('f', psAsk);
  const vol = span('c vol', el);
  const volBar = span('bar', vol, 'i');
  const v = span('v', vol);
  const volA = textSpan('a', v);
  const volB = textSpan('b', v);
  return {
    el,
    pnl,
    pnlText,
    psBid,
    psBidText,
    sold,
    bidOrders,
    askOrders,
    lastSize,
    lastSizeText,
    bought,
    psAsk,
    psAskText,
    bidBar,
    bidSize,
    bidTags,
    price,
    askBar,
    askSize,
    askTags,
    volBar,
    volA,
    volB,
    last: {},
    low: NaN,
  };
}

export class LadderView {
  private readonly pool: LadderCells[] = [];
  private count = 0;
  closable = true;

  constructor(
    readonly root: HTMLDivElement,
    readonly frame: HTMLElement,
  ) {
    ensureBarSteps(root.ownerDocument);
  }

  setCount(n: number): void {
    if (n === this.count && this.pool.length >= n) return;
    while (this.pool.length < n) this.pool.push(this.makeRow());
    for (let i = 0; i < this.pool.length; i++) {
      const show = i < n;
      const el = this.pool[i]!.el;
      if (show && !el.isConnected) this.root.appendChild(el);
      if (!show && el.isConnected) el.remove();
    }
    this.count = n;
  }

  private makeRow(): LadderCells {
    return ladderRow(this.root.ownerDocument);
  }

  private follow(rows: readonly LadderRow[], n: number): void {
    let same = true;
    for (let i = 0; i < n; i++)
      if (this.pool[i]!.low !== rows[i]!.low) {
        same = false;
        break;
      }
    if (same) return;
    const byLow = new Map<number, LadderCells>();
    for (let i = 0; i < n; i++) {
      const c = this.pool[i]!;
      if (Number.isFinite(c.low)) byLow.set(c.low, c);
    }
    const next: (LadderCells | undefined)[] = new Array<LadderCells | undefined>(n);
    const kept = new Set<LadderCells>();
    for (let i = 0; i < n; i++) {
      const c = byLow.get(rows[i]!.low);
      if (c && !kept.has(c)) {
        next[i] = c;
        kept.add(c);
      }
    }
    const free = this.pool.slice(0, n).filter((c) => !kept.has(c));
    const unplaced = new Set<Node>(free.map((c) => c.el));
    let f = 0;
    for (let i = 0; i < n; i++) next[i] ??= free[f++]!;
    let cur: ChildNode | null = this.root.firstChild;
    for (let i = 0; i < n; i++) {
      const c = next[i]!;
      while (cur && cur !== c.el && unplaced.has(cur)) cur = cur.nextSibling;
      if (cur === c.el) cur = cur.nextSibling;
      else this.root.insertBefore(c.el, cur);
      unplaced.delete(c.el);
      c.low = rows[i]!.low;
      this.pool[i] = c;
    }
  }

  render(rows: readonly LadderRow[], paint: LadderPaint, tagsDragged: ReadonlyMap<string, LadderTag> | null): void {
    const n = Math.min(rows.length, this.count);
    this.follow(rows, n);
    for (let i = n; i < this.pool.length; i++) {
      const c = this.pool[i]!;
      if (c.el.isConnected) c.el.remove();
      c.low = NaN;
    }
    for (let i = 0; i < n; i++) {
      const r = rows[i]!;
      const c = this.pool[i]!;
      const hover = paint.hover?.row === i ? paint.hover.cell : null;
      const press = paint.press?.row === i ? paint.press.cell : null;
      const bits =
        (r.bestBid ? 1 : 0) |
        (r.bestAsk ? 2 : 0) |
        (r.last ? 4 : 0) |
        (r.average ? 8 : 0) |
        (r.round ? 16 : 0) |
        (r.poc ? 32 : 0) |
        (r.bidWall ? 64 : 0) |
        (r.askWall ? 128 : 0) |
        (hover === 'bid' ? 256 : hover === 'ask' ? 512 : 0) |
        (press === 'bid' ? 1024 : press === 'ask' ? 2048 : 0) |
        (r.bidRefills > 0 ? 4096 : 0) |
        (r.askRefills > 0 ? 8192 : 0);
      if (c.last.bits !== bits) {
        c.last.bits = bits;
        let cls = 'r';
        if (r.bestBid) cls += ' is-bb';
        if (r.bestAsk) cls += ' is-ba';
        if (r.last) cls += ' is-last';
        if (r.average) cls += ' is-avg';
        if (r.round) cls += ' is-round';
        if (r.poc) cls += ' is-poc';
        if (r.bidWall) cls += ' is-bwall';
        if (r.askWall) cls += ' is-awall';
        if (hover) cls += ` is-hover-${hover}`;
        if (press) cls += ` is-press-${press}`;
        if (r.bidRefills > 0) cls += ' is-ice-b';
        if (r.askRefills > 0) cls += ' is-ice-a';
        c.el.className = cls;
      }
      this.optional(c, r);
      this.text(c, 'price', c.price, r.price);
      this.size(c, 'bid', c.bidSize, r.bid);
      this.size(c, 'ask', c.askSize, r.ask);
      this.scale(c, 'bidBar', c.bidBar, r.bidBar);
      this.scale(c, 'askBar', c.askBar, r.askBar);
      if (paint.volume === 'off') {
        this.size(c, 'va', c.volA, 0);
        this.size(c, 'vb', c.volB, 0);
        this.scale(c, 'volBar', c.volBar, 0);
      } else if (paint.volume === 'recent') {
        this.size(c, 'va', c.volA, r.buy);
        this.size(c, 'vb', c.volB, r.sell);
        this.scale(c, 'volBar', c.volBar, r.volBar);
      } else {
        this.size(c, 'va', c.volA, r.volume);
        this.size(c, 'vb', c.volB, 0);
        this.scale(c, 'volBar', c.volBar, r.volBar);
      }
      this.tags(c, 'bidTags', c.bidTags, r.bidTags, paint.drag, i, tagsDragged);
      this.tags(c, 'askTags', c.askTags, r.askTags, paint.drag, i, tagsDragged);
    }
  }

  private optional(c: LadderCells, r: LadderRow): void {
    const pnl = r.pnl === null ? '' : r.pnl === 0 ? '0' : signed(r.pnl);
    if (c.last.pnl !== pnl) {
      c.last.pnl = pnl;
      c.pnlText.data = pnl;
      c.pnl.className = `c pnl${r.pnl !== null && r.pnl > 0 ? ' up' : r.pnl !== null && r.pnl < 0 ? ' down' : ''}`;
    }
    this.change(c, 'psb', c.psBid, c.psBidText, 'c ps ps-bid', r.bidChange);
    this.change(c, 'psa', c.psAsk, c.psAskText, 'c ps ps-ask', r.askChange);
    this.size(c, 'sold', c.sold, r.sold);
    this.size(c, 'bought', c.bought, r.bought);
    this.text(c, 'bo', c.bidOrders, r.bidOrders > 0 ? String(r.bidOrders) : '');
    this.text(c, 'ao', c.askOrders, r.askOrders > 0 ? String(r.askOrders) : '');
    const ls = r.lastSize > 0 ? sizeWords(r.lastSize) : '';
    const lsKey = `${ls}|${String(r.lastSide)}`;
    if (c.last.ls !== lsKey) {
      c.last.ls = lsKey;
      c.lastSizeText.data = ls;
      c.lastSize.className = r.lastSide > 0 ? 'ls up' : r.lastSide < 0 ? 'ls down' : 'ls';
    }
  }

  private change(c: LadderCells, key: string, el: HTMLElement, t: Text, base: string, v: number): void {
    const n = Math.round(v * 100) / 100;
    if (c.last[key] === n) return;
    c.last[key] = n;
    t.data = signed(n);
    el.className = n > 0 ? `${base} add` : n < 0 ? `${base} pull` : base;
  }

  private set(c: LadderCells, key: string, value: string | number, write: () => void): void {
    if (c.last[key] === value) return;
    c.last[key] = value;
    write();
  }

  private text(c: LadderCells, key: string, t: Text, s: string): void {
    if (c.last[key] === s) return;
    c.last[key] = s;
    t.data = s;
  }

  private size(c: LadderCells, key: string, t: Text, v: number): void {
    const n = v > 0 ? v : 0;
    if (c.last[key] === n) return;
    c.last[key] = n;
    t.data = sizeWords(n);
  }

  private scale(c: LadderCells, key: string, el: HTMLElement, v: number): void {
    const q = Math.round(Math.max(0, Math.min(1, v)) * BAR_STEPS);
    if (c.last[key] === q) return;
    c.last[key] = q;
    el.className = q > 0 ? `bar w${String(q)}` : 'bar';
  }

  private tags(
    c: LadderCells,
    key: string,
    el: HTMLElement,
    tags: readonly LadderTag[],
    drag: LadderPaint['drag'],
    row: number,
    dragged: ReadonlyMap<string, LadderTag> | null,
  ): void {
    if (tags.length === 0 && !drag && c.last[key] === '') return;
    const side = key === 'bidTags' ? 'buy' : 'sell';
    const ghost = drag?.row === row ? dragged?.get(drag.key) : undefined;
    const list = tags.map((t) => tagHtml(t, this.closable, false));
    if (ghost?.side === side) list.push(tagHtml(ghost, false, true));
    const html = list.join('');
    const dim = drag ? drag.key : '';
    this.set(c, key, html + dim, () => {
      el.innerHTML = html;
      if (dim)
        for (const t of el.querySelectorAll<HTMLElement>(`[data-tag="${CSS.escape(dim)}"]:not(.is-ghost)`))
          t.classList.add('is-moving');
    });
  }

  hit(clientX: number, clientY: number, target: EventTarget | null): LadderHit | null {
    const box = this.root.getBoundingClientRect();
    if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return null;
    const first = this.pool[0]?.el;
    const h = first?.isConnected ? first.getBoundingClientRect().height : 0;
    if (!(h > 0)) return null;
    const row = Math.floor((clientY - box.top) / h);
    if (row < 0 || row >= this.count) return null;
    const t = target instanceof Element ? target : null;
    const tagEl = t?.closest<HTMLElement>('[data-tag]') ?? null;
    const cellEl = t?.closest<HTMLElement>('.c') ?? this.cellAt(row, clientX);
    const has = (c: string) => cellEl?.classList.contains(c) === true;
    const cell: LadderCell = has('bid')
      ? 'bid'
      : has('ask')
        ? 'ask'
        : has('vol')
          ? 'vol'
          : has('pnl')
            ? 'pnl'
            : has('ps-bid')
              ? 'psBid'
              : has('ps-ask')
                ? 'psAsk'
                : has('sold')
                  ? 'sold'
                  : has('bought')
                    ? 'bought'
                    : 'price';
    return { row, cell, tag: tagEl?.dataset.tag ?? null, close: !!t?.closest('.x') };
  }

  private cellAt(row: number, clientX: number): HTMLElement | null {
    const el = this.pool[row]?.el;
    if (!el) return null;
    for (const c of el.children) {
      const r = c.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right) return c as HTMLElement;
    }
    return null;
  }
}
