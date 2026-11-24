import type { ChartType } from '@tessera/protocol';
import { applyChartResult } from '../../state/layouts.ts';
import { layoutSaved } from '../../workspace/controller.ts';
import type { ChartRef } from '../settings/store.ts';
import { applyOrderFlow } from './builtin.ts';
import { ORDER_FLOW } from './model.ts';
import { followTemplate, putTemplates, templatesStore } from './store.ts';
import { read } from '../../app/store.ts';
import { runTool } from '../../app/tools.ts';
import { answerFor } from '../../state/runtimeSettings.ts';

function target(chart: ChartRef): ChartRef {
  return { layoutId: chart.layoutId, tileId: chart.tileId };
}

export async function saveTemplate(chart: ChartRef, name: string, chartType: ChartType) {
  await layoutSaved();
  const out = await runTool('chart.save_template', { ...target(chart), name, chartType });
  const s = read(templatesStore);
  const templates = s.templates.some((t) => t.id === out.template.id)
    ? s.templates.map((t) => (t.id === out.template.id ? out.template : t))
    : [...s.templates, out.template];
  putTemplates({ templates, ...(out.defaultId ? { defaultId: out.defaultId } : {}) });
  followTemplate(chart, out.template.id);
  return out;
}

export async function applyTemplate(chart: ChartRef, templateId: string): Promise<void> {
  if (templateId === ORDER_FLOW.id) {
    await applyOrderFlow(chart);
  } else {
    await layoutSaved();
    const out = await runTool('chart.apply_template', { ...target(chart), template: templateId });
    applyChartResult(out.layoutId, out.revision, out.chart);
  }
  followTemplate(chart, templateId);
}

export async function renameTemplate(templateId: string, name: string): Promise<void> {
  const fresh = answerFor('chart.templates');
  const out = await runTool('chart.edit_template', { template: templateId, name });
  if (fresh()) putTemplates(out);
}

export async function setDefaultTemplate(templateId: string, on: boolean): Promise<void> {
  const fresh = answerFor('chart.templates');
  const out = await runTool('chart.edit_template', { template: templateId, default: on });
  if (fresh()) putTemplates(out);
}

export async function deleteTemplate(templateId: string): Promise<void> {
  const fresh = answerFor('chart.templates');
  const out = await runTool('chart.delete_template', { template: templateId });
  if (fresh()) putTemplates(out);
}
