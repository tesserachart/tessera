import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen as onTauriEvent } from '@tauri-apps/api/event';
import { availableMonitors, getCurrentWindow, type Window } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { assertExternalUrl, host, type Bridge, type UpdateEvent, type UpdateFound } from './bridge.ts';
import { base64ToBytes, bytesToBase64, tileWindowSearch, toBytes, type WindowBounds } from './types.ts';

interface TauriRuntimeConnection {
  port: number;
  token: string;
}

interface TauriPickedFile {
  name: string;
  path: string;
  dataBase64: string;
}

/** Window labels may contain only `a-zA-Z0-9-/:_`. */
function windowLabel(id: string): string {
  return `tile-${id.replace(/[^a-zA-Z0-9\-/:_]/g, '_')}`;
}

export { isTauri };

export function hasTrafficLights(label: string, userAgent: string): boolean {
  return label === 'main' && /Macintosh|Mac OS X/.test(userAgent);
}

interface Appearance {
  readonly mode: 'dark' | 'light' | null;
  readonly background: string;
}

let appearance: Appearance | null = null;

export function makeTauriBridge(): Bridge {
  const w = getCurrentWindow();
  return {
    kind: 'tauri',
    window: {
      trafficLights: hasTrafficLights(w.label, typeof navigator === 'undefined' ? '' : navigator.userAgent),
      minimize: () => host('minimize', () => w.minimize()),
      toggleMaximize: () => host('toggleMaximize', () => w.toggleMaximize()),
      toggleFullscreen: () => host('toggleFullscreen', async () => w.setFullscreen(!(await w.isFullscreen()))),
      close: () => host('close', () => w.close()),
      startDragging: () => host('startDragging', () => w.startDragging()),
      isMaximized: () => host('isMaximized', () => w.isMaximized()),
      onResized: (listener) => listen(w.onResized(() => listener())),
      focus: () =>
        host('focus', async () => {
          await w.unminimize();
          await w.setFocus();
        }),
      setAppearance: (mode, background) =>
        host('setAppearance', async () => {
          appearance = { mode, background };
          await w.setTheme(mode);
          await w.setBackgroundColor(background);
        }),
    },

    updates: {
      check: () => host('update_check', () => invoke<UpdateFound | null>('update_check')),
      download: () => host('update_download', () => invoke<undefined>('update_download')),
      installAndRestart: () => host('update_install', () => invoke<undefined>('update_install')),
      onEvent: (listener) => listen(onTauriEvent<UpdateEvent>('tessera://update', (event) => listener(event.payload))),
    },

    runtimeConnection: async () => {
      const info = await host('runtime_connection', () => invoke<TauriRuntimeConnection>('runtime_connection'));
      return { wsUrl: `ws://127.0.0.1:${String(info.port)}/ws`, credential: { token: info.token }, source: 'tauri' };
    },

    openWindow: async (tile) => {
      const label = windowLabel(tile.id);
      const existing = await host('openWindow', () => WebviewWindow.getByLabel(label));
      if (existing) {
        await host('openWindow', () => existing.setFocus());
        return true;
      }
      const win = new WebviewWindow(label, {
        url: `index.html${tileWindowSearch(tile)}`,
        title: tile.title,
        width: tile.width ?? 640,
        height: tile.height ?? 900,
        ...(tile.x !== undefined && tile.y !== undefined ? { x: tile.x, y: tile.y } : {}),
        decorations: false,
        // Tauri's file-drop handler would take the page's own drag and drop.
        dragDropEnabled: false,
        ...(appearance?.mode ? { theme: appearance.mode } : {}),
        ...(appearance ? { backgroundColor: appearance.background } : {}),
      });
      await host(
        'openWindow',
        () =>
          new Promise<void>((resolve, reject) => {
            void win.once('tauri://created', () => {
              resolve();
            });
            void win.once('tauri://error', (e) => {
              reject(new Error(`could not open window ${label}: ${JSON.stringify(e.payload)}`));
            });
          }),
      );
      return true;
    },

    onWindowClosed: (id, listener) => {
      let stopped = false;
      let off: (() => void) | null = null;
      void WebviewWindow.getByLabel(windowLabel(id))
        .then((win) => {
          if (!win || stopped) return;
          return win.once('tauri://destroyed', () => {
            if (!stopped) listener();
          });
        })
        .then(
          (unlisten) => {
            if (!unlisten) return;
            if (stopped) unlisten();
            else off = unlisten;
          },
          () => undefined,
        );
      return () => {
        stopped = true;
        off?.();
      };
    },

    windowBounds: async (id) => {
      try {
        const win = await WebviewWindow.getByLabel(windowLabel(id));
        return win ? await logicalBounds(win) : null;
      } catch {
        return null;
      }
    },

    thisWindowBounds: async () => {
      try {
        return await logicalBounds(w);
      } catch {
        return null;
      }
    },

    closeWindow: async (id) => {
      const win = await host('closeWindow', () => WebviewWindow.getByLabel(windowLabel(id)));
      if (win) await host('closeWindow', () => win.close());
    },

    screens: async () => {
      try {
        const monitors = await availableMonitors();
        return monitors.map((m) => {
          const f = m.scaleFactor > 0 ? m.scaleFactor : 1;
          return {
            name: m.name ?? `${String(m.position.x)},${String(m.position.y)}`,
            x: Math.round(m.position.x / f),
            y: Math.round(m.position.y / f),
            width: Math.round(m.size.width / f),
            height: Math.round(m.size.height / f),
          };
        });
      } catch {
        return null;
      }
    },

    notify: (options) =>
      host('notify', () => invoke<boolean>('notify', { title: options.title, body: options.body ?? null })),

    openExternal: async (url) => {
      const parsed = assertExternalUrl(url);
      await host('open_external', () => invoke('open_external', { url: parsed.toString() }));
    },

    saveFile: (options) =>
      host('save_file', () =>
        invoke<boolean>('save_file', {
          suggestedName: options.suggestedName,
          dataBase64: bytesToBase64(toBytes(options.data)),
          filters: options.filters ?? [],
        }),
      ),

    pickFile: async (options = {}) => {
      const files = await host('pick_files', () =>
        invoke<TauriPickedFile[]>('pick_files', {
          multiple: options.multiple ?? false,
          filters: options.filters ?? [],
        }),
      );
      return files.map((f) => ({ name: f.name, path: f.path, data: base64ToBytes(f.dataBase64) }));
    },

    setWindowTitle: (title) => host('setWindowTitle', () => getCurrentWindow().setTitle(title)),

    guardClose: (mayClose) =>
      listen(
        w.onCloseRequested(async (event) => {
          event.preventDefault();
          const leave = await mayClose().catch(() => true);
          if (leave) await invoke('quit').catch(() => w.destroy());
        }),
      ),
  };
}

async function logicalBounds(win: Pick<Window, 'outerPosition' | 'outerSize' | 'scaleFactor'>): Promise<WindowBounds> {
  const [pos, size, scale] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
  const f = scale > 0 ? scale : 1;
  return {
    x: Math.round(pos.x / f),
    y: Math.round(pos.y / f),
    width: Math.round(size.width / f),
    height: Math.round(size.height / f),
  };
}

function listen(registered: Promise<() => void>): () => void {
  let stopped = false;
  let off: (() => void) | null = null;
  registered.then(
    (unlisten) => {
      if (stopped) unlisten();
      else off = unlisten;
    },
    (error: unknown) => {
      console.warn('[bridge] could not listen', error);
    },
  );
  return () => {
    stopped = true;
    off?.();
  };
}
