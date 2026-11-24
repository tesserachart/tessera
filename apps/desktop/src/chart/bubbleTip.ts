import { bigTradeCard, type BigTradeCard, type BigTradeMarker } from '@tessera/chart';
import { formatPrice } from '@tessera/ui';
import { displayZone } from '../state/timeZone.ts';

const BUBBLE_TIP_CARDS = 3;

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

function cardNode(card: BigTradeCard): HTMLElement {
  const head = node('div', 'bt-card-head');
  const dot = node('span', 'bt-card-dot');
  dot.dataset.side = card.side > 0 ? 'buy' : 'sell';
  head.append(dot, node('span', 'bt-card-title', 'Big trade'), node('span', 'bt-card-side', card.sideWords));
  const rows = node('dl', 'bt-card-rows');
  for (const [k, v] of card.rows) rows.append(node('dt', '', k), node('dd', '', v));
  const el = node('section', 'bt-card');
  el.append(head, rows);
  return el;
}

export function fillBubbleTip(el: HTMLElement, cards: readonly BigTradeCard[]): void {
  const more = cards.length - BUBBLE_TIP_CARDS;
  el.replaceChildren(
    ...cards.slice(0, BUBBLE_TIP_CARDS).map(cardNode),
    ...(more > 0 ? [node('div', 'bt-card-more', `${String(more)} more here`)] : []),
  );
}
