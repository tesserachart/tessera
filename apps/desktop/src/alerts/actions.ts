import { toCreateInput, toUpdateInput, type AlertForm } from './form.ts';
import { attempt, type Attempt } from '../app/tools.ts';

async function said(sent: Promise<Attempt<unknown>>): Promise<string | null> {
  const r = await sent;
  return r.ok ? null : r.why;
}

export function saveAlert(form: AlertForm, nowMs: number): Promise<string | null> {
  if (form.id === null) {
    const input = toCreateInput(form, nowMs);
    if ('error' in input) return Promise.resolve(input.error);
    return said(attempt('alerts.create', input.ok));
  }
  const input = toUpdateInput(form, nowMs);
  if ('error' in input) return Promise.resolve(input.error);
  return said(attempt('alerts.update', input.ok));
}

export function pauseAlert(id: string, paused: boolean): Promise<string | null> {
  return said(attempt('alerts.pause', { id, paused }));
}

export function deleteAlert(id: string): Promise<string | null> {
  return said(attempt('alerts.delete', { id }));
}

export function moveAlert(id: string, price: number): Promise<string | null> {
  return said(attempt('alerts.update', { id, price }));
}
