import { type Drawing, type DrawingKind } from '@tessera/protocol';
import type { ChartRef } from '../settings/store.ts';
import { editDrawing } from './actions.ts';
import { setNewLook } from './store.ts';
import { putDrawingTemplates, drawingTemplatesStore } from './templateStore.ts';
import { labelInput, lookOfDrawing, newDrawingEntry, withLook, type DrawingLook } from './templates.ts';
import { read } from '../../app/store.ts';
import { failureText, runTool, toolCode, toolReason } from '../../app/tools.ts';
import { answerFor } from '../../state/runtimeSettings.ts';

export function reason(err: unknown): string {
  if (toolCode(err) === null) return failureText(err);
  const why = toolReason(err);
  return why.charAt(0).toUpperCase() + why.slice(1);
}

export async function saveDrawingTemplate(d: Drawing, name: string) {
  const look = lookOfDrawing(d);
  const out = await runTool('chart.save_drawing_template', {
    name,
    kind: d.kind,
    style: look.style,
    ...(look.label ? { label: labelInput(d.kind, look.label) } : {}),
    ...(look.levels ? { levels: look.levels } : {}),
  });
  const all = read(drawingTemplatesStore).templates;
  const templates = all.some((t) => t.id === out.template.id)
    ? all.map((t) => (t.id === out.template.id ? out.template : t))
    : [...all, out.template];
  putDrawingTemplates({ templates });
  return out;
}

export async function renameDrawingTemplate(id: string, name: string): Promise<void> {
  const fresh = answerFor('chart.drawingTemplates');
  const out = await runTool('chart.rename_drawing_template', { template: id, name });
  if (fresh()) putDrawingTemplates(out);
}

export async function deleteDrawingTemplate(id: string): Promise<void> {
  const fresh = answerFor('chart.drawingTemplates');
  const out = await runTool('chart.delete_drawing_template', { template: id });
  if (fresh()) putDrawingTemplates(out);
}

export function applyLook(ref: ChartRef, id: string, look: DrawingLook): void {
  editDrawing(ref, id, (d) => withLook(d, look));
}

export function setNewDrawingsLook(kind: DrawingKind, look: DrawingLook | null): void {
  setNewLook(kind, look ? newDrawingEntry(look) : null);
}
