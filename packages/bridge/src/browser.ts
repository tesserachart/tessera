import { assertExternalUrl, host, RuntimeNotFound, RuntimeUnavailable, type Bridge } from './bridge.ts';
import { pageSession, SESSION_CHANNEL } from './session.ts';
import {
  tileWindowSearch,
  toBytes,
  type FileFilter,
  type PickedFile,
  type RuntimeConnection,
  type RuntimeUnavailableProblem,
} from './types.ts';

export interface DevRuntimeInfo {
  port: number;
  url?: string;
}

export interface BrowserBridgeOptions {
  discovery?: 'auto' | 'dev' | 'served';
  runtimeJsonPath?: string;
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  localStorage?: Pick<Storage, 'removeItem'> | null;
  channel?: Pick<BroadcastChannel, 'postMessage' | 'addEventListener'> | null;
  fetch?: typeof fetch;
  location?: Pick<Location, 'protocol' | 'host' | 'href' | 'reload'>;
  history?: Pick<History, 'replaceState' | 'state'>;
  document?: Document;
  window?: Window & typeof globalThis;
}

export type DevRuntimeState = 'starting' | 'failed' | 'data_dir_locked';

const DEV_STATES: Record<string, RuntimeUnavailableProblem> = {
  starting: 'runtime_starting',
  failed: 'runtime_failed',
  data_dir_locked: 'data_dir_locked',
} satisfies Record<DevRuntimeState, RuntimeUnavailableProblem>;

