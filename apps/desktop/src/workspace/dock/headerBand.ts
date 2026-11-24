import type { DockviewApi } from 'dockview-react';
import { setDragRegion } from '../../shell/titleBar.ts';

export interface BandRow {
  top: number;
  left: number;
  right: number;
  vertical: boolean;
}

export interface BandPlace {
  inBand: boolean;
  end: number;
  stripUnder: boolean;
}

const EPS = 1;

export function placeInBand(dock: { top: number; right: number }, row: BandRow, reserve: number): BandPlace {
  const inBand = Math.abs(row.top - dock.top) <= EPS;
  const from = dock.right - reserve;
  const under = inBand && reserve > 0 && row.right > from + EPS;
  if (!under) return { inBand, end: 0, stripUnder: false };
  if (row.vertical) return { inBand, end: 0, stripUnder: true };
  return { inBand, end: Math.round(Math.min(row.right - row.left, row.right - from)), stripUnder: false };
}

function reserveOf(root: HTMLElement): number {
  const v = parseFloat(getComputedStyle(root).getPropertyValue('--wc-w'));
  return Number.isFinite(v) ? v : 0;
}

export function markBand(root: HTMLElement, reserve = reserveOf(root)): void {
  const dock = root.getBoundingClientRect();
  const under = new Set<Element>();
  for (const row of root.querySelectorAll<HTMLElement>('.dv-tabs-and-actions-container')) {
    const floating = row.closest('.dv-resize-container') !== null;
    const vertical = row.classList.contains('dv-groupview-header-vertical');
    const strip = vertical ? row.closest<HTMLElement>('.dv-groupview') : null;
    const r = (strip ?? row).getBoundingClientRect();
    const place =
      floating || r.width < 1
        ? { inBand: false, end: 0, stripUnder: false }
        : placeInBand(dock, { top: r.top, left: r.left, right: r.right, vertical }, reserve);
    row.toggleAttribute('data-band', place.inBand);
    row.toggleAttribute('data-band-end', place.end > 0);
    if (place.end > 0) row.style.setProperty('--band-end', `${String(place.end)}px`);
    else row.style.removeProperty('--band-end');
    if (strip && place.stripUnder) under.add(strip);
    const empty = row.querySelector(':scope > .dv-void-container');
    if (empty) setDragRegion(empty, place.inBand && !vertical);
  }
  for (const el of root.querySelectorAll('[data-band-under]'))
    if (!under.has(el)) el.removeAttribute('data-band-under');
  for (const el of under) el.setAttribute('data-band-under', '');
}

export function installHeaderBand(api: DockviewApi, root: HTMLElement): () => void {
  let frame = 0;
  const observed = new Set<Element>();
  const sizes = new ResizeObserver(() => schedule());
  const pass = () => {
    frame = 0;
    const now = new Set<Element>(root.querySelectorAll('.dv-tabs-and-actions-container'));
    for (const el of observed) {
      if (!now.has(el)) {
        sizes.unobserve(el);
        observed.delete(el);
      }
    }
    for (const el of now) {
      if (!observed.has(el)) {
        sizes.observe(el);
        observed.add(el);
      }
    }
    markBand(root);
  };
  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(pass);
  }
  sizes.observe(root);
  const subs = [
    api.onDidLayoutChange(schedule),
    api.onDidLayoutFromJSON(schedule),
    api.onDidAddGroup(schedule),
    api.onDidRemoveGroup(schedule),
    api.onDidMovePanel(schedule),
  ];
  schedule();
  return () => {
    if (frame) cancelAnimationFrame(frame);
    sizes.disconnect();
    for (const s of subs) s.dispose();
  };
}
