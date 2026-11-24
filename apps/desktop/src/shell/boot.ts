import { SPLASH_SEAM } from '@tessera/ui';
import { useLayoutEffect } from 'react';

const BOOT_ID = 'boot';

let introStart: number | null = null;
export function introElapsed(): number {
  if (introStart === null) {
    // a finished animation's currentTime stops at its end
    const anim = document.querySelector(`#${BOOT_ID} .seam.loop`)?.getAnimations()[0];
    const at = typeof anim?.currentTime === 'number' ? anim.currentTime : 0;
    introStart = performance.now() - at;
  }
  return performance.now() - introStart;
}

export function introPlayed(): boolean {
  return document.documentElement.dataset.intro === 'played';
}

export function useDropBoot(): void {
  useLayoutEffect(() => {
    document.getElementById(BOOT_ID)?.remove();
  }, []);
}

export interface SeamCut {
  left: string;
  right: string;
  origin: string;
  edge: string;
}

export function seamCut(
  box: { left: number; top: number; width: number; height: number },
  windowHeight: number,
): SeamCut {
  const x1 = box.left + SPLASH_SEAM.topX * box.width;
  const x2 = box.left + SPLASH_SEAM.botX * box.width;
  const y = box.top + SPLASH_SEAM.jogY * box.height;
  const px = (n: number) => `${n.toFixed(1)}px`;
  const [top, bot, jog] = [px(x1), px(x2), px(y)];
  const mid = px((x1 + x2) / 2);
  const n = (v: number) => v.toFixed(1);
  return {
    edge: `${n(x1)},0 ${n(x1)},${n(y)} ${n(x2)},${n(y)} ${n(x2)},${n(windowHeight)}`,
    left: `polygon(0 0, ${top} 0, ${top} ${jog}, ${bot} ${jog}, ${bot} 100%, 0 100%)`,
    right: `polygon(${top} 0, 100% 0, 100% 100%, ${bot} 100%, ${bot} ${jog}, ${top} ${jog})`,
    origin: `${mid} ${jog}`,
  };
}
