import { usePlatform } from '@tessera/ui';
import { useEffect } from 'react';
import { keyOverlayKey } from '../shell/keyOverlay.ts';
import { isTextInput, zoneOf, type CommandRegistry } from './registry.ts';

export function useKeybindings(registry: CommandRegistry, enabled = true): void {
  const platform = usePlatform();
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (keyOverlayKey(e, registry)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const target = e.target instanceof Element ? e.target : document.activeElement;
      const id = registry.handleKey(e, zoneOf(target), platform, isTextInput(target));
      if (id) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [registry, platform, enabled]);
}
