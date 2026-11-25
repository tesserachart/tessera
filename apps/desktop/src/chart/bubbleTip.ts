import { bigTradeCard, type BigTradeCard, type BigTradeMarker, type ChartCoords } from '@tessera/chart';
import { formatPrice } from '@tessera/ui';
import { displayZone } from '../state/timeZone.ts';

const BUBBLE_TIP_CARDS = 3;
const KEEP_TOGETHER = /\s/g;
const NO_BREAK_SPACE = '\u00a0';
const SEGMENT_JOIN = `${NO_BREAK_SPACE}· `;

export function bubbleTipCards(markers: readonly BigTradeMarker[], precision: number): BigTradeCard[] {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: displayZone(),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return markers.map((m) =>
    bigTradeCard(
      m.trade,
      (p) => formatPrice(p, precision),
      (ms) => clock.format(ms),
    ),
  );
}

function node(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function cardLine(segments: readonly string[]): string {
  return segments.map((s) => s.replace(KEEP_TOGETHER, NO_BREAK_SPACE)).join(SEGMENT_JOIN);
}

function cardNode(card: BigTradeCard): HTMLElement {
  const head = node('div', 'bt-card-head');
  const dot = node('span', 'bt-card-dot');
  dot.dataset.side = card.side > 0 ? 'buy' : 'sell';
  head.append(dot, node('span', 'bt-card-headline', cardLine(card.headline)));
  const el = node('section', 'bt-card');
  el.append(head, node('div', 'bt-card-detail', cardLine(card.detail)));
  return el;
}

export function fillBubbleTip(el: HTMLElement, cards: readonly BigTradeCard[]): void {
  const more = cards.length - BUBBLE_TIP_CARDS;
  el.replaceChildren(
    ...cards.slice(0, BUBBLE_TIP_CARDS).map(cardNode),
    ...(more > 0 ? [node('div', 'bt-card-more', `${String(more)} more here`)] : []),
  );
}

export interface TipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TipBubble {
  x: number;
  y: number;
  r: number;
}

export interface TipSize {
  w: number;
  h: number;
}

function inside(area: TipRect, x: number, y: number, size: TipSize): boolean {
  return x >= area.x && y >= area.y && x + size.w <= area.x + area.w && y + size.h <= area.y + area.h;
}

function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(Math.max(lo, hi), v));
}

export function tipCoversBubble(at: { x: number; y: number }, size: TipSize, b: TipBubble): boolean {
  const dx = b.x - clamp(at.x, at.x + size.w, b.x);
  const dy = b.y - clamp(at.y, at.y + size.h, b.y);
  return Math.hypot(dx, dy) < b.r;
}

export function placeBubbleTip(
  b: TipBubble,
  size: TipSize,
  areas: readonly TipRect[],
  gap: number,
): { x: number; y: number } {
  const candidatesIn = (area: TipRect) => {
    const right = Math.max(area.x, b.x + b.r + gap);
    const left = Math.min(area.x + area.w - size.w, b.x - b.r - gap - size.w);
    const above = Math.min(area.y + area.h - size.h, b.y - b.r - size.h);
    const below = Math.max(area.y, b.y + b.r);
    const level = clamp(area.y, area.y + area.h - size.h, b.y - size.h / 2);
    const across = clamp(area.x, area.x + area.w - size.w, b.x - size.w / 2);
    return [
      { x: right, y: above },
      { x: left, y: above },
      { x: right, y: below },
      { x: left, y: below },
      { x: right, y: level },
      { x: left, y: level },
      { x: across, y: Math.min(area.y + area.h - size.h, above - gap) },
      { x: across, y: Math.max(area.y, below + gap) },
    ];
  };
  for (const area of areas) {
    const fit = candidatesIn(area).find((c) => inside(area, c.x, c.y, size) && !tipCoversBubble(c, size, b));
    if (fit) return fit;
  }
  const area = areas.at(-1) ?? { x: 0, y: 0, w: size.w, h: size.h };
  return {
    x: clamp(area.x, area.x + area.w - size.w, b.x + b.r + gap),
    y: clamp(area.y, area.y + area.h - size.h, b.y - b.r - size.h),
  };
}

function shrunk(r: TipRect, by: number): TipRect {
  return { x: r.x + by, y: r.y + by, w: Math.max(0, r.w - 2 * by), h: Math.max(0, r.h - 2 * by) };
}

export function bubbleTipAreas(c: Pick<ChartCoords, 'plot' | 'priceAxis' | 'timeAxis'>, inset: number): TipRect[] {
  const panes = { x: c.plot.x, y: c.plot.y, w: c.priceAxis.x - c.plot.x, h: c.timeAxis.y - c.plot.y };
  return [shrunk(c.plot, inset), shrunk(panes, inset)];
}
