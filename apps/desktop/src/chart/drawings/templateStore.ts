import type { DrawingTemplate } from '@tessera/protocol';
import { patch, makeStore, useStore } from '../../app/store.ts';
import { readDrawingTemplates } from './templates.ts';

export interface DrawingTemplatesState {
  templates: DrawingTemplate[];
}

export const drawingTemplatesStore = makeStore<DrawingTemplatesState>({ templates: [] });

export function useDrawingTemplates<T>(selector: (s: DrawingTemplatesState) => T): T {
  return useStore(drawingTemplatesStore, selector);
}

export function putDrawingTemplates(value: unknown): void {
  patch(drawingTemplatesStore, { templates: readDrawingTemplates(value) });
}
