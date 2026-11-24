import { useEffect, useRef } from 'react';
import { attachLeg, submitOrder, type ActionResult } from '../shell/tradeActions.ts';
import { placementStore, updatePlacement } from '../state/placement.ts';
import type { Bracket } from './brackets.ts';
import { placeKey, placementHost, type Placement, type PlaceStep } from './placement.ts';
import { read } from '../app/store.ts';

export async function runPlaceStep(
  p: Placement,
  step: PlaceStep,
  brackets: readonly Bracket[],
  report: (r: ActionResult) => void,
): Promise<void> {
  const seq = read(placementStore).seq;
  if (step.kind === 'error' || step.kind === 'next' || step.kind === 'end') {
    updatePlacement(seq, step.next);
    return;
  }
  if (step.kind === 'send') {
    updatePlacement(seq, step.next);
    const r = await submitOrder(p.environment, step.input, step.what, p.decimals);
    if (r.tone !== 'ok' || !r.order || r.order.status === 'rejected') {
      report(r.tone === 'ok' ? { ...r, tone: 'err' } : r);
      updatePlacement(seq, null);
      return;
    }
    report(r);
    updatePlacement(seq, null);
    return;
  }
  const at = placementHost(p, brackets);
  if (!at) {
    report({ tone: 'err', text: `${step.what}: the entry is no longer working. Nothing sent.`, what: step.what });
    updatePlacement(seq, null);
    return;
  }
  updatePlacement(seq, step.next);
  const r = await attachLeg(p.environment, at.host, step.role, step.price, step.what, p.decimals, p.qty);
  report(r);
  if (r.tone !== 'ok') {
    updatePlacement(seq, null);
    return;
  }
  const orderId = at.host.kind === 'entry' && r.order ? r.order.id : p.orderId;
  if (step.next) updatePlacement(seq, { ...step.next, busy: false, orderId });
}

const OWNS_ENTER = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="listbox"]',
  '[role="grid"]',
  '[role="tree"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
].join(', ');
const OVERLAY =
  '[role="menu"], [role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], [role="combobox"]';
/** Radix mounts menus and popovers only while they are open. */
const OPEN_OVERLAY = '[role="menu"], [data-radix-popper-content-wrapper] [role="dialog"]';

export function placementTakesKey(target: EventTarget | null, key: string): boolean {
  if (key !== 'Enter' && key !== 'Escape') return false;
  const el = target instanceof Element ? target : null;
  const doc = el?.ownerDocument ?? (typeof document === 'undefined' ? null : document);
  if (el?.closest(OVERLAY) || doc?.querySelector(OPEN_OVERLAY)) return false;
  return key === 'Escape' || !el?.closest(OWNS_ENTER);
}

export function onPlacementKey(e: KeyboardEvent, run: (p: Placement, step: PlaceStep) => void): boolean {
  const p = read(placementStore).placing;
  if (!p || !placementTakesKey(e.target, e.key)) return false;
  const step = placeKey(p, e.key);
  if (!step) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  run(p, step);
  return true;
}

export function usePlacementKeys(
  active: boolean,
  brackets: readonly Bracket[],
  report: (r: ActionResult) => void,
): void {
  const latest = useRef({ brackets, report });
  useEffect(() => {
    latest.current = { brackets, report };
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) =>
      void onPlacementKey(e, (p, step) => {
        void runPlaceStep(p, step, latest.current.brackets, latest.current.report);
      });
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
}
