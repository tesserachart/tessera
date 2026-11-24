import { toCreateInput, toUpdateInput, type AlertForm } from './form.ts';
import { runToolResult } from '../app/tools.ts';

async function run(go: () => Promise<{ ok: boolean; error?: { message: string } | null }>): Promise<string | null> {
  try {
    const r = await go();
    return r.ok ? null : (r.error?.message ?? 'It did not go through');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function saveAlert(form: AlertForm, nowMs: number): Promise<string | null> {
  if (form.id === null) {
    const input = toCreateInput(form, nowMs);
    if ('error' in input) return Promise.resolve(input.error);
    return run(() => runToolResult('alerts.create', input.ok));
  }
  const input = toUpdateInput(form, nowMs);
  if ('error' in input) return Promise.resolve(input.error);
  return run(() => runToolResult('alerts.update', input.ok));
}

export function pauseAlert(id: string, paused: boolean): Promise<string | null> {
  return run(() => runToolResult('alerts.pause', { id, paused }));
}

export function deleteAlert(id: string): Promise<string | null> {
  return run(() => runToolResult('alerts.delete', { id }));
}

export function moveAlert(id: string, price: number): Promise<string | null> {
  return run(() => runToolResult('alerts.update', { id, price }));
}
