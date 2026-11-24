export function motionAllowed(): boolean {
  return document.documentElement.dataset.motion === 'full';
}
