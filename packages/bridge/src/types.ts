export type RuntimeCredential = { readonly token: string } | { readonly ticket: string };

export type RuntimeSessionProblem = 'session_expired' | 'session_missing';

export interface RuntimeSessionListener {
  readonly kept: (keep: { readonly reloadTicket: string; readonly token?: string | undefined }) => void;
  readonly refused: (problem: RuntimeSessionProblem) => void;
}

export interface RuntimeConnection {
  wsUrl: string;
  credential: RuntimeCredential | null;
  session?: RuntimeSessionListener | undefined;
  source: 'tauri' | 'dev' | 'served';
}

export type RuntimeUnavailableProblem = 'runtime_starting' | 'runtime_failed' | 'data_dir_locked';

export interface TileSpec {
  kind: string;
  id: string;
  title: string;
  params?: Record<string, unknown>;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenArea extends WindowBounds {
  name: string;
}

export interface NotifyOptions {
  title: string;
  body?: string;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface SaveFileOptions {
  suggestedName: string;
  data: Uint8Array | string;
  mimeType?: string;
  filters?: FileFilter[];
}

export interface PickFileOptions {
  multiple?: boolean;
  filters?: FileFilter[];
}

export interface PickedFile {
  name: string;
  data: Uint8Array;
  path?: string;
}

export const WINDOW_PARAM = 'window';
export const WINDOW_TILE_PARAM = 'tile';

export function tileWindowSearch(tile: TileSpec): string {
  const params = new URLSearchParams();
  params.set(WINDOW_PARAM, tile.id);
  params.set(
    WINDOW_TILE_PARAM,
    JSON.stringify({ kind: tile.kind, id: tile.id, title: tile.title, params: tile.params ?? {} }),
  );
  return `?${params.toString()}`;
}

export function parseTileWindowSearch(search: string): Omit<TileSpec, 'width' | 'height'> | null {
  const params = new URLSearchParams(search);
  const raw = params.get(WINDOW_TILE_PARAM);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TileSpec>;
    if (typeof v.kind !== 'string' || typeof v.id !== 'string') return null;
    return { kind: v.kind, id: v.id, title: typeof v.title === 'string' ? v.title : v.kind, params: v.params ?? {} };
  } catch {
    return null;
  }
}

export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
