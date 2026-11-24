import { detectPlatform, type Platform } from '@tessera/ui';

type Press = Pick<MouseEvent, 'type' | 'button' | 'buttons' | 'ctrlKey'>;

const RIGHT = 2;
const RIGHT_HELD = 2;

const macControlClick = (e: Press, platform: Platform) => platform === 'mac' && e.button === 0 && e.ctrlKey;

export function isSecondaryPress(e: Press, platform: Platform = detectPlatform()): boolean {
  switch (e.type) {
    case 'contextmenu':
      return true;
    case 'pointerdown':
    case 'mousedown':
      return e.button === RIGHT || macControlClick(e, platform);
    case 'pointermove':
      return e.button === RIGHT && (e.buttons & RIGHT_HELD) !== 0;
    default:
      return false;
  }
}

export function isPrimaryPress(e: Press, platform: Platform = detectPlatform()): boolean {
  return e.button === 0 && !macControlClick(e, platform);
}

let disarmMenuEater: (() => void) | null = null;

function eatNextMenu(win: Window): void {
  disarmMenuEater?.();
  const eat = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    disarm();
  };
  const disarm = () => {
    win.removeEventListener('contextmenu', eat, true);
    win.removeEventListener('pointerdown', disarm, true);
    if (disarmMenuEater === disarm) disarmMenuEater = null;
  };
  win.addEventListener('contextmenu', eat, true);
  win.addEventListener('pointerdown', disarm, true);
  disarmMenuEater = disarm;
}

const PRESSES = ['pointerdown', 'pointermove', 'contextmenu'] as const;

export function dropOnSecondaryPress(win: Window, drop: (e: MouseEvent) => boolean): () => void {
  const onPress = (e: MouseEvent) => {
    if (!isSecondaryPress(e) || !drop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== 'contextmenu') eatNextMenu(win);
  };
  for (const type of PRESSES) win.addEventListener(type, onPress, true);
  return () => {
    for (const type of PRESSES) win.removeEventListener(type, onPress, true);
  };
}
