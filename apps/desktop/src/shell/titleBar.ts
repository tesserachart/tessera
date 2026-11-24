import { useWindowControls } from '../app/host.ts';

export type WindowChrome = 'custom' | 'mac' | 'none';

export function useWindowChrome(): WindowChrome {
  const controls = useWindowControls();
  if (!controls) return 'none';
  return controls.trafficLights ? 'mac' : 'custom';
}

/**
 * Tauri's `drag.js` (tauri 2.12) drags only on a press on the bare attribute's own element, never its children, and
 * maximises on a double-click (on the release on macOS); a double-click handler of the page's own would undo it.
 */
const DRAG_REGION = 'data-tauri-drag-region';

export function setDragRegion(el: Element, on: boolean): void {
  if (on === el.hasAttribute(DRAG_REGION)) return;
  if (on) el.setAttribute(DRAG_REGION, '');
  else el.removeAttribute(DRAG_REGION);
}
