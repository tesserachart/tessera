import type { Bridge, NotifyOptions, ScreenArea, TileSpec, WindowBounds, WindowControls } from '@tessera/bridge';
import { appHost, servicesStore } from './services.ts';
import { derived, useStore, type Readable } from './store.ts';

const hostStore: Readable<Bridge | null> = derived(servicesStore, (services) => services?.host ?? null);

export function useHostKind(): Bridge['kind'] {
  return useStore(hostStore, (host) => host?.kind ?? 'browser');
}

export function useWindowControls(): WindowControls | null {
  return useStore(hostStore, (host) => host?.window ?? null);
}

export function runControl(control: () => Promise<unknown>): void {
  control().catch((error: unknown) => {
    console.warn('[host] window control failed', error);
  });
}

export function openExternal(url: string): Promise<void> {
  return appHost().openExternal(url);
}

export function notify(options: NotifyOptions): Promise<boolean> {
  return appHost().notify(options);
}

export function setWindowTitle(title: string): Promise<void> {
  return appHost().setWindowTitle(title);
}

export function openTileWindow(tile: TileSpec): Promise<boolean> {
  return appHost().openWindow(tile);
}

export function tileWindowBounds(id: string): Promise<WindowBounds | null> {
  return appHost().windowBounds(id);
}

export function thisWindowBounds(): Promise<WindowBounds | null> {
  return appHost().thisWindowBounds();
}

export function closeTileWindow(id: string): Promise<void> {
  return appHost().closeWindow(id);
}

export function hostScreens(): Promise<ScreenArea[] | null> {
  return appHost().screens();
}

export function canFullscreen(): boolean {
  return appHost().window !== null;
}

export function toggleFullscreen(): void {
  const controls = appHost().window;
  if (controls) runControl(controls.toggleFullscreen);
}

export function closeThisWindow(): void {
  const controls = appHost().window;
  if (controls) runControl(controls.close);
  else window.close();
}

export function onTileWindowClosed(id: string, onClose: () => void): () => void {
  return appHost().onWindowClosed(id, onClose);
}
