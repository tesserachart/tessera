import { z } from 'zod';
import { makeStore, patch, read, useStore } from '../../app/store.ts';

export const DEFAULT_CODE_SHARE = 0.55;
export const CODE_MIN_PX = 320;
export const PREVIEW_MIN_PX = 280;
const SHARE_FLOOR = 0.2;
const SHARE_CEILING = 0.85;

interface EditorLayout {
  codeShare: number;
  codeOnly: boolean;
}

export const editorLayout = makeStore<EditorLayout>(
  { codeShare: DEFAULT_CODE_SHARE, codeOnly: false },
  {
    persist: {
      key: 'tessera.indicators.editor',
      version: 1,
      fields: { codeShare: z.number().min(SHARE_FLOOR).max(SHARE_CEILING) },
    },
  },
);

export function useEditorLayout<T>(pick: (s: EditorLayout) => T): T {
  return useStore(editorLayout, pick);
}

export function fitShare(share: number, widthPx: number): number {
  const low = widthPx > 0 ? Math.max(SHARE_FLOOR, CODE_MIN_PX / widthPx) : SHARE_FLOOR;
  const high = widthPx > 0 ? Math.min(SHARE_CEILING, 1 - PREVIEW_MIN_PX / widthPx) : SHARE_CEILING;
  if (low > high) return DEFAULT_CODE_SHARE;
  return Math.min(high, Math.max(low, share));
}

export function setCodeShare(share: number, widthPx: number): void {
  patch(editorLayout, { codeShare: fitShare(share, widthPx) });
}

export function resetCodeShare(): void {
  patch(editorLayout, { codeShare: DEFAULT_CODE_SHARE });
}

export function toggleCodeOnly(): void {
  patch(editorLayout, { codeOnly: !read(editorLayout).codeOnly });
}
