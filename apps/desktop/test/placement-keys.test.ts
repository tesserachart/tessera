import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginPlacement, placeKey, type PlaceBase, type Placement } from '../src/chart/placement.ts';
import { onPlacementKey, placementTakesKey } from '../src/chart/placementRun.ts';
import { startPlacement, endPlacement, placementStore } from '../src/state/placement.ts';
import { read } from '../src/app/store.ts';

const base = (over: Partial<PlaceBase> = {}): PlaceBase => ({
  accountId: 'paper-main',
  environment: 'paper',
  instrument: 'NQZ6.CME',
  symbol: 'NQ Z6',
  side: 'buy',
  qty: 2,
  kind: 'limit',
  tick: 0.25,
  decimals: 2,
  mode: 'qty',
  risk: 250,
  tickValue: 5,
  stopTicks: null,
  targetTicks: null,
  ...over,
});

const waiting = (over: Partial<PlaceBase> = {}): Placement => ({
  ...beginPlacement(base(over), 20640),
  stage: 'stop',
});

describe('⏎ while placing', () => {
  it('sends an entry waiting for its stop without one by contracts, never by risk', () => {
    expect(placeKey(waiting(), 'Enter')).toMatchObject({ kind: 'send', input: { qty: 2, limitPrice: 20640 } });
    const risk = beginPlacement(base({ mode: 'risk', qty: 4 }), 20640);
    expect(risk.stage).toBe('stop');
    expect(placeKey(risk, 'Enter')).toBeNull();
    expect(placeKey(risk, 'Escape')).toEqual({ kind: 'end', next: null });
  });
});

describe('whose ⏎ and Esc it is', () => {
  const run = vi.fn();
  const onKey = (e: KeyboardEvent) => void onPlacementKey(e, run);
  const el = (html: string): HTMLElement => {
    const box = document.createElement('div');
    box.innerHTML = html;
    document.body.append(box);
    return box.querySelector('[data-t]') ?? box;
  };
  const press = (target: EventTarget, key: string) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };

  beforeEach(() => {
    run.mockReset();
    startPlacement(waiting());
    window.addEventListener('keydown', onKey, true);
  });
  afterEach(() => {
    window.removeEventListener('keydown', onKey, true);
    endPlacement();
    document.body.innerHTML = '';
  });

  it('a focused menu item keeps its ⏎: nothing is sent and the item hears it', () => {
    const item = el('<div role="menu"><div role="menuitem" tabindex="-1" data-t>Stop at 20,630.00</div></div>');
    const heard = vi.fn();
    item.addEventListener('keydown', heard);
    const e = press(item, 'Enter');
    expect(run).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
    expect(read(placementStore).placing).not.toBeNull();
  });

  it('a focused button (an Approve card’s) keeps its ⏎', () => {
    const approve = el('<section><button type="button" data-t>Approve</button></section>');
    press(approve, 'Enter');
    expect(run).not.toHaveBeenCalled();
    expect(placementTakesKey(approve, 'Enter')).toBe(false);
    expect(placementTakesKey(approve, 'Escape')).toBe(true);
  });

  it('on the chart, the DOM ladder or the page, ⏎ and Esc are the placement’s', () => {
    const ladder = el('<div class="tile dom-tile" tabindex="0" data-t></div>');
    const e = press(ladder, 'Enter');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ kind: 'send' });
    expect(e.defaultPrevented).toBe(true);
    press(document.body, 'Escape');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toEqual({ kind: 'end', next: null });
  });

  it('an open menu or popover keeps Esc, wherever the focus is', () => {
    const item = el('<div role="menu"><div role="menuitem" tabindex="-1" data-t>Stop at 20,630.00</div></div>');
    press(item, 'Escape');
    expect(run).not.toHaveBeenCalled();
    expect(placementTakesKey(document.body, 'Escape')).toBe(false);
    document.body.innerHTML = '';
    el('<div data-radix-popper-content-wrapper><div role="dialog" data-t>Indicator</div></div>');
    expect(placementTakesKey(document.body, 'Escape')).toBe(false);
    document.body.innerHTML = '';
    el('<div data-radix-popper-content-wrapper><div data-t>Buy<span role="tooltip">Buy</span></div></div>');
    expect(placementTakesKey(document.body, 'Escape')).toBe(true);
  });

  it('a field keeps ⏎, a search field keeps Esc too, a dialog keeps both', () => {
    expect(placementTakesKey(el('<input data-t />'), 'Enter')).toBe(false);
    expect(placementTakesKey(el('<input data-t />'), 'Escape')).toBe(true);
    expect(placementTakesKey(el('<input role="combobox" data-t />'), 'Escape')).toBe(false);
    const inDialog = el('<div role="dialog"><p tabindex="0" data-t>Settings</p></div>');
    expect(placementTakesKey(inDialog, 'Enter')).toBe(false);
    expect(placementTakesKey(inDialog, 'Escape')).toBe(false);
    expect(placementTakesKey(document.body, 'a')).toBe(false);
  });
});
