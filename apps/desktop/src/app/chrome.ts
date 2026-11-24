import type { UiState } from '../state/ui.ts';

export function applyChrome(
  s: Pick<UiState, 'density'> & Partial<Pick<UiState, 'reducedMotion'>>,
  el: HTMLElement = document.documentElement,
): void {
  if (s.density === 'default') delete el.dataset.density;
  else el.dataset.density = s.density;
  if (s.reducedMotion) el.dataset.motion = 'reduced';
  else delete el.dataset.motion;
}