function devRuntimeInfo(body: unknown): DevRuntimeInfo | null {
  if (!isRecord(body) || typeof body.port !== 'number') return null;
  if (body.url !== undefined && typeof body.url !== 'string') return null;
  return body.url === undefined ? { port: body.port } : { port: body.port, url: body.url };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const jsonBody = (res: Response): Promise<unknown> => res.json().catch(() => null);

const isJson = (res: Response) => (res.headers.get('content-type') ?? '').includes('json');

export function makeBrowserBridge(options: BrowserBridgeOptions = {}): Bridge {
  const win = options.window ?? window;
  const fetchFn = options.fetch ?? win.fetch.bind(win);
  const loc = options.location ?? win.location;
  const doc = options.document ?? win.document;
  const discovery = options.discovery ?? 'auto';
  const runtimeJsonPath = options.runtimeJsonPath ?? '/runtime.json';
  const popups = new Map<string, Window>();
  const session = pageSession({
    location: loc,
    history: options.history ?? win.history,
    sessionStorage: options.sessionStorage === undefined ? storage(() => win.sessionStorage) : options.sessionStorage,
    localStorage: options.localStorage === undefined ? storage(() => win.localStorage) : options.localStorage,
    channel: options.channel === undefined ? defaultChannel(win) : options.channel,
    events: win,
  });

  const sameOriginWsUrl = () => `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;

  const readDevRuntimeInfo = async (): Promise<DevRuntimeInfo | null> => {
    let res: Response;
    try {
      res = await fetchFn(runtimeJsonPath, { cache: 'no-store', credentials: 'omit' });
    } catch {
      return null;
    }
    if (!isJson(res)) return null;
    if (res.ok) return devRuntimeInfo(await jsonBody(res));
    const body = await jsonBody(res);
    const state = isRecord(body) ? body.state : undefined;
    const message = isRecord(body) ? body.message : undefined;
    const problem = typeof state === 'string' ? DEV_STATES[state] : undefined;
    if (res.status === 503 && problem && typeof message === 'string' && message) {
      throw new RuntimeUnavailable({ problem, message });
    }
    return null;
  };

  const endpoint = async (): Promise<Pick<RuntimeConnection, 'wsUrl' | 'source'>> => {
    if (discovery === 'served') return { wsUrl: sameOriginWsUrl(), source: 'served' };
    const info = await readDevRuntimeInfo();
    if (info) return { wsUrl: info.url ?? `ws://127.0.0.1:${String(info.port)}/ws`, source: 'dev' };
    if (discovery === 'dev') {
      throw new RuntimeNotFound({ message: `${runtimeJsonPath} is unavailable: is the runtime running?` });
    }
    return { wsUrl: sameOriginWsUrl(), source: 'served' };
  };

  const runtimeConnection = async (): Promise<RuntimeConnection> => {
    const at = await endpoint();
    return { ...at, credential: await session.credential(), session };
  };

  const bridge: Bridge = {
    kind: 'browser',
    window: null,
    updates: null,
    runtimeConnection,

    openWindow: (tile) =>
      settled(() => {
        const open = popups.get(tile.id);
        if (open && !open.closed) {
          open.focus();
          return true;
        }
        const url = new URL(loc.href);
        url.search = tileWindowSearch(tile);
        url.hash = '';
        const place =
          tile.x !== undefined && tile.y !== undefined ? `,left=${String(tile.x)},top=${String(tile.y)}` : '';
        const features = `popup,width=${String(tile.width ?? 640)},height=${String(tile.height ?? 900)}${place}`;
        const w = win.open(url.toString(), `tessera-${tile.id}`, features);
        if (!w) return false;
        popups.set(tile.id, w);
        w.focus();
        return true;
      }),

    // A browser tells the opener nothing when a popup closes.
    onWindowClosed: (id, listener) => {
      const timer = setInterval(() => {
        const w = popups.get(id);
        if (!w) {
          clearInterval(timer);
          return;
        }
        if (!w.closed) return;
        clearInterval(timer);
        popups.delete(id);
        listener();
      }, 500);
      return () => {
        clearInterval(timer);
      };
    },

    windowBounds: (id) =>
      settled(() => {
        const w = popups.get(id);
        if (!w || w.closed) return null;
        return { x: w.screenX, y: w.screenY, width: w.outerWidth, height: w.outerHeight };
      }),

    thisWindowBounds: () =>
      settled(() => ({ x: win.screenX, y: win.screenY, width: win.outerWidth, height: win.outerHeight })),

    closeWindow: (id) =>
      settled(() => {
        popups.get(id)?.close();
      }),

    // A page sees only the screen it stands on without asking the user for the window-management permission.
    screens: () => Promise.resolve(null),

    notify: async (n) => {
      const N = (win as { Notification?: typeof Notification }).Notification;
      if (!N) return false;
      let permission = N.permission;
      if (permission === 'default') permission = await host('notify', () => N.requestPermission());
      if (permission !== 'granted') return false;
      new N(n.title, n.body === undefined ? {} : { body: n.body });
      return true;
    },

    openExternal: (url) =>
      settled(() => {
        const parsed = assertExternalUrl(url);
        win.open(parsed.toString(), '_blank', 'noopener,noreferrer');
      }),

    saveFile: (file) =>
      settled(() => {
        const bytes = toBytes(file.data);
        const blob = new Blob([bytes as BlobPart], { type: file.mimeType ?? 'application/octet-stream' });
        const href = URL.createObjectURL(blob);
        const a = doc.createElement('a');
        a.href = href;
        a.download = file.suggestedName;
        a.rel = 'noopener';
        a.style.display = 'none';
        doc.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => {
          URL.revokeObjectURL(href);
        }, 30_000);
        return true;
      }),

    pickFile: (pick = {}) =>
      new Promise<PickedFile[]>((resolve, reject) => {
        const input = doc.createElement('input');
        input.type = 'file';
        input.multiple = pick.multiple ?? false;
        const accept = acceptAttribute(pick.filters);
        if (accept) input.accept = accept;
        input.style.display = 'none';
        input.addEventListener('cancel', () => {
          input.remove();
          resolve([]);
        });
        input.addEventListener('change', () => {
          const list = Array.from(input.files ?? []);
          host('pickFile', () =>
            Promise.all(list.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))),
          ).then(
            (files) => {
              input.remove();
              resolve(files);
            },
            (error: unknown) => {
              input.remove();
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        });
        doc.body.appendChild(input);
        input.click();
      }),

    setWindowTitle: (title) =>
      settled(() => {
        doc.title = title;
      }),

    guardClose: () => () => undefined,
  };
  return bridge;
}

function settled<A>(f: () => A): Promise<A> {
  try {
    return Promise.resolve(f());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function acceptAttribute(filters: FileFilter[] | undefined): string {
  if (!filters?.length) return '';
  return filters.flatMap((f) => f.extensions.map((e) => `.${e.replace(/^\./, '')}`)).join(',');
}

/** Reading a window's storage throws in opaque origins and where storage is disabled. */
function storage(get: () => Storage): Storage | null {
  try {
    return get();
  } catch {
    return null;
  }
}

function defaultChannel(win: Window & typeof globalThis): BroadcastChannel | null {
  const Channel = (win as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  return Channel ? new Channel(SESSION_CHANNEL) : null;
}
