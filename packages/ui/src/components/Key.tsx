import { createContext, useContext, useEffect, type HTMLAttributes } from 'react';
import { cx } from '../cx.ts';
import { detectPlatform, formatShortcut, type Platform } from '../shortcut.ts';

const PlatformContext = createContext<Platform>(detectPlatform());

export const PlatformProvider = PlatformContext.Provider;

export function usePlatform(): Platform {
  return useContext(PlatformContext);
}

export interface KeyProps extends HTMLAttributes<HTMLElement> {
  shortcut: string;
  held?: boolean;
}

export function Key({ shortcut, held, className, ...rest }: KeyProps) {
  return (
    <kbd
      className={cx(
        't-key font-sans text-meta leading-none font-em normal-nums whitespace-nowrap tracking-[0] text-t3-raised in-[.show-keys]:text-t3',
        held && 'hidden in-[.show-keys]:inline',
        className,
      )}
      {...rest}
    >
      {formatShortcut(shortcut, usePlatform())}
    </kbd>
  );
}

export const SHOW_KEYS_MS = 400;

export function useShowKeysOnHold(platform: Platform = detectPlatform(), root?: HTMLElement): void {
  useEffect(() => {
    const el = root ?? document.documentElement;
    const mod = platform === 'mac' ? 'Meta' : 'Control';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hide = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      el.classList.remove('show-keys');
    };
    const down = (e: KeyboardEvent) => {
      if (e.key !== mod) {
        hide();
        return;
      }
      if (e.repeat || timer !== null) return;
      timer = setTimeout(() => el.classList.add('show-keys'), SHOW_KEYS_MS);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === mod) hide();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', hide);
    };
  }, [platform, root]);
}
