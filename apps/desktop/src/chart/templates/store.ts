import type { ChartTemplates } from '@tessera/protocol';
import { patch, makeStore, read, useStore } from '../../app/store.ts';
import type { ChartRef } from '../settings/store.ts';
import { readTemplates } from './model.ts';

export interface TemplatesState extends ChartTemplates {
  loaded: boolean;
  followed: Readonly<Record<string, string>>;
  menuFor: string | null;
}

export const templatesStore = makeStore<TemplatesState>({ templates: [], loaded: false, followed: {}, menuFor: null });

export function useTemplates<T>(selector: (s: TemplatesState) => T): T {
  return useStore(templatesStore, selector);
}

export function putTemplates(value: unknown): void {
  const t = readTemplates(value);
  patch(templatesStore, { templates: t.templates, defaultId: t.defaultId, loaded: true });
}

export function chartKey(chart: ChartRef): string {
  return `${chart.layoutId}/${chart.tileId}`;
}

export function followTemplate(chart: ChartRef, templateId: string): void {
  const key = chartKey(chart);
  const followed = read(templatesStore).followed;
  if (followed[key] === templateId) return;
  patch(templatesStore, { followed: { ...followed, [key]: templateId } });
}

export function openTemplateMenu(chart: ChartRef): void {
  patch(templatesStore, { menuFor: chartKey(chart) });
}

export function clearTemplateMenuRequest(): void {
  patch(templatesStore, { menuFor: null });
}
