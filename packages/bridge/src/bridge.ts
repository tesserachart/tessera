import type {
  NotifyOptions,
  PickedFile,
  PickFileOptions,
  RuntimeConnection,
  SaveFileOptions,
  ScreenArea,
  TileSpec,
  WindowBounds,
} from './types.ts';
import type { BrowserBridgeOptions } from './browser.ts';

export class RuntimeUnavailable extends Error {
  readonly _tag = 'RuntimeUnavailable';
  readonly problem: 'runtime_starting' | 'runtime_failed' | 'data_dir_locked';
  constructor(args: { problem: RuntimeUnavailable['problem']; message: string }) {
    super(args.message);
    this.name = 'RuntimeUnavailable';
    this.problem = args.problem;
  }
}

export class RuntimeNotFound extends Error {
  readonly _tag = 'RuntimeNotFound';
  constructor(args: { message: string }) {
    super(args.message);
    this.name = 'RuntimeNotFound';
  }
}

export class UnsafeUrl extends Error {
  readonly _tag = 'UnsafeUrl';
  readonly url: string;
  constructor(args: { url: string }) {
    super(`refusing to open ${args.url}: only http, https and mailto URLs are allowed`);
    this.name = 'UnsafeUrl';
    this.url = args.url;
  }
}

export class HostError extends Error {
  readonly _tag = 'HostError';
  readonly operation: string;
  readonly reason: unknown;
  constructor(args: { operation: string; reason: unknown }) {
    super(`${args.operation}: ${args.reason instanceof Error ? args.reason.message : String(args.reason)}`);
    this.name = 'HostError';
    this.operation = args.operation;
    this.reason = args.reason;
  }
}

export type RuntimeConnectionError = RuntimeUnavailable | RuntimeNotFound | HostError;

export interface WindowControls {
  /** With `titleBarStyle: Overlay`, macOS draws the traffic lights over the window's top-left corner. */
  readonly trafficLights: boolean;
  readonly minimize: () => Promise<void>;
  readonly toggleMaximize: () => Promise<void>;
  readonly toggleFullscreen: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly startDragging: () => Promise<void>;
  readonly isMaximized: () => Promise<boolean>;
  readonly onResized: (listener: () => void) => () => void;
  readonly focus: () => Promise<void>;
  readonly setAppearance: (mode: 'dark' | 'light' | null, background: string) => Promise<void>;
}

export interface UpdateFound {
  readonly version: string;
  readonly notes: string | null;
}

export type UpdateEvent =
  | {
      readonly kind: 'downloading';
      readonly version: string;
      readonly downloaded: number;
      readonly total: number | null;
    }
  | { readonly kind: 'check' };

export interface HostUpdates {
  readonly check: () => Promise<UpdateFound | null>;
  readonly download: () => Promise<void>;
  readonly installAndRestart: () => Promise<void>;
  readonly onEvent: (listener: (event: UpdateEvent) => void) => () => void;
}

export interface Bridge {
  readonly kind: 'tauri' | 'browser';
  readonly runtimeConnection: () => Promise<RuntimeConnection>;
  readonly openWindow: (tile: TileSpec) => Promise<boolean>;
  readonly onWindowClosed: (id: string, listener: () => void) => () => void;
  readonly windowBounds: (id: string) => Promise<WindowBounds | null>;
  readonly thisWindowBounds: () => Promise<WindowBounds | null>;
  readonly closeWindow: (id: string) => Promise<void>;
  readonly screens: () => Promise<ScreenArea[] | null>;
  readonly notify: (options: NotifyOptions) => Promise<boolean>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly saveFile: (options: SaveFileOptions) => Promise<boolean>;
  readonly pickFile: (options?: PickFileOptions) => Promise<PickedFile[]>;
  readonly setWindowTitle: (title: string) => Promise<void>;
  readonly guardClose: (mayClose: () => Promise<boolean>) => () => void;
  readonly window: WindowControls | null;
  readonly updates: HostUpdates | null;
}

/** Tauri ≥ 2 sets `isTauri` on the global object. */
export function runningInTauri(): boolean {
  return Boolean((globalThis as { isTauri?: unknown }).isTauri);
}

export async function makeBridge(browser?: BrowserBridgeOptions): Promise<Bridge> {
  if (runningInTauri()) return (await import('./tauri.ts')).makeTauriBridge();
  return (await import('./browser.ts')).makeBrowserBridge(browser);
}

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function assertExternalUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrl({ url });
  }
  if (!SAFE_SCHEMES.has(parsed.protocol)) throw new UnsafeUrl({ url });
  return parsed;
}

export async function host<A>(operation: string, f: () => Promise<A>): Promise<A> {
  try {
    return await f();
  } catch (reason) {
    throw new HostError({ operation, reason });
  }
}
